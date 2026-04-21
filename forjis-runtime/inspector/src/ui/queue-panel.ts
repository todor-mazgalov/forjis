/**
 * Queue panel UI (design.md §D-009, FR-010-019..028).
 *
 * A drawer hosted inside the overlay's shadow root. Collapsed state: a
 * circular pill in the bottom-left corner with a pin-count badge.
 * Expanded state: a ~360×480 px drawer with one row per queued pin
 * (thumbnail + truncated comment + navigate / edit / remove controls)
 * and a Submit button. Subscribes to `BatchState.subscribe` for reactive
 * re-rendering; honors `prefers-reduced-motion`; closes on Escape when
 * expanded.
 */

import type { Batch, Pin } from '@forjis/shared';
import { removePin, subscribe, updatePin } from '../queue/batch-state.js';

/** Init options accepted by {@link createQueuePanel}. */
export interface InitQueuePanelOptions {
  /** Overlay shadow root. */
  readonly shadow: ShadowRoot;
  /** Invoked when the user activates Submit. */
  readonly onSubmitBatch: () => void;
  /** Invoked when the user taps a row body to navigate. */
  readonly onNavigateToPin: (pin: Pin) => void;
}

/** Handle returned by {@link createQueuePanel}. */
export interface QueuePanelHandle {
  /** The panel container element. */
  readonly element: HTMLElement;
  /** Show the expanded drawer. */
  expand(): void;
  /** Collapse the drawer to the pill. */
  collapse(): void;
  /** Remove listeners and DOM. Idempotent. */
  destroy(): void;
}

/** Maximum comment length rendered per row. Excess is replaced with an ellipsis. */
const COMMENT_MAX_LEN = 80;

/** Inline CSS for the queue panel. */
const QUEUE_PANEL_STYLE = `
div[data-forjis-queue-panel] {
  position: fixed;
  bottom: 16px;
  left: 16px;
  pointer-events: auto;
  font: 13px/1.4 system-ui, -apple-system, sans-serif;
  color: #111827;
}
.queue-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #1f2937;
  color: #f9fafb;
  border: 1px solid #374151;
  border-radius: 999px;
  min-width: 40px;
  min-height: 40px;
  padding: 0 12px;
  cursor: pointer;
  box-shadow: 0 4px 10px rgba(0,0,0,0.2);
}
.queue-pill:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.queue-pill .count {
  background: #2563eb;
  color: #ffffff;
  border-radius: 999px;
  padding: 2px 8px;
  font-weight: 600;
  font-size: 12px;
  margin-left: 6px;
}
.queue-drawer {
  position: fixed;
  left: 16px;
  bottom: 72px;
  width: 360px;
  max-height: 480px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.queue-drawer[data-open="false"] { display: none; }
.queue-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.queue-row {
  display: grid;
  grid-template-columns: 48px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 6px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f9fafb;
}
.queue-row img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  background: #e5e7eb;
}
.queue-row .comment { font-size: 12px; color: #374151; cursor: pointer; }
.queue-row .controls { display: flex; gap: 4px; }
.queue-row button {
  min-width: 28px;
  min-height: 28px;
  background: transparent;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.queue-row button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.queue-row textarea {
  width: 100%;
  font: inherit;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 4px;
  box-sizing: border-box;
}
.queue-edit-actions { display: flex; gap: 4px; margin-top: 4px; }
.queue-footer {
  border-top: 1px solid #e5e7eb;
  padding: 8px;
  display: flex;
  justify-content: flex-end;
}
.queue-footer button {
  background: #2563eb;
  color: #ffffff;
  border: 1px solid #1d4ed8;
  border-radius: 4px;
  padding: 6px 14px;
  font: inherit;
  cursor: pointer;
}
.queue-footer button:disabled {
  background: #9ca3af;
  border-color: #6b7280;
  cursor: not-allowed;
}
.queue-empty { padding: 12px; color: #6b7280; text-align: center; }
@media (prefers-reduced-motion: reduce) {
  .queue-drawer { transition: none; }
}
`;

/**
 * Truncate a string to {@link COMMENT_MAX_LEN} characters, appending a
 * one-character ellipsis when the original exceeds the cap.
 *
 * @param raw - Original text.
 * @returns Truncated text.
 */
function truncateComment(raw: string): string {
  if (raw.length <= COMMENT_MAX_LEN) {
    return raw;
  }
  return raw.slice(0, COMMENT_MAX_LEN - 1) + '…';
}

/** Cached DOM references for the panel. */
interface PanelDom {
  root: HTMLElement;
  pill: HTMLElement;
  pillCount: HTMLSpanElement;
  drawer: HTMLElement;
  list: HTMLElement;
  submitBtn: HTMLButtonElement;
}

/**
 * Build the panel's structural DOM.
 *
 * @returns Fresh {@link PanelDom}.
 */
function buildPanelDom(): PanelDom {
  const root = document.createElement('div');
  root.setAttribute('data-forjis-queue-panel', 'true');
  const style = document.createElement('style');
  style.textContent = QUEUE_PANEL_STYLE;
  root.appendChild(style);
  const pill = document.createElement('div');
  pill.className = 'queue-pill';
  pill.setAttribute('role', 'button');
  pill.setAttribute('tabindex', '0');
  pill.setAttribute('aria-expanded', 'false');
  pill.setAttribute('aria-label', 'Open pin queue (0 pins)');
  const pillLabel = document.createElement('span');
  pillLabel.textContent = 'Queue';
  const pillCount = document.createElement('span');
  pillCount.className = 'count';
  pillCount.textContent = '0';
  pill.appendChild(pillLabel);
  pill.appendChild(pillCount);
  root.appendChild(pill);
  const drawer = document.createElement('div');
  drawer.className = 'queue-drawer';
  drawer.setAttribute('data-open', 'false');
  drawer.setAttribute('role', 'region');
  drawer.setAttribute('aria-label', 'Pin queue');
  const list = document.createElement('div');
  list.className = 'queue-list';
  drawer.appendChild(list);
  const footer = document.createElement('div');
  footer.className = 'queue-footer';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.textContent = 'Submit batch';
  submitBtn.disabled = true;
  footer.appendChild(submitBtn);
  drawer.appendChild(footer);
  root.appendChild(drawer);
  return { root, pill, pillCount, drawer, list, submitBtn };
}

/**
 * Render a single queued-pin row.
 *
 * @param pin - Pin to render.
 * @param onNavigate - Invoked on row-body click (navigate).
 * @returns Fresh row element.
 */
function buildRow(
  pin: Pin,
  onNavigate: (pin: Pin) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'queue-row';
  row.setAttribute('data-pin-id', pin.id);
  const img = document.createElement('img');
  img.src = pin.capture.elementScreenshot;
  img.alt = 'Pin thumbnail';
  row.appendChild(img);
  const commentSpan = document.createElement('span');
  commentSpan.className = 'comment';
  commentSpan.textContent = truncateComment(pin.comment);
  commentSpan.addEventListener('click', () => {
    onNavigate(pin);
  });
  row.appendChild(commentSpan);
  const controls = document.createElement('div');
  controls.className = 'controls';
  const navigateBtn = document.createElement('button');
  navigateBtn.type = 'button';
  navigateBtn.setAttribute('data-action', 'navigate');
  navigateBtn.setAttribute('aria-label', 'Navigate to pin');
  navigateBtn.textContent = '⤴';
  navigateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onNavigate(pin);
  });
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.setAttribute('data-action', 'edit');
  editBtn.setAttribute('aria-label', 'Edit comment');
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    swapRowToEdit(row, commentSpan, pin);
  });
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.setAttribute('data-action', 'remove');
  removeBtn.setAttribute('aria-label', 'Remove pin');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removePin(pin.id);
  });
  controls.appendChild(navigateBtn);
  controls.appendChild(editBtn);
  controls.appendChild(removeBtn);
  row.appendChild(controls);
  return row;
}

/**
 * Swap a row's comment span into an inline `<textarea>` with Save / Cancel
 * controls. Save invokes `BatchState.updatePin`; Cancel restores the
 * original span.
 *
 * @param row - Queue row element.
 * @param commentSpan - The span currently rendering the truncated comment.
 * @param pin - Pin whose comment is being edited.
 */
function swapRowToEdit(
  row: HTMLElement,
  commentSpan: HTMLSpanElement,
  pin: Pin,
): void {
  const wrap = document.createElement('div');
  const textarea = document.createElement('textarea');
  textarea.rows = 3;
  textarea.value = pin.comment;
  wrap.appendChild(textarea);
  const actions = document.createElement('div');
  actions.className = 'queue-edit-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.setAttribute('data-action', 'save');
  saveBtn.setAttribute('aria-label', 'Save comment');
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.setAttribute('data-action', 'cancel-edit');
  cancelBtn.setAttribute('aria-label', 'Cancel edit');
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);
  row.replaceChild(wrap, commentSpan);
  saveBtn.addEventListener('click', () => {
    updatePin(pin.id, { comment: textarea.value });
  });
  cancelBtn.addEventListener('click', () => {
    row.replaceChild(commentSpan, wrap);
  });
  textarea.focus();
}

/**
 * Reflect the supplied batch into the pill badge, the drawer list, and
 * the Submit button's `disabled` state.
 *
 * @param dom - Panel DOM references.
 * @param batch - Current `Batch` snapshot, or `null`.
 * @param onNavigate - Passed through into each row.
 */
function renderBatch(
  dom: PanelDom,
  batch: Batch | null,
  onNavigate: (pin: Pin) => void,
): void {
  const pinCount = batch ? batch.pins.length : 0;
  dom.pillCount.textContent = String(pinCount);
  dom.pill.setAttribute(
    'aria-label',
    'Open pin queue (' + String(pinCount) + ' pins)',
  );
  dom.submitBtn.disabled = !batch || batch.pins.length === 0;
  while (dom.list.firstChild) {
    dom.list.removeChild(dom.list.firstChild);
  }
  if (!batch || batch.pins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'No pins queued yet.';
    dom.list.appendChild(empty);
    return;
  }
  for (const pin of batch.pins) {
    dom.list.appendChild(buildRow(pin, onNavigate));
  }
}

/**
 * Build a queue panel, mount it into `opts.shadow`, and wire BatchState
 * subscription + DOM listeners.
 *
 * @param opts - Init options.
 * @returns A {@link QueuePanelHandle}.
 */
export function createQueuePanel(
  opts: InitQueuePanelOptions,
): QueuePanelHandle {
  const dom = buildPanelDom();
  opts.shadow.appendChild(dom.root);
  let expanded = false;
  let destroyed = false;
  let lastFocused: Element | null = null;

  const applyExpanded = (): void => {
    dom.drawer.setAttribute('data-open', expanded ? 'true' : 'false');
    dom.pill.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };

  const expand = (): void => {
    if (expanded) {
      return;
    }
    lastFocused = document.activeElement;
    expanded = true;
    applyExpanded();
  };

  const collapse = (): void => {
    if (!expanded) {
      return;
    }
    expanded = false;
    applyExpanded();
    if (lastFocused instanceof HTMLElement) {
      lastFocused.focus();
    } else {
      dom.pill.focus();
    }
  };

  const togglePill = (): void => {
    if (expanded) {
      collapse();
    } else {
      expand();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && expanded) {
      collapse();
    }
  };

  dom.pill.addEventListener('click', togglePill);
  dom.pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePill();
    }
  });
  dom.submitBtn.addEventListener('click', () => {
    opts.onSubmitBatch();
  });
  document.addEventListener('keydown', onKeyDown);

  const unsubscribe = subscribe((batch) => {
    renderBatch(dom, batch, opts.onNavigateToPin);
  });
  // Initial render with null so the empty state + disabled submit appear.
  renderBatch(dom, null, opts.onNavigateToPin);

  return {
    element: dom.root,
    expand,
    collapse,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      document.removeEventListener('keydown', onKeyDown);
      unsubscribe();
      if (dom.root.parentNode) {
        dom.root.parentNode.removeChild(dom.root);
      }
    },
  };
}
