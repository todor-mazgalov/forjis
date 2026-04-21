/**
 * Reply-sheet factory (design.md §D-005, FR-011-022).
 *
 * Mirrors the comment sheet's shadow-rooted layout (desktop right drawer,
 * mobile bottom sheet) minus the "Add another pin" control. Adds a
 * parent-pin context header with (a) a caption referencing the parent
 * batch's short id, (b) the parent pin's element-screenshot thumbnail,
 * (c) the parent pin's comment, and (d) the agent diff summary (or the
 * placeholder `"Agent diff summary unavailable"`). Send dispatches
 * `onSubmitReply({ parentPinId, parentBatchId, parentTaskPath, comment })`
 * when the comment is non-empty.
 *
 * Module boundaries (NFR-011-002): imports only `@forjis/shared` types.
 * `mount.ts` owns `buildPin` invocation and the subsequent `pin.create +
 * batch.submit` dispatch (see D-006).
 */

import type { Batch, Pin } from '@forjis/shared';

/** Parent context supplied to {@link ReplySheetHandle.open}. */
export interface ReplySheetContext {
  /** Parent pin being replied to. */
  readonly pin: Pin;
  /** Parent batch. */
  readonly batch: Batch;
  /** Task path stored by the history store. */
  readonly taskPath: string;
  /** Agent diff summary when available, else `null`. */
  readonly summary: string | null;
}

/** Payload passed to `onSubmitReply`. */
export interface ReplySubmitPayload {
  /** Parent pin identifier. */
  readonly parentPinId: string;
  /** Parent batch identifier. */
  readonly parentBatchId: string;
  /** Parent batch's task path. */
  readonly parentTaskPath: string;
  /** Trimmed user comment from the textarea. */
  readonly comment: string;
}

/** Init options accepted by {@link createReplySheet}. */
export interface InitReplySheetOptions {
  /** Overlay shadow root. */
  readonly shadow: ShadowRoot;
  /** Invoked with the composed payload when the user clicks Send. */
  readonly onSubmitReply: (payload: ReplySubmitPayload) => void;
  /** Invoked when the user clicks Cancel. */
  readonly onCancel: () => void;
}

/** Handle returned by {@link createReplySheet}. */
export interface ReplySheetHandle {
  /** The sheet root element (mounted inside the supplied shadow root). */
  readonly element: HTMLElement;
  /** Populate the sheet with a parent context and show it. */
  open(context: ReplySheetContext): void;
  /** Hide the sheet without destroying in-memory state. */
  close(): void;
  /** Whether the sheet is currently open. */
  isOpen(): boolean;
  /** Remove listeners and DOM. Idempotent. */
  destroy(): void;
}

/** Placeholder shown when the agent diff summary has not yet arrived. */
const SUMMARY_PLACEHOLDER = 'Agent diff summary unavailable';

/** Inline CSS for the reply sheet. Mirrors comment-sheet breakpoints. */
const REPLY_SHEET_STYLE = `
div[data-forjis-reply-sheet] { position: fixed; inset: 0; pointer-events: none; }
div[data-forjis-reply-sheet][data-open="false"] { display: none; }
.reply-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}
.reply-sheet-panel {
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
.reply-parent-context {
  padding: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f9fafb;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.reply-caption { font-weight: 600; font-size: 13px; color: #374151; }
.reply-parent-thumbnail {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 4px;
  background: #e5e7eb;
}
.reply-parent-comment { font-size: 13px; color: #111827; }
.reply-summary { font-size: 12px; color: #4b5563; font-style: italic; }
.reply-comment {
  width: 100%;
  resize: vertical;
  padding: 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font: inherit;
  box-sizing: border-box;
  min-height: 96px;
}
.reply-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.reply-footer button {
  font: inherit;
  cursor: pointer;
  border-radius: 4px;
  padding: 6px 12px;
}
.reply-cancel-btn {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: #f9fafb;
  color: #374151;
  border: 1px solid #d1d5db;
  box-sizing: border-box;
}
.reply-send-btn {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: #2563eb;
  color: #ffffff;
  border: 1px solid #1d4ed8;
  box-sizing: border-box;
}
@media (min-width: 768px) {
  .reply-sheet-panel { top: 0; right: 0; bottom: 0; width: 400px; }
}
@media (max-width: 767.98px) {
  .reply-sheet-panel {
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 85vh;
    border-radius: 16px 16px 0 0;
  }
}
`;

/** Cached DOM references. */
interface SheetDom {
  root: HTMLElement;
  backdrop: HTMLElement;
  caption: HTMLSpanElement;
  thumbnail: HTMLImageElement;
  parentComment: HTMLDivElement;
  summary: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
}

/** Construct the sheet's structural DOM. */
function buildSheetDom(): SheetDom {
  const root = document.createElement('div');
  root.setAttribute('data-forjis-reply-sheet', 'true');
  root.setAttribute('data-open', 'false');
  const style = document.createElement('style');
  style.textContent = REPLY_SHEET_STYLE;
  root.appendChild(style);
  const backdrop = document.createElement('div');
  backdrop.className = 'reply-sheet-backdrop';
  root.appendChild(backdrop);
  const panel = document.createElement('aside');
  panel.className = 'reply-sheet-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Forjis reply');
  const context = document.createElement('div');
  context.className = 'reply-parent-context';
  const caption = document.createElement('span');
  caption.className = 'reply-caption';
  context.appendChild(caption);
  const thumbnail = document.createElement('img');
  thumbnail.className = 'reply-parent-thumbnail';
  thumbnail.alt = 'Parent pin thumbnail';
  context.appendChild(thumbnail);
  const parentComment = document.createElement('div');
  parentComment.className = 'reply-parent-comment';
  context.appendChild(parentComment);
  const summary = document.createElement('div');
  summary.className = 'reply-summary';
  context.appendChild(summary);
  panel.appendChild(context);
  const textarea = document.createElement('textarea');
  textarea.className = 'reply-comment';
  textarea.rows = 4;
  textarea.placeholder = 'What else should the agent change?';
  panel.appendChild(textarea);
  const footer = document.createElement('div');
  footer.className = 'reply-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'reply-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  footer.appendChild(cancelBtn);
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'reply-send-btn';
  sendBtn.textContent = 'Send reply';
  footer.appendChild(sendBtn);
  panel.appendChild(footer);
  root.appendChild(panel);
  return {
    root,
    backdrop,
    caption,
    thumbnail,
    parentComment,
    summary,
    textarea,
    sendBtn,
    cancelBtn,
  };
}

/** Render the parent-context header against `ctx`. */
function renderContext(dom: SheetDom, ctx: ReplySheetContext): void {
  dom.caption.textContent =
    'Reply to pin from batch ' + ctx.batch.id.slice(0, 8);
  dom.thumbnail.src = ctx.pin.capture.elementScreenshot;
  dom.parentComment.textContent = ctx.pin.comment;
  dom.summary.textContent = ctx.summary ?? SUMMARY_PLACEHOLDER;
}

/**
 * Build a reply sheet, mount it into `opts.shadow`, and wire Send /
 * Cancel behavior. The sheet starts hidden; `open(context)` reveals it.
 *
 * @param opts - Init options.
 * @returns A {@link ReplySheetHandle}.
 */
export function createReplySheet(
  opts: InitReplySheetOptions,
): ReplySheetHandle {
  const dom = buildSheetDom();
  opts.shadow.appendChild(dom.root);
  let activeContext: ReplySheetContext | null = null;
  let destroyed = false;

  const close = (): void => {
    dom.root.setAttribute('data-open', 'false');
    dom.textarea.value = '';
    activeContext = null;
  };

  const cancel = (): void => {
    opts.onCancel();
    close();
  };

  const send = (): void => {
    if (!activeContext) {
      return;
    }
    const trimmed = dom.textarea.value.trim();
    if (trimmed.length === 0) {
      return;
    }
    opts.onSubmitReply({
      parentPinId: activeContext.pin.id,
      parentBatchId: activeContext.batch.id,
      parentTaskPath: activeContext.taskPath,
      comment: trimmed,
    });
    close();
  };

  dom.cancelBtn.addEventListener('click', cancel);
  dom.backdrop.addEventListener('click', cancel);
  dom.sendBtn.addEventListener('click', send);

  return {
    element: dom.root,
    open(context) {
      if (destroyed) {
        return;
      }
      activeContext = context;
      renderContext(dom, context);
      dom.textarea.value = '';
      dom.root.setAttribute('data-open', 'true');
    },
    close,
    isOpen() {
      return activeContext !== null;
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      activeContext = null;
      if (dom.root.parentNode) {
        dom.root.parentNode.removeChild(dom.root);
      }
    },
  };
}
