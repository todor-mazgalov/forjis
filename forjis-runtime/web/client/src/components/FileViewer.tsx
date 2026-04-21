/**
 * FileViewer — app-global file-viewer modal.
 *
 * Singleton overlay mounted once at the app shell that subscribes to
 * `currentFile()` from {@link ./fileViewerStore} and renders the active
 * request's content as syntax-highlighted source. Closed via Esc, backdrop
 * click, or the `X` button in the header. See redesign-010 design.md § D-4
 * (resource + listener lifecycle), § D-8 (styling), and § D-9 (mounting).
 *
 * Renders nothing while the store's request is `null`, so placing the
 * component always-on inside the shell is safe — idle cost is a single
 * memoised `null` comparison.
 */

import type { Component, JSX } from 'solid-js';
import {
  Show,
  Switch,
  Match,
  createMemo,
  createResource,
  createEffect,
  onCleanup,
} from 'solid-js';
import type { HighlightLang, TokKind } from '../views/tasks/highlighter';
import { highlight } from '../views/tasks/highlighter';
import type { FileFetchResult } from '../shell/api';
import { getPluginFile, getProjectFile, getTaskFile } from '../shell/api';
import type { FileViewerRequest } from './fileViewerStore';
import { currentFile, closeFile } from './fileViewerStore';
import styles from './FileViewer.module.css';

/**
 * Class map forwarded to {@link highlight} so the rendered HTML uses the
 * CSS-module-scoped token classes instead of the global `tok-*` literals.
 * Mirrors the pattern used by `ToolCallBlock.tsx`.
 */
const TOK_CLASS_MAP: Partial<Record<TokKind, string>> = {
  str: styles.tokStr,
  key: styles.tokKey,
  num: styles.tokNum,
  bool: styles.tokBool,
  null: styles.tokNull,
  cmt: styles.tokCmt,
  punc: styles.tokPunc,
  kw: styles.tokKw,
  fn: styles.tokFn,
  add: styles.tokAdd,
  del: styles.tokDel,
  ctx: styles.tokCtx,
  mdHeading: styles.tokMdHeading,
  mdHeading1: styles.tokMdHeading1,
  mdHeading2: styles.tokMdHeading2,
  mdHeading3: styles.tokMdHeading3,
  mdHeading4: styles.tokMdHeading4,
  mdHeading5: styles.tokMdHeading5,
  mdHeading6: styles.tokMdHeading6,
  mdLink: styles.tokMdLink,
  mdFence: styles.tokMdFence,
  mdCodeBlock: styles.tokMdCodeBlock,
  mdInlineCode: styles.tokMdInlineCode,
  mdStrong: styles.tokMdStrong,
  mdEm: styles.tokMdEm,
  mdListMarker: styles.tokMdListMarker,
  mdQuote: styles.tokMdQuote,
  mdHr: styles.tokMdHr,
};

/** Display text for each {@link FileFetchResult} failure kind (design.md § D-10). */
const ERROR_MESSAGE: Record<'not-allowed' | 'not-found' | 'unavailable', string> = {
  'not-allowed': 'This path is not permitted.',
  'not-found': 'File not found.',
  unavailable: 'Unable to load file.',
};

/**
 * Pick the highlighter language for a given file path based on its
 * extension. Unknown extensions fall through to `'markdown'` because the
 * markdown tokeniser is a safe no-op on arbitrary text (only headings,
 * links, and fences are transformed) and the highlighter's HTML-escape
 * pass still runs. See redesign-010 design.md § D-7.
 *
 * @param path - File path; only the final extension is inspected.
 */
export function pickLang(path: string): HighlightLang {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'markdown';
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'json':
      return 'json';
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'sh':
      return 'bash';
    case 'diff':
    case 'patch':
      return 'diff';
    default:
      return 'markdown';
  }
}

/**
 * Dispatch a fetch for the active request. Returns `null` for a `null`
 * request so Solid's `createResource` emits `null` (which the body branch
 * maps to "nothing to render"). Short-circuits a task-source request whose
 * stored `taskId` is `null` to the generic unavailable failure so no
 * ill-formed URL is constructed.
 */
async function fetchFor(
  req: FileViewerRequest | null,
): Promise<FileFetchResult | null> {
  if (!req) return null;
  if (req.source === 'plugin') {
    return getPluginFile(req.path);
  }
  if (req.source === 'project') {
    return getProjectFile(req.path);
  }
  // source === 'task'
  if (req.taskId === null) {
    return { ok: false, kind: 'unavailable' } as const;
  }
  return getTaskFile(req.taskId, req.path);
}

/** Props for {@link FileViewer}. No props — state flows via the module store. */
export interface FileViewerProps {}

/**
 * Attempt to copy the active path to the clipboard. Rejections (missing
 * permission, execution context without a clipboard API) are swallowed so
 * no uncaught error surfaces on the console.
 */
function copyPathToClipboard(path: string): void {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(path).catch(() => undefined);
  } catch {
    // Clipboard access failed synchronously; ignore per D-11.
  }
}

/** Header row of the modal: path, source badge, copy-path, and close. */
function ModalHeader(props: { req: FileViewerRequest }): JSX.Element {
  return (
    <div class={styles.header}>
      <span class={styles.path}>{props.req.path}</span>
      <span class={styles.sourceBadge}>{props.req.source}</span>
      <button
        type="button"
        class={styles.copyBtn}
        onClick={() => copyPathToClipboard(props.req.path)}
      >
        Copy path
      </button>
      <button
        type="button"
        class={styles.closeBtn}
        aria-label="Close"
        onClick={closeFile}
      >
        ×
      </button>
    </div>
  );
}

/** Body of the modal — dispatches over the resource state to pick a render. */
function ModalBody(props: {
  req: FileViewerRequest;
  result: FileFetchResult | null | undefined;
  loading: boolean;
}): JSX.Element {
  return (
    <div class={styles.body}>
      <Switch>
        <Match when={props.loading}>
          <div class={styles.placeholder}>{'Loading\u2026'}</div>
        </Match>
        <Match when={props.result && props.result.ok === false}>
          <div class={styles.error}>
            {ERROR_MESSAGE[(props.result as { ok: false; kind: keyof typeof ERROR_MESSAGE }).kind]}
          </div>
        </Match>
        <Match when={props.result && props.result.ok === true && (props.result as { ok: true; content: string }).content === ''}>
          <div class={styles.placeholder}>Empty file</div>
        </Match>
        <Match when={props.result && props.result.ok === true}>
          <pre
            class={styles.source}
            innerHTML={highlight(
              (props.result as { ok: true; content: string }).content,
              pickLang(props.req.path),
              TOK_CLASS_MAP,
            )}
          />
        </Match>
      </Switch>
    </div>
  );
}

/**
 * App-global file-viewer modal. See file header for lifecycle and mounting.
 */
export const FileViewer: Component<FileViewerProps> = () => {
  const req = createMemo(() => currentFile());
  const [result] = createResource(req, fetchFor);

  createEffect(() => {
    if (req() === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeFile();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  return (
    <Show when={req()}>
      {(activeReq): JSX.Element => (
        <div
          class={styles.overlay}
          onClick={closeFile}
          role="dialog"
          aria-modal="true"
        >
          <div class={styles.panel} onClick={(event) => event.stopPropagation()}>
            <ModalHeader req={activeReq()} />
            <ModalBody req={activeReq()} result={result()} loading={result.loading} />
          </div>
        </div>
      )}
    </Show>
  );
};
