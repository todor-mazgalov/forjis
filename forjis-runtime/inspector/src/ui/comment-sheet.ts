/**
 * Comment sheet factory.
 *
 * The comment sheet (design.md §D-007, spec FR-009-005) is a drawer hosted
 * inside the overlay's existing shadow root for style isolation. It renders
 * the element screenshot, the viewport screenshot with an annotation canvas
 * layered over it, a comment textarea, and Send / Cancel controls. Desktop
 * (≥768 px): right-side drawer (~400 px). Mobile: full-width bottom sheet.
 *
 * Lifecycle: constructed once by the overlay and reused across picks. Each
 * `open(context)` mounts a fresh `AnnotationCanvasHandle` and swaps in new
 * screenshot object URLs. `close()` destroys the annotation canvas, revokes
 * the object URLs, and hides the drawer. `destroy()` removes all DOM.
 */

import type { Annotation, Bbox, Pin, PinTarget } from '@forjis/shared';
import { buildPin } from '../pipeline.js';
import {
  createAnnotationCanvas,
  type AnnotationCanvasHandle,
} from './annotation-canvas.js';

/** Init options accepted by {@link createCommentSheet}. */
export interface InitCommentSheetOptions {
  /** The overlay's open shadow root; the sheet appends itself here. */
  readonly shadow: ShadowRoot;
  /** Called with the finalized `Pin` when the user clicks Send. */
  readonly onSubmit: (pin: Pin) => void;
  /** Called when the user clicks Cancel or the backdrop. */
  readonly onCancel: () => void;
}

/** Context supplied to {@link CommentSheetHandle.open}. */
export interface CommentSheetContext {
  /** `PinTarget` emitted by the overlay at pick time. */
  readonly target: PinTarget;
  /** Cropped element screenshot Blob. */
  readonly elementBlob: Blob;
  /** Viewport screenshot Blob (used as annotation background). */
  readonly viewportBlob: Blob;
  /** Pin bbox in viewport-pixel coordinates (also drawn on the viewport PNG). */
  readonly bbox: Bbox;
  /** Curated computed-styles snapshot taken synchronously at pick time. */
  readonly computedStyles: Record<string, string>;
}

/** Handle returned by {@link createCommentSheet}. */
export interface CommentSheetHandle {
  /** The drawer container (mounted inside the supplied shadow root). */
  readonly element: HTMLElement;
  /** Populate the sheet with a new capture bundle and make it visible. */
  open(context: CommentSheetContext): void;
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
  background: rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}
.comment-sheet-panel {
  position: fixed;
  background: #ffffff;
  color: #111827;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
  font: 14px/1.4 system-ui, -apple-system, sans-serif;
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
  font-size: 16px;
}
.comment-sheet-panel button {
  font: inherit;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid #d1d5db;
  background: #f9fafb;
  padding: 6px 12px;
}
.comment-sheet-panel button.primary {
  background: #2563eb;
  color: #ffffff;
  border-color: #1d4ed8;
}
.comment-sheet-panel button[data-action="close"] {
  background: transparent;
  border: 0;
  font-size: 20px;
  line-height: 1;
  padding: 0 4px;
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.element-screenshot {
  display: block;
  max-width: 100%;
  max-height: 160px;
  object-fit: contain;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
}
.viewport-surface {
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
}
.comment {
  width: 100%;
  resize: vertical;
  font: inherit;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #d1d5db;
  box-sizing: border-box;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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
  sendBtn: HTMLButtonElement;
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
  style.textContent = COMMENT_SHEET_STYLE;
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
  const title = document.createElement('h2');
  title.textContent = 'New pin';
  header.appendChild(title);
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
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.dataset.action = 'send';
  sendBtn.className = 'primary';
  sendBtn.textContent = 'Send';
  footer.appendChild(sendBtn);
  panel.appendChild(footer);
  return { root, backdrop, closeBtn, elementImg, viewportSurface, textarea, cancelBtn, sendBtn };
}

/** Mutable per-open state torn down by `close()`. */
interface OpenState {
  context: CommentSheetContext;
  annotationHandle: AnnotationCanvasHandle;
  elementUrl: string;
}

/**
 * Build a comment sheet, mount it into `opts.shadow`, and wire Send / Cancel
 * behavior. The sheet starts hidden; `open(context)` reveals it.
 *
 * Send: collects `comment` + `annotations`, calls `buildPin`, fires
 * `opts.onSubmit(pin)`, closes. Cancel (button or backdrop): fires
 * `opts.onCancel()`, closes.
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
    if (!openState) {
      dom.root.setAttribute('data-open', 'false');
      return;
    }
    dom.root.setAttribute('data-open', 'false');
    openState.annotationHandle.destroy();
    URL.revokeObjectURL(openState.elementUrl);
    openState = null;
  };

  const cancel = (): void => {
    if (!openState) {
      return;
    }
    opts.onCancel();
    closeInternal();
  };

  const send = async (): Promise<void> => {
    if (!openState || sendInFlight) {
      return;
    }
    sendInFlight = true;
    const ctx = openState.context;
    const comment = dom.textarea.value;
    const annotations: Annotation[] = openState.annotationHandle.getAnnotations();
    try {
      const pin = await buildPin(ctx.target, comment, annotations, {
        elementPng: ctx.elementBlob,
        viewportPng: ctx.viewportBlob,
        computedStyles: ctx.computedStyles,
      });
      opts.onSubmit(pin);
      closeInternal();
    } finally {
      sendInFlight = false;
    }
  };

  dom.closeBtn.addEventListener('click', cancel);
  dom.cancelBtn.addEventListener('click', cancel);
  dom.backdrop.addEventListener('click', cancel);
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
      openState = { context, annotationHandle, elementUrl };
      dom.root.setAttribute('data-open', 'true');
    },
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
