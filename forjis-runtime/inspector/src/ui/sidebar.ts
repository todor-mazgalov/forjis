/**
 * Sidebar timeline factory (design.md §D-005, FR-011-013..018;
 * inspector-013 §D9 failure surface).
 *
 * A reverse-chronological list of finalized batches. Subscribes to the
 * history-store singleton and re-renders its list on every history
 * mutation (`pushBatch`, `updateSummary`, `updateStatus`). Each batch card
 * shows a status dot, pin count, up to two thumbnails, timestamp, and an
 * expand affordance that reveals per-pin rows with **Reply** controls.
 *
 * Collapse rail: a chevron button at the header collapses the sidebar
 * into a 28-px vertical rail that surfaces only the vertical "Finalized
 * batches" label + the chevron (pointing the other way). Expanded /
 * collapsed state persists for the session under
 * `sessionStorage['forjis-inspector:sidebar.collapsed']`.
 *
 * Failed batches (`batch.status === 'failed'`) render an inline failure
 * card: the existing `[data-status="failed"]` rule paints the red dot,
 * the summary text appears beneath the thumbnails, and two actions
 * surface — **Reply with hint** (opens the reply sheet in failure mode
 * with the summary forwarded via `onReply`'s failure fields) and
 * **View log** (anchors to the dashboard's `/tasks/<taskId>/events` page).
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
import { FORJIS_TOKENS } from './theme.js';

/**
 * Reply mode hinting whether the sidebar's reply action originates from a
 * normal per-pin Reply control (`normal`) or from the failure card's
 * **Reply with hint** button (`failure`).
 */
export type SidebarReplyMode = 'normal' | 'failure';

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
  /** `'failure'` when invoked from the failure card; `'normal'` otherwise. */
  readonly mode: SidebarReplyMode;
  /**
   * Failure summary surfaced on the batch (from `task.status.summary`).
   * Non-null only when `mode === 'failure'`. Same string as `summary`
   * when the inspector transport has delivered it; preserved on a
   * dedicated field so callers don't conflate the two.
   */
  readonly failureSummary: string | null;
  /**
   * Task directory path of the failed run. Non-null only when
   * `mode === 'failure'`. Forwarded to the clarifier's parent-context
   * payload via the reply sheet's submit callback.
   */
  readonly failedTaskPath: string | null;
}

/** Init options accepted by {@link createSidebar}. */
export interface InitSidebarOptions {
  /** Overlay shadow root. */
  readonly shadow: ShadowRoot;
  /** Invoked when the user activates a per-pin Reply control. */
  readonly onReply: (ctx: SidebarReplyContext) => void;
  /**
   * Invoked when the user activates **View log** on a failure card.
   * Supplied with the failed task directory path so the caller can build
   * an anchor href pointing at the dashboard's `/tasks/<taskId>/events`
   * route. Optional; omitted callers get a no-op link.
   */
  readonly onViewLog?: (ctx: SidebarViewLogContext) => void;
}

/** Context passed to the `onViewLog` callback. */
export interface SidebarViewLogContext {
  /** Historic batch whose task events should be opened. */
  readonly batch: Batch;
  /** Task path stored by the history store. */
  readonly taskPath: string;
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

/** SessionStorage key tracking the sidebar's collapsed state. */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'forjis-inspector:sidebar.collapsed';

/** Inline CSS for the sidebar — isolated inside the shadow root. */
const SIDEBAR_STYLE = `
aside[data-forjis-sidebar] {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  width: 280px;
  background: var(--bg-panel);
  color: var(--text);
  border-right: 1px solid var(--border);
  box-shadow: 2px 0 10px rgba(0,0,0,0.35);
  font: var(--text-base)/1.4 var(--font-sans);
  pointer-events: auto;
  z-index: 5;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  transition: width 120ms ease-out;
}
aside[data-forjis-sidebar][data-collapsed="true"] {
  width: 28px;
}
aside[data-forjis-sidebar][data-collapsed="true"] .sidebar-list,
aside[data-forjis-sidebar][data-collapsed="true"] .sidebar-header-title {
  display: none;
}
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px var(--space-4);
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--text);
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}
aside[data-forjis-sidebar][data-collapsed="true"] .sidebar-header {
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 0;
  background: transparent;
  height: 100%;
  justify-content: flex-start;
}
.sidebar-header-title {
  color: var(--text);
}
.sidebar-rail-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  color: var(--text-dim);
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  user-select: none;
  display: none;
}
aside[data-forjis-sidebar][data-collapsed="true"] .sidebar-rail-label {
  display: inline-block;
}
.sidebar-chevron {
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
.sidebar-chevron:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.sidebar-empty {
  color: var(--text-muted);
  padding: var(--space-4);
  text-align: center;
  font-style: italic;
}
.sidebar-batch-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sidebar-batch-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.sidebar-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.sidebar-status-dot[data-status="done"] { background: var(--accent); }
.sidebar-status-dot[data-status="running"] { background: var(--amber); }
.sidebar-status-dot[data-status="failed"] { background: var(--red); }
.sidebar-status-dot[data-status="finalized"] { background: var(--accent); }
.sidebar-pin-count {
  font-size: var(--text-sm);
  color: var(--text);
}
.sidebar-timestamp {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.sidebar-thumbnails {
  display: flex;
  gap: var(--space-1);
}
.sidebar-thumbnails img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.sidebar-batch-expand {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: var(--bg-sunken);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font: inherit;
  box-sizing: border-box;
}
.sidebar-batch-expand:hover { border-color: var(--border-strong); }
.sidebar-pin-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: 1px solid var(--border);
}
.sidebar-pin-row {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-1);
}
.sidebar-pin-row img {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.sidebar-pin-comment {
  font-size: var(--text-sm);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-pin-screen {
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.sidebar-pin-status {
  font-size: var(--text-2xs);
  color: var(--text-dim);
  text-transform: uppercase;
}
.sidebar-pin-reply {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  background: var(--accent);
  color: var(--bg-base);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  box-sizing: border-box;
}
.sidebar-pin-reply:hover { background: var(--accent-dim); border-color: var(--accent-dim); }
.sidebar-failure-summary {
  font-size: var(--text-sm);
  color: var(--text);
  background: rgba(239, 109, 109, 0.08);
  border: 1px solid rgba(239, 109, 109, 0.35);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.sidebar-failure-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.sidebar-failure-reply,
.sidebar-failure-log {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
  border-radius: var(--radius);
  cursor: pointer;
  font: inherit;
  box-sizing: border-box;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sidebar-failure-reply {
  background: var(--red);
  color: var(--bg-base);
  border: 1px solid var(--red);
  font-weight: 600;
}
.sidebar-failure-log {
  background: var(--bg-sunken);
  color: var(--text);
  border: 1px solid var(--border);
}
.sidebar-failure-log:hover { border-color: var(--border-strong); }
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
    border-bottom: 1px solid var(--border);
  }
  aside[data-forjis-sidebar][data-collapsed="true"] {
    width: auto;
    max-height: 28px;
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

/**
 * Build the anchor href for the "View log" action. Points at the
 * dashboard's events page for the failed task. Derived purely from the
 * stored `taskPath`'s basename so the rendering stays host-agnostic.
 *
 * @param taskPath - Task directory path (e.g. `.forjis/tasks/inspector-...`).
 * @returns Relative href suitable for an `<a>` element.
 */
function buildEventLogHref(taskPath: string): string {
  const parts = taskPath.split('/').filter((p) => p.length > 0);
  const basename = parts.length === 0 ? taskPath : parts[parts.length - 1];
  return '/tasks/' + basename + '/events';
}

/**
 * Build the failure-card body: summary paragraph plus two action buttons
 * ("Reply with hint" and "View log"). Appended under the thumbnails row
 * when `entry.batch.status === 'failed'`. Safe to call unconditionally —
 * the caller decides whether to insert the returned element.
 *
 * @param entry - History entry backing the card.
 * @param onReplyWithHint - Handler fired when Reply with hint is clicked.
 * @param onViewLog - Optional handler for the View log click.
 * @returns A container element holding the summary + action buttons.
 */
function buildFailureSection(
  entry: HistoryEntry,
  onReplyWithHint: () => void,
  onViewLog: ((ctx: SidebarViewLogContext) => void) | undefined,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sidebar-failure-wrap';
  wrap.setAttribute('data-forjis-failure-card', 'true');
  const summaryEl = document.createElement('div');
  summaryEl.className = 'sidebar-failure-summary';
  summaryEl.setAttribute('data-forjis-failure-summary', 'true');
  summaryEl.textContent = entry.summary ?? 'Task failed — no summary available.';
  wrap.appendChild(summaryEl);
  const actions = document.createElement('div');
  actions.className = 'sidebar-failure-actions';
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'sidebar-failure-reply';
  replyBtn.setAttribute('data-forjis-failure-reply', 'true');
  replyBtn.textContent = 'Reply with hint';
  replyBtn.addEventListener('click', onReplyWithHint);
  actions.appendChild(replyBtn);
  const logLink = document.createElement('a');
  logLink.className = 'sidebar-failure-log';
  logLink.setAttribute('data-forjis-failure-log', 'true');
  logLink.href = buildEventLogHref(entry.taskPath);
  logLink.target = '_blank';
  logLink.rel = 'noopener noreferrer';
  logLink.textContent = 'View log';
  logLink.addEventListener('click', () => {
    if (onViewLog) {
      onViewLog({ batch: entry.batch, taskPath: entry.taskPath });
    }
  });
  actions.appendChild(logLink);
  wrap.appendChild(actions);
  return wrap;
}

/** Build one batch-card DOM element (collapsed). */
function buildBatchCard(
  entry: HistoryEntry,
  expanded: boolean,
  onToggle: () => void,
  onReply: (pin: Pin) => void,
  onReplyWithHint: () => void,
  onViewLog: ((ctx: SidebarViewLogContext) => void) | undefined,
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
  if (entry.batch.status === 'failed') {
    card.appendChild(buildFailureSection(entry, onReplyWithHint, onViewLog));
  }
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

/**
 * Build the `onReply` payload for the failure-card **Reply with hint**
 * button. Uses the first pin in the batch as the reply anchor since the
 * failure is batch-scoped rather than pin-scoped.
 *
 * @param entry - History entry for the failed batch.
 * @returns A populated {@link SidebarReplyContext} in failure mode, or
 *          `null` when the batch carries no pins.
 */
function buildFailureReplyContext(
  entry: HistoryEntry,
): SidebarReplyContext | null {
  const anchor = entry.batch.pins[0];
  if (!anchor) {
    return null;
  }
  return {
    pin: anchor,
    batch: entry.batch,
    taskPath: entry.taskPath,
    summary: entry.summary,
    mode: 'failure',
    failureSummary: entry.summary,
    failedTaskPath: entry.taskPath,
  };
}

/** Render the sidebar's list body given the current history entries. */
function renderList(
  list: HTMLElement,
  entries: readonly HistoryEntry[],
  expandedIds: Set<string>,
  onToggle: (batchId: string) => void,
  onReply: (ctx: SidebarReplyContext) => void,
  onViewLog: ((ctx: SidebarViewLogContext) => void) | undefined,
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
          mode: 'normal',
          failureSummary: null,
          failedTaskPath: null,
        }),
      () => {
        const ctx = buildFailureReplyContext(entry);
        if (ctx) {
          onReply(ctx);
        }
      },
      onViewLog,
    );
    list.appendChild(card);
  }
}

/**
 * Safely read the persisted sidebar collapsed flag.
 *
 * The initial default is **collapsed** (inspector-025): an absent
 * sessionStorage entry returns `true` so a fresh page load does not
 * cover the host page's left ~280 px with the finalized-batches panel.
 * Only an explicit `"false"` (= "user expanded it in this session")
 * rehydrates the expanded state.
 *
 * @returns `true` when the sidebar should start collapsed.
 */
function readSidebarCollapsedFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Persist the sidebar collapsed flag; swallows storage errors.
 *
 * @param collapsed - Whether the sidebar is collapsed.
 */
function writeSidebarCollapsedFlag(collapsed: boolean): void {
  try {
    window.sessionStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? 'true' : 'false',
    );
  } catch {
    /* no-op — storage disabled or quota-exceeded. */
  }
}

/**
 * Build the header DOM for the sidebar (title, rail label, chevron).
 *
 * @returns Tuple with the header element, title span, and chevron button.
 */
function buildSidebarHeader(): {
  header: HTMLElement;
  title: HTMLElement;
  railLabel: HTMLElement;
  chevron: HTMLButtonElement;
} {
  const header = document.createElement('div');
  header.className = 'sidebar-header';
  const title = document.createElement('span');
  title.className = 'sidebar-header-title';
  title.textContent = 'Finalized batches';
  header.appendChild(title);
  const railLabel = document.createElement('span');
  railLabel.className = 'sidebar-rail-label';
  railLabel.textContent = 'Finalized batches';
  header.appendChild(railLabel);
  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'sidebar-chevron';
  chevron.setAttribute('data-forjis-sidebar-chevron', 'true');
  chevron.setAttribute('aria-label', 'Collapse sidebar');
  chevron.setAttribute('title', 'Collapse');
  chevron.textContent = '‹';
  header.appendChild(chevron);
  return { header, title, railLabel, chevron };
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
  style.textContent = FORJIS_TOKENS + SIDEBAR_STYLE;
  root.appendChild(style);
  const { header, chevron } = buildSidebarHeader();
  root.appendChild(header);
  const list = document.createElement('div');
  list.className = 'sidebar-list';
  list.setAttribute('data-forjis-sidebar-list', 'true');
  root.appendChild(list);
  opts.shadow.appendChild(root);
  const expandedIds: Set<string> = new Set();
  let destroyed = false;
  let collapsed = readSidebarCollapsedFlag();

  const applyCollapsedState = (): void => {
    root.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    chevron.textContent = collapsed ? '›' : '‹';
    chevron.setAttribute(
      'aria-label',
      collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    );
    // Hover tooltip mirrors aria-label so sighted + pointer users get the
    // same verb ("Expand" when collapsed, "Collapse" when expanded).
    chevron.setAttribute('title', collapsed ? 'Expand' : 'Collapse');
    writeSidebarCollapsedFlag(collapsed);
  };

  const toggleCollapsed = (): void => {
    collapsed = !collapsed;
    applyCollapsedState();
  };

  chevron.addEventListener('click', toggleCollapsed);

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
      opts.onViewLog,
    );
  };

  const listener: HistoryListener = (entries) => {
    rerender(entries);
  };
  const unsubscribe: Unsubscribe = subscribe(listener);
  rerender(getHistory());
  applyCollapsedState();

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
