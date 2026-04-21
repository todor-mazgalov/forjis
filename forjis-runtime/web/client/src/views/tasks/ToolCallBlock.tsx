/**
 * ToolCallBlock — collapsible body for an assistant tool-call event.
 *
 * Renders a header row with a chevron + tool name + timestamp, and a
 * pretty-printed JSON body below. Bodies longer than
 * {@link EVENTS_PREVIEW_LINES} lines render clipped with a fade gradient and
 * an `Expand` button; bodies at or below that length render in full. Tool-
 * result events whose `parentId` matches this call's pairing key are rendered
 * as nested rows via the injected `renderResult` slot — kept as a prop so this
 * file does not depend back on `EventsTab.tsx`.
 */

import type { Component, JSX } from 'solid-js';
import { For, Show, createSignal } from 'solid-js';
import type { TaskEvent } from '@forjis/shared';
import type { HighlightLang, TokKind } from './highlighter';
import eventStyles from './EventsTab.module.css';
import styles from './ToolCallBlock.module.css';

/** Maximum line count of a collapsed tool-call body. Single source of truth. */
export const EVENTS_PREVIEW_LINES = 200;

/** JSON.stringify indent width used when pretty-printing a payload. */
const PRETTY_PRINT_INDENT = 2;

/**
 * Class map forwarded to {@link highlight} so the rendered HTML uses the
 * CSS-module-scoped colour rules instead of the global `tok-*` literals.
 * Built once at module load — the class names are baked at bundle time.
 */
const TOK_CLASS_MAP: Partial<Record<TokKind, string>> = {
  str: eventStyles.tokStr,
  key: eventStyles.tokKey,
  num: eventStyles.tokNum,
  bool: eventStyles.tokBool,
  null: eventStyles.tokNull,
  cmt: eventStyles.tokCmt,
  punc: eventStyles.tokPunc,
  kw: eventStyles.tokKw,
  fn: eventStyles.tokFn,
  add: eventStyles.tokAdd,
  del: eventStyles.tokDel,
  ctx: eventStyles.tokCtx,
  mdHeading: eventStyles.tokMdHeading,
  mdLink: eventStyles.tokMdLink,
  mdFence: eventStyles.tokMdFence,
};

/** Props for {@link ToolCallBlock}. */
export interface ToolCallBlockProps {
  /** The tool-call event being rendered. `event.toolName` / `event.payload` drive the body. */
  event: TaskEvent;
  /** Result events whose `parentId` matches this tool-call's pairing key. */
  results: TaskEvent[];
  /** Highlighter to call on the JSON payload. Injected so the block stays trivially testable. */
  highlight: (text: string, lang: HighlightLang, classMap?: Partial<Record<TokKind, string>>) => string;
  /**
   * Slot renderer for one nested result row. Provided by the parent (EventsTab)
   * so the same one-line presentation is reused without a circular import. The
   * function returns the JSX for a single result; the wrapping `<For>` lives
   * here so the divider/spacing rules stay localised to this component.
   */
  renderResult: (result: TaskEvent) => JSX.Element;
}

/**
 * Pretty-print any JSON-serialisable payload at the documented indent. Falls
 * back to `String(payload)` when the value is not serialisable (e.g. contains
 * a cycle). Pure helper — colocated so the chevron logic stays small.
 */
function prettyPrintPayload(payload: unknown): string {
  if (payload === undefined) return '';
  try {
    return JSON.stringify(payload, null, PRETTY_PRINT_INDENT);
  } catch {
    return String(payload);
  }
}

/**
 * Format the event's timestamp as `HH:MM:SS` in the user's local time zone.
 * Returns an empty string for an unparseable input so the layout still flows.
 */
function formatTimeOfDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Render the JSON body, optionally clipped to the preview window. The CSS
 * `previewClipped` modifier paints the fade-out gradient when the payload is
 * longer than {@link EVENTS_PREVIEW_LINES} lines and the block is collapsed.
 */
function buildBodyHtml(
  fullJson: string,
  expanded: boolean,
  highlight: ToolCallBlockProps['highlight'],
): { html: string; clipped: boolean } {
  if (!fullJson) return { html: '', clipped: false };
  if (expanded) {
    return { html: highlight(fullJson, 'json', TOK_CLASS_MAP), clipped: false };
  }
  const lines = fullJson.split('\n');
  if (lines.length <= EVENTS_PREVIEW_LINES) {
    return { html: highlight(fullJson, 'json', TOK_CLASS_MAP), clipped: false };
  }
  const clipped = lines.slice(0, EVENTS_PREVIEW_LINES).join('\n');
  return { html: highlight(clipped, 'json', TOK_CLASS_MAP), clipped: true };
}

/** Single collapsible tool-call block. See file header for behaviour. */
export const ToolCallBlock: Component<ToolCallBlockProps> = (props) => {
  const [expanded, setExpanded] = createSignal<boolean>(false);

  const fullJson = (): string => prettyPrintPayload(props.event.payload);
  const lineCount = (): number => fullJson() ? fullJson().split('\n').length : 0;
  const isLong = (): boolean => lineCount() > EVENTS_PREVIEW_LINES;

  const body = (): { html: string; clipped: boolean } =>
    buildBodyHtml(fullJson(), expanded(), props.highlight);

  const previewClass = (): string => {
    const parts = [styles.body, styles.preview];
    if (body().clipped) parts.push(styles.previewClipped);
    return parts.join(' ');
  };

  const toggle = (): void => {
    setExpanded((prev) => !prev);
  };

  return (
    <div class={styles.block}>
      <button type="button" class={styles.header} onClick={toggle} aria-expanded={expanded()}>
        <span class={styles.chevron} data-open={expanded() ? 'true' : 'false'} aria-hidden="true">
          ›
        </span>
        <span class={styles.toolName}>{props.event.toolName ?? 'tool'}</span>
        <span class={styles.timestamp}>{formatTimeOfDay(props.event.timestamp)}</span>
      </button>
      <Show when={fullJson()}>
        <pre class={previewClass()} innerHTML={body().html} />
        <Show when={!expanded() && isLong()}>
          <button type="button" class={styles.expandBtn} onClick={toggle}>
            Expand
          </button>
        </Show>
      </Show>
      <Show when={props.results.length > 0}>
        <div class={styles.results}>
          <For each={props.results}>
            {(result) => props.renderResult(result)}
          </For>
        </div>
      </Show>
    </div>
  );
};
