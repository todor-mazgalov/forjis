/**
 * Queue panel UI (design.md §D-009, FR-010-019..028).
 *
 * A drawer hosted inside the overlay's shadow root. Collapsed state: a
 * rounded "Queue" pill in the bottom-left corner with a pin-count badge.
 * Expanded state: a ~360×480 px drawer with a chevron header, one row per
 * queued pin (thumbnail + truncated comment + navigate / edit / remove
 * controls), and a Submit button. Subscribes to `BatchState.subscribe`
 * for reactive re-rendering; honors `prefers-reduced-motion`; closes on
 * Escape when expanded.
 *
 * Drawer expanded/collapsed state persists for the session under
 * `sessionStorage['forjis-inspector:queue.collapsed']`; when the key
 * holds `"true"` at construction time the drawer starts collapsed.
 *
 * Theming: colors come from the Forjis design-token block copied under
 * `:host` by {@link FORJIS_TOKENS} so the panel reads the dashboard's
 * dark surfaces and mint accent.
 */

import type { Batch, Pin } from '@forjis/shared';
import { removePin, subscribe, updatePin } from '../queue/batch-state.js';
import { FORJIS_TOKENS } from './theme.js';

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

/** SessionStorage key tracking the drawer's collapsed state. */
export const QUEUE_COLLAPSED_STORAGE_KEY = 'forjis-inspector:queue.collapsed';

/** Inline CSS for the queue panel. */
const QUEUE_PANEL_STYLE = `
div[data-forjis-queue-panel] {
  position: fixed;
  bottom: 16px;
  left: 16px;
  pointer-events: auto;
  font: var(--text-base)/1.4 var(--font-sans);
  color: var(--text);
}
.queue-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  background: var(--bg-panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 999px;
  min-width: 40px;
  min-height: 40px;
  padding: 0 var(--space-4);
  cursor: pointer;
  box-shadow: 0 4px 10px rgba(0,0,0,0.35);
}
.queue-pill:hover { border-color: var(--border-strong); }
.queue-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.queue-pill .count {
  background: var(--accent);
  color: var(--bg-base);
  border-radius: 999px;
  padding: 2px var(--space-3);
  font-weight: 600;
  font-size: var(--text-sm);
}
.queue-drawer {
  position: fixed;
  left: 16px;
  bottom: 72px;
  width: 360px;
  max-height: 60vh;
  background: var(--bg-panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.queue-drawer[data-open="false"] { display: none; }
.queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px var(--space-4);
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--text);
}
.queue-header .queue-chevron {
  min-width: 28px;
  min-height: 28px;
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font: inherit;
  line-height: 1;
}
.queue-header .queue-chevron:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.queue-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.queue-row {
  display: grid;
  grid-template-columns: 48px 1fr auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
}
.queue-row:hover { border-color: var(--border-strong); }
.queue-row img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.queue-row .comment {
  font-size: var(--text-sm);
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  word-break: break-word;
}
.queue-row .controls { display: flex; gap: var(--space-1); }
.queue-row button {
  min-width: 28px;
  min-height: 28px;
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font: inherit;
}
.queue-row button:hover { color: var(--text); border-color: var(--border-strong); }
.queue-row button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.queue-row textarea {
  width: 100%;
  font: inherit;
  color: var(--text);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1);
  box-sizing: border-box;
}
.queue-edit-actions { display: flex; gap: var(--space-1); margin-top: var(--space-1); }
.queue-footer {
  border-top: 1px solid var(--border);
  padding: var(--space-3);
  display: flex;
  justify-content: flex-end;
}
.queue-footer button {
  background: var(--accent);
  color: var(--bg-base);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: var(--space-2) 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.queue-footer button:hover:not(:disabled) { background: var(--accent-dim); border-color: var(--accent-dim); }
.queue-footer button:disabled {
  background: var(--bg-sunken);
  color: var(--text-muted);
  border-color: var(--border);
  cursor: not-allowed;
}
.queue-empty { padding: var(--space-4); color: var(--text-muted); text-align: center; }
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
  chevron: HTMLButtonElement;
  list: HTMLElement;
  submitBtn: HTMLButtonElement;
}

/**
 * Build the pill element and its inner label/count spans.
 *
 * @returns Tuple with the pill wrapper and its count span.
 */
function buildPill(): { pill: HTMLElement; count: HTMLSpanElement } {
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
  return { pill, count: pillCount };
}

/**
 * Build the drawer header with a title span and a chevron button that
 * collapses the drawer back to the pill.
 *
 * @returns Tuple with the header and chevron button.
 */
function buildDrawerHeader(): { header: HTMLElement; chevron: HTMLButtonElement } {
  const header = document.createElement('div');
  header.className = 'queue-header';
  const title = document.createElement('span');
  title.textContent = 'Pin queue';
  header.appendChild(title);
  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'queue-chevron';
  chevron.setAttribute('data-forjis-queue-chevron', 'true');
  chevron.setAttribute('aria-label', 'Collapse queue drawer');
  // Hover tooltip — updated to "Expand" / "Collapse" as state changes
  // (see applyExpanded in createQueuePanel). The chevron is only visible
  // when the drawer is open, but the pill also reflects the expanded
  // state via aria-expanded so assistive tech stays in sync.
  chevron.setAttribute('title', 'Collapse');
  chevron.textContent = '‹';
  header.appendChild(chevron);
  return { header, chevron };
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
  style.textContent = FORJIS_TOKENS + QUEUE_PANEL_STYLE;
  root.appendChild(style);
  const { pill, count: pillCount } = buildPill();
  root.appendChild(pill);
  const drawer = document.createElement('div');
  drawer.className = 'queue-drawer';
  drawer.setAttribute('data-open', 'false');
  drawer.setAttribute('role', 'region');
  drawer.setAttribute('aria-label', 'Pin queue');
  const { header, chevron } = buildDrawerHeader();
  drawer.appendChild(header);
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
  return { root, pill, pillCount, drawer, chevron, list, submitBtn };
}

/**
 * Build the navigate / edit / remove control cluster for a single row.
 *
 * @param row - The row element the controls live inside.
 * @param pin - The pin the controls act on.
 * @param commentSpan - The span currently rendering the truncated comment.
 * @param onNavigate - Caller's navigate callback.
 * @returns The controls wrapper element.
 */
function buildRowControls(
  row: HTMLElement,
  pin: Pin,
  commentSpan: HTMLSpanElement,
  onNavigate: (pin: Pin) => void,
): HTMLElement {
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
  return controls;
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
  // textContent (not innerHTML) — pin.comment is user-supplied and may
  // contain HTML-like fragments; escape by inserting as a text node.
  commentSpan.textContent = truncateComment(pin.comment);
  commentSpan.addEventListener('click', () => {
    onNavigate(pin);
  });
  row.appendChild(commentSpan);
  row.appendChild(buildRowControls(row, pin, commentSpan, onNavigate));
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
 * Safely read the persisted collapsed flag. `sessionStorage` can throw in
 * private-browsing modes or when disabled by policy; in that case we fall
 * back to the collapsed default.
 *
 * When the key is absent or holds a non-"false" value the drawer starts
 * collapsed (matching the original first-load design). Only an explicit
 * "false" (= "was expanded last") rehydrates the expanded state.
 *
 * @returns `true` when the drawer should start collapsed, `false` otherwise.
 */
function readCollapsedFlag(): boolean {
  try {
    return window.sessionStorage.getItem(QUEUE_COLLAPSED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Persist the collapsed flag; swallows storage errors so the panel never
 * crashes on persistence trouble.
 *
 * @param collapsed - Whether the drawer is currently collapsed.
 */
function writeCollapsedFlag(collapsed: boolean): void {
  try {
    window.sessionStorage.setItem(
      QUEUE_COLLAPSED_STORAGE_KEY,
      collapsed ? 'true' : 'false',
    );
  } catch {
    /* no-op — storage disabled or quota-exceeded. */
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
  // Rehydrate the collapsed state from sessionStorage when present. No
  // stored value defaults to collapsed (= pill-only), matching the
  // first-load design. `readCollapsedFlag` returns `true` for collapsed.
  let expanded = !readCollapsedFlag();
  let destroyed = false;
  let lastFocused: Element | null = null;

  const applyExpanded = (): void => {
    dom.drawer.setAttribute('data-open', expanded ? 'true' : 'false');
    dom.pill.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    // Tooltip reflects the verb that activating each control will perform:
    // clicking the pill when collapsed expands the drawer; clicking the
    // chevron when expanded collapses it.
    dom.pill.setAttribute('title', expanded ? 'Collapse' : 'Expand');
    dom.chevron.setAttribute('title', expanded ? 'Collapse' : 'Expand');
    writeCollapsedFlag(!expanded);
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
  dom.chevron.addEventListener('click', (e) => {
    e.stopPropagation();
    collapse();
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
  applyExpanded();

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
