/**
 * Comment sheet factory.
 *
 * The comment sheet (design.md §D-007, spec FR-009-005, FR-010-016..018)
 * is a drawer hosted inside the overlay's existing shadow root for style
 * isolation. It renders the element screenshot, the viewport screenshot
 * with an annotation canvas layered over it, a comment textarea, and
 * Send / Cancel / "Add another pin" controls. Desktop (>=768 px):
 * right-side drawer (~400 px). Mobile: full-width bottom sheet.
 *
 * Lifecycle: constructed once by the overlay and reused across picks.
 * Each `open(context)` mounts a fresh annotation canvas and swaps in new
 * screenshot object URLs. `hide()` preserves in-memory state (textarea,
 * annotation handle, elementUrl list) so "Add another pin" can re-arm
 * picker mode without losing work. `addPinToGroup(context)` appends a
 * new pin to the in-flight group — it shares the annotation handle and
 * textarea buffer and allocates a fresh `commentGroupId` UUID on the
 * solo→group transition. `close()` destroys the annotation canvas,
 * revokes every collected `elementUrl`, and hides the drawer. `destroy()`
 * removes all DOM.
 */

import type { Annotation, Bbox, Pin, PinTarget } from '@forjis/shared';
import { buildPin } from '../pipeline.js';
import { generateUuid } from '../util/uuid.js';
import {
  createAnnotationCanvas,
  type AnnotationCanvasHandle,
} from './annotation-canvas.js';
import { FORJIS_TOKENS } from './theme.js';

/** Init options accepted by {@link createCommentSheet}. */
export interface InitCommentSheetOptions {
  /** The overlay's open shadow root; the sheet appends itself here. */
  readonly shadow: ShadowRoot;
  /** Called once per pin when the user clicks Send. */
  readonly onSubmit: (pin: Pin) => void;
  /** Called when the user clicks Cancel or the backdrop. */
  readonly onCancel: () => void;
  /**
   * Called when the user taps "Add another pin". The caller is expected
   * to re-arm picker mode; the sheet handles its own `hide()`.
   */
  readonly onAddAnotherPin: () => void;
}

/** Context supplied to {@link CommentSheetHandle.open} / {@link CommentSheetHandle.addPinToGroup}. */
export interface CommentSheetContext {
  /** `PinTarget` emitted by the overlay at pick time. */
  readonly target: PinTarget;
  /** Cropped element/region screenshot Blob. */
  readonly elementBlob: Blob;
  /** Viewport screenshot Blob (used as annotation background). */
  readonly viewportBlob: Blob;
  /** Pin bbox in viewport-pixel coordinates (drawn on the viewport PNG). */
  readonly bbox: Bbox;
  /** Curated computed-styles snapshot taken synchronously at pick time. */
  readonly computedStyles: Record<string, string>;
  /** Screen pathname captured at pick time via the screen tracker. */
  readonly screen: string | null;
  /** Optional pre-allocated commentGroupId (first pick of an ongoing group). */
  readonly commentGroupId?: string | null;
}

/** Handle returned by {@link createCommentSheet}. */
export interface CommentSheetHandle {
  /** The drawer container (mounted inside the supplied shadow root). */
  readonly element: HTMLElement;
  /** Populate the sheet with a new capture bundle and make it visible. */
  open(context: CommentSheetContext): void;
  /** Hide the sheet without destroying in-memory state. */
  hide(): void;
  /** Whether the sheet is currently open (with in-memory state). */
  isOpen(): boolean;
  /**
   * Append a new pin to the in-flight group and re-show the sheet.
   *
   * @param context - Capture context for the new pin.
   */
  addPinToGroup(context: CommentSheetContext): void;
  /** Hide the sheet and tear down per-open state. Idempotent. */
  close(): void;
  /** Remove the sheet from the DOM and release references. */
  destroy(): void;
}

/** Inline CSS for the comment sheet — isolated inside the shadow root. */
const COMMENT_SHEET_STYLE = `
.comment-sheet { position: fixed; inset: 0; pointer-events: none; }
.comment-sheet[data-open="false"] { display: none; }
.comment-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: auto;
}
.comment-sheet-panel {
  position: fixed;
  background: var(--bg-panel);
  color: var(--text);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.5);
  border-left: 1px solid var(--border);
  font: 14px/1.4 var(--font-sans);
  box-sizing: border-box;
  overflow: auto;
}
.comment-sheet-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0;
}
.comment-sheet-panel h2 {
  margin: 0;
  font-size: var(--text-md);
  color: var(--text);
}
.comment-sheet-panel .group-count {
  margin-left: var(--space-3);
  padding: 2px var(--space-3);
  background: var(--accent);
  color: var(--bg-base);
  border-radius: 999px;
  font-size: var(--text-sm);
  font-weight: 600;
}
.comment-sheet-panel .group-count[data-visible="false"] {
  display: none;
}
.comment-sheet-panel button {
  font: inherit;
  cursor: pointer;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--text);
  padding: var(--space-2) var(--space-4);
  min-height: 28px;
}
.comment-sheet-panel button:hover:not(:disabled) { border-color: var(--border-strong); }
.comment-sheet-panel button.primary {
  background: var(--accent);
  color: var(--bg-base);
  border-color: var(--accent);
  font-weight: 600;
}
.comment-sheet-panel button.primary:hover:not(:disabled) {
  background: var(--accent-dim);
  border-color: var(--accent-dim);
}
.comment-sheet-panel button[data-action="close"] {
  background: transparent;
  border: 0;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  padding: 0 var(--space-1);
}
.comment-sheet-panel button[data-action="close"]:hover { color: var(--text); }
.preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.element-screenshot {
  display: block;
  max-width: 100%;
  max-height: 160px;
  object-fit: contain;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.viewport-surface {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.comment {
  width: 100%;
  resize: vertical;
  font: inherit;
  color: var(--text);
  background: var(--bg-sunken);
  padding: var(--space-3);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  box-sizing: border-box;
}
.comment:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}
@media (min-width: 768px) {
  .comment-sheet-panel {
    top: 0;
    right: 0;
    bottom: 0;
    width: 400px;
  }
}
@media (max-width: 767.98px) {
  .comment-sheet-panel {
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 85vh;
    border-radius: 16px 16px 0 0;
  }
}
`;

/** Cached references to DOM nodes built by the sheet's template. */
interface SheetDom {
  root: HTMLElement;
  backdrop: HTMLElement;
  closeBtn: HTMLButtonElement;
  elementImg: HTMLImageElement;
  viewportSurface: HTMLElement;
  textarea: HTMLTextAreaElement;
  cancelBtn: HTMLButtonElement;
  addAnotherBtn: HTMLButtonElement;
  sendBtn: HTMLButtonElement;
  groupCount: HTMLSpanElement;
}

/**
 * Build the sheet's structural DOM and return references to the interactive
 * nodes. The root element is returned detached; the caller mounts it.
 *
 * @returns Fresh sheet DOM.
 */
function buildSheetDom(): SheetDom {
  const root = document.createElement('div');
  root.className = 'comment-sheet';
  root.setAttribute('data-open', 'false');
  const style = document.createElement('style');
  style.textContent = FORJIS_TOKENS + COMMENT_SHEET_STYLE;
  root.appendChild(style);
  const backdrop = document.createElement('div');
  backdrop.className = 'comment-sheet-backdrop';
  root.appendChild(backdrop);
  const panel = document.createElement('aside');
  panel.className = 'comment-sheet-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Forjis pin comment');
  root.appendChild(panel);
  const header = document.createElement('header');
  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = 'New pin';
  titleWrap.appendChild(title);
  const groupCount = document.createElement('span');
  groupCount.className = 'group-count';
  groupCount.setAttribute('data-visible', 'false');
  groupCount.textContent = '';
  titleWrap.appendChild(groupCount);
  header.appendChild(titleWrap);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.dataset.action = 'close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  header.appendChild(closeBtn);
  panel.appendChild(header);
  const preview = document.createElement('section');
  preview.className = 'preview';
  const elementImg = document.createElement('img');
  elementImg.className = 'element-screenshot';
  elementImg.alt = 'Element screenshot';
  preview.appendChild(elementImg);
  const viewportSurface = document.createElement('div');
  viewportSurface.className = 'viewport-surface';
  preview.appendChild(viewportSurface);
  panel.appendChild(preview);
  const textarea = document.createElement('textarea');
  textarea.className = 'comment';
  textarea.rows = 4;
  textarea.placeholder = "Describe what you'd like to change…";
  panel.appendChild(textarea);
  const footer = document.createElement('footer');
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.dataset.action = 'cancel';
  cancelBtn.textContent = 'Cancel';
  footer.appendChild(cancelBtn);
  const addAnotherBtn = document.createElement('button');
  addAnotherBtn.type = 'button';
  addAnotherBtn.dataset.action = 'add-another';
  addAnotherBtn.setAttribute('aria-label', 'Add another pin to this comment');
  addAnotherBtn.textContent = 'Add another pin';
  footer.appendChild(addAnotherBtn);
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.dataset.action = 'send';
  sendBtn.className = 'primary';
  sendBtn.textContent = 'Send';
  footer.appendChild(sendBtn);
  panel.appendChild(footer);
  return {
    root,
    backdrop,
    closeBtn,
    elementImg,
    viewportSurface,
    textarea,
    cancelBtn,
    addAnotherBtn,
    sendBtn,
    groupCount,
  };
}

/** Mutable per-open state torn down by `close()`. */
interface OpenState {
  groupPins: Array<{
    context: CommentSheetContext;
    elementUrl: string;
  }>;
  annotationHandle: AnnotationCanvasHandle;
  commentGroupId: string | null;
  textareaBuffer: string;
}

/**
 * Update the header's `N pins` badge based on the current group size.
 *
 * @param dom - Sheet DOM.
 * @param count - Total pins collected in the active group.
 */
function syncGroupCount(dom: SheetDom, count: number): void {
  if (count > 1) {
    dom.groupCount.textContent = String(count) + ' pins';
    dom.groupCount.setAttribute('data-visible', 'true');
    return;
  }
  dom.groupCount.textContent = '';
  dom.groupCount.setAttribute('data-visible', 'false');
}

/**
 * Build a comment sheet, mount it into `opts.shadow`, and wire Send /
 * Cancel / "Add another pin" behavior. The sheet starts hidden;
 * `open(context)` reveals it.
 *
 * @param opts - Init options.
 * @returns A {@link CommentSheetHandle}.
 */
export function createCommentSheet(
  opts: InitCommentSheetOptions,
): CommentSheetHandle {
  const dom = buildSheetDom();
  opts.shadow.appendChild(dom.root);
  let openState: OpenState | null = null;
  let destroyed = false;
  let sendInFlight = false;

  const closeInternal = (): void => {
    dom.root.setAttribute('data-open', 'false');
    if (!openState) {
      return;
    }
    openState.annotationHandle.destroy();
    for (const entry of openState.groupPins) {
      URL.revokeObjectURL(entry.elementUrl);
    }
    openState = null;
    syncGroupCount(dom, 0);
  };

  const cancel = (): void => {
    if (!openState) {
      return;
    }
    opts.onCancel();
    closeInternal();
  };

  const hide = (): void => {
    if (!openState) {
      dom.root.setAttribute('data-open', 'false');
      return;
    }
    openState.textareaBuffer = dom.textarea.value;
    dom.root.setAttribute('data-open', 'false');
  };

  const addPinToGroup = (context: CommentSheetContext): void => {
    if (!openState) {
      return;
    }
    if (openState.commentGroupId === null) {
      openState.commentGroupId =
        context.commentGroupId ?? generateUuid();
    }
    const elementUrl = URL.createObjectURL(context.elementBlob);
    openState.groupPins.push({ context, elementUrl });
    dom.elementImg.src = elementUrl;
    dom.textarea.value = openState.textareaBuffer;
    syncGroupCount(dom, openState.groupPins.length);
    dom.root.setAttribute('data-open', 'true');
  };

  const handleAddAnother = (): void => {
    if (!openState) {
      return;
    }
    if (openState.commentGroupId === null) {
      openState.commentGroupId = generateUuid();
    }
    opts.onAddAnotherPin();
    hide();
  };

  const sendOne = async (
    entry: { context: CommentSheetContext; elementUrl: string },
    comment: string,
    annotations: Annotation[],
    commentGroupId: string | null,
  ): Promise<void> => {
    const pin = await buildPin(
      entry.context.target,
      comment,
      annotations,
      {
        elementPng: entry.context.elementBlob,
        viewportPng: entry.context.viewportBlob,
        computedStyles: entry.context.computedStyles,
      },
      {
        commentGroupId,
        screen: entry.context.screen,
      },
    );
    opts.onSubmit(pin);
  };

  const send = async (): Promise<void> => {
    if (!openState || sendInFlight) {
      return;
    }
    sendInFlight = true;
    const comment = dom.textarea.value;
    const annotations: Annotation[] = openState.annotationHandle.getAnnotations();
    const commentGroupId = openState.commentGroupId;
    const entries = openState.groupPins.slice();
    try {
      for (const entry of entries) {
        await sendOne(entry, comment, annotations.slice(), commentGroupId);
      }
      closeInternal();
    } finally {
      sendInFlight = false;
    }
  };

  dom.closeBtn.addEventListener('click', cancel);
  dom.cancelBtn.addEventListener('click', cancel);
  dom.backdrop.addEventListener('click', cancel);
  dom.addAnotherBtn.addEventListener('click', handleAddAnother);
  dom.sendBtn.addEventListener('click', () => {
    void send();
  });

  return {
    element: dom.root,
    open(context) {
      if (destroyed) {
        return;
      }
      if (openState) {
        closeInternal();
      }
      const elementUrl = URL.createObjectURL(context.elementBlob);
      dom.elementImg.src = elementUrl;
      dom.textarea.value = '';
      while (dom.viewportSurface.firstChild) {
        dom.viewportSurface.removeChild(dom.viewportSurface.firstChild);
      }
      const annotationHandle = createAnnotationCanvas({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        backgroundBlob: context.viewportBlob,
      });
      dom.viewportSurface.appendChild(annotationHandle.element);
      openState = {
        groupPins: [{ context, elementUrl }],
        annotationHandle,
        commentGroupId: context.commentGroupId ?? null,
        textareaBuffer: '',
      };
      syncGroupCount(dom, 1);
      dom.root.setAttribute('data-open', 'true');
    },
    hide,
    isOpen() {
      return openState !== null;
    },
    addPinToGroup,
    close() {
      closeInternal();
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      closeInternal();
      if (dom.root.parentNode) {
        dom.root.parentNode.removeChild(dom.root);
      }
    },
  };
}
