/**
 * Sidebar timeline factory (design.md §D-005, FR-011-013..018).
 *
 * A reverse-chronological list of finalized batches. Subscribes to the
 * history-store singleton and re-renders its list on every history
 * mutation (`pushBatch`, `updateSummary`, `updateStatus`). Each batch card
 * shows a status dot, pin count, up to two thumbnails, timestamp, and an
 * expand affordance that reveals per-pin rows with **Reply** controls.
 *
 * Module boundaries (NFR-011-002): imports only `@forjis/shared` types and
 * `../history/history-store.js`. All outbound traffic flows through the
 * `onReply` callback supplied by the factory caller.
 */

import type { Batch, Pin } from '@forjis/shared';
import {
  getHistory,
  subscribe,
  type HistoryListener,
  type Unsubscribe,
} from '../history/history-store.js';
import type { HistoryEntry } from '../history/storage.js';

/** Context passed to the `onReply` callback. */
export interface SidebarReplyContext {
  /** Original pin being replied to. */
  readonly pin: Pin;
  /** Historic batch enclosing the pin. */
  readonly batch: Batch;
  /** Task path stored by the history store. */
  readonly taskPath: string;
  /** Agent diff summary, or `null` when unset. */
  readonly summary: string | null;
}

/** Init options accepted by {@link createSidebar}. */
export interface InitSidebarOptions {
  /** Overlay shadow root. */
  readonly shadow: ShadowRoot;
  /** Invoked when the user activates a per-pin Reply control. */
  readonly onReply: (ctx: SidebarReplyContext) => void;
}

/** Handle returned by {@link createSidebar}. */
export interface SidebarHandle {
  /** The sidebar root element (mounted inside the supplied shadow root). */
  readonly element: HTMLElement;
  /** Remove listeners and DOM. Idempotent. */
  destroy(): void;
}

/** Max characters rendered per per-pin row comment excerpt before ellipsis. */
const COMMENT_MAX_LEN = 80;

/** Inline CSS for the sidebar — isolated inside the shadow root. */
const SIDEBAR_STYLE = `
aside[data-forjis-sidebar] {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  width: 280px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  box-shadow: 2px 0 10px rgba(0,0,0,0.05);
  font: 13px/1.4 system-ui, -apple-system, sans-serif;
  color: #111827;
  pointer-events: auto;
  z-index: 5;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}
.sidebar-header {
  padding: 10px 12px;
  font-weight: 600;
  font-size: 12px;
  color: #374151;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sidebar-empty {
  color: #6b7280;
  padding: 12px;
  text-align: center;
  font-style: italic;
}
.sidebar-batch-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f9fafb;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sidebar-batch-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sidebar-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #9ca3af;
  flex-shrink: 0;
}
.sidebar-status-dot[data-status="done"] { background: #22c55e; }
.sidebar-status-dot[data-status="running"] { background: #f59e0b; }
.sidebar-status-dot[data-status="failed"] { background: #ef4444; }
.sidebar-status-dot[data-status="finalized"] { background: #2563eb; }
.sidebar-pin-count {
  font-size: 12px;
  color: #374151;
}
.sidebar-timestamp {
  margin-left: auto;
  font-size: 11px;
  color: #6b7280;
}
.sidebar-thumbnails {
  display: flex;
  gap: 4px;
}
.sidebar-thumbnails img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  background: #e5e7eb;
}
.sidebar-batch-expand {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  box-sizing: border-box;
}
.sidebar-pin-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid #e5e7eb;
}
.sidebar-pin-row {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 4px;
}
.sidebar-pin-row img {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  background: #e5e7eb;
}
.sidebar-pin-comment {
  font-size: 12px;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-pin-screen {
  font-size: 11px;
  color: #6b7280;
}
.sidebar-pin-status {
  font-size: 10px;
  color: #4b5563;
  text-transform: uppercase;
}
.sidebar-pin-reply {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: #2563eb;
  color: #ffffff;
  border: 1px solid #1d4ed8;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  box-sizing: border-box;
}
@media (max-width: 767.98px) {
  aside[data-forjis-sidebar] {
    top: 0;
    left: 0;
    right: 0;
    bottom: auto;
    width: auto;
    height: auto;
    max-height: 40vh;
    border-right: 0;
    border-bottom: 1px solid #e5e7eb;
  }
}
`;

/** Truncate a comment string to {@link COMMENT_MAX_LEN} characters. */
function truncate(raw: string): string {
  if (raw.length <= COMMENT_MAX_LEN) {
    return raw;
  }
  return raw.slice(0, COMMENT_MAX_LEN - 1) + '…';
}

/** Build one per-pin row DOM element. */
function buildPinRow(
  pin: Pin,
  batchStatusText: string,
  onReplyClick: () => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sidebar-pin-row';
  row.setAttribute('data-pin-id', pin.id);
  const img = document.createElement('img');
  img.src = pin.capture.elementScreenshot;
  img.alt = 'Pin thumbnail';
  row.appendChild(img);
  const textCol = document.createElement('div');
  const commentEl = document.createElement('div');
  commentEl.className = 'sidebar-pin-comment';
  commentEl.textContent = truncate(pin.comment);
  const screenEl = document.createElement('div');
  screenEl.className = 'sidebar-pin-screen';
  screenEl.textContent = pin.screen ?? '(no screen)';
  const statusEl = document.createElement('div');
  statusEl.className = 'sidebar-pin-status';
  statusEl.textContent = batchStatusText;
  textCol.appendChild(commentEl);
  textCol.appendChild(screenEl);
  textCol.appendChild(statusEl);
  row.appendChild(textCol);
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'sidebar-pin-reply';
  replyBtn.setAttribute('data-forjis-sidebar-reply', 'true');
  replyBtn.textContent = 'Reply';
  replyBtn.addEventListener('click', onReplyClick);
  row.appendChild(replyBtn);
  return row;
}

/** Build one batch-card DOM element (collapsed). */
function buildBatchCard(
  entry: HistoryEntry,
  expanded: boolean,
  onToggle: () => void,
  onReply: (pin: Pin) => void,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sidebar-batch-card';
  card.setAttribute('data-batch-id', entry.batch.id);
  const head = document.createElement('div');
  head.className = 'sidebar-batch-head';
  const dot = document.createElement('span');
  dot.className = 'sidebar-status-dot';
  dot.setAttribute('data-status', entry.batch.status);
  head.appendChild(dot);
  const countEl = document.createElement('span');
  countEl.className = 'sidebar-pin-count';
  countEl.textContent = String(entry.batch.pins.length) + ' pins';
  head.appendChild(countEl);
  const tsEl = document.createElement('span');
  tsEl.className = 'sidebar-timestamp';
  tsEl.textContent = entry.finalizedAt;
  head.appendChild(tsEl);
  card.appendChild(head);
  const thumbsWrap = document.createElement('div');
  thumbsWrap.className = 'sidebar-thumbnails';
  const thumbCount = Math.min(2, entry.batch.pins.length);
  for (let i = 0; i < thumbCount; i += 1) {
    const img = document.createElement('img');
    img.src = entry.batch.pins[i].capture.elementScreenshot;
    img.alt = 'Pin thumbnail';
    thumbsWrap.appendChild(img);
  }
  card.appendChild(thumbsWrap);
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'sidebar-batch-expand';
  expandBtn.textContent = expanded ? 'Collapse' : 'Expand';
  expandBtn.addEventListener('click', onToggle);
  card.appendChild(expandBtn);
  if (expanded) {
    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'sidebar-pin-rows';
    for (const pin of entry.batch.pins) {
      rowsWrap.appendChild(
        buildPinRow(pin, entry.batch.status, () => onReply(pin)),
      );
    }
    card.appendChild(rowsWrap);
  }
  return card;
}

/** Sort entries newest-first by `finalizedAt`. */
function sortNewestFirst(
  entries: readonly HistoryEntry[],
): HistoryEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.finalizedAt > b.finalizedAt) {
      return -1;
    }
    if (a.finalizedAt < b.finalizedAt) {
      return 1;
    }
    return 0;
  });
}

/** Render the sidebar's list body given the current history entries. */
function renderList(
  list: HTMLElement,
  entries: readonly HistoryEntry[],
  expandedIds: Set<string>,
  onToggle: (batchId: string) => void,
  onReply: (ctx: SidebarReplyContext) => void,
): void {
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No finalized batches yet.';
    list.appendChild(empty);
    return;
  }
  const sorted = sortNewestFirst(entries);
  for (const entry of sorted) {
    const expanded = expandedIds.has(entry.batch.id);
    const card = buildBatchCard(
      entry,
      expanded,
      () => onToggle(entry.batch.id),
      (pin) =>
        onReply({
          pin,
          batch: entry.batch,
          taskPath: entry.taskPath,
          summary: entry.summary,
        }),
    );
    list.appendChild(card);
  }
}

/**
 * Build a sidebar, mount it into `opts.shadow`, and subscribe to history
 * mutations.
 *
 * @param opts - Init options.
 * @returns A {@link SidebarHandle}.
 */
export function createSidebar(opts: InitSidebarOptions): SidebarHandle {
  const root = document.createElement('aside');
  root.setAttribute('data-forjis-sidebar', 'true');
  const style = document.createElement('style');
  style.textContent = SIDEBAR_STYLE;
  root.appendChild(style);
  const header = document.createElement('div');
  header.className = 'sidebar-header';
  header.textContent = 'Finalized batches';
  root.appendChild(header);
  const list = document.createElement('div');
  list.className = 'sidebar-list';
  list.setAttribute('data-forjis-sidebar-list', 'true');
  root.appendChild(list);
  opts.shadow.appendChild(root);
  const expandedIds: Set<string> = new Set();
  let destroyed = false;

  const rerender = (entries: readonly HistoryEntry[]): void => {
    renderList(
      list,
      entries,
      expandedIds,
      (batchId) => {
        if (expandedIds.has(batchId)) {
          expandedIds.delete(batchId);
        } else {
          expandedIds.add(batchId);
        }
        rerender(getHistory());
      },
      opts.onReply,
    );
  };

  const listener: HistoryListener = (entries) => {
    rerender(entries);
  };
  const unsubscribe: Unsubscribe = subscribe(listener);
  rerender(getHistory());

  return {
    element: root,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      unsubscribe();
      if (root.parentNode) {
        root.parentNode.removeChild(root);
      }
    },
  };
}
