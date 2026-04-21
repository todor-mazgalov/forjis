/**
 * History-store singleton: the inspector SDK's module-local cache of every
 * finalized batch observable to the sidebar (design.md §D-002, FR-011-025
 * through FR-011-029).
 *
 * The module owns a `HistoryEntry[]` slot, a set of synchronous subscribers,
 * and a mirror to `localStorage` via {@link writeHistory} / {@link readHistory}.
 * Every mutation (`pushBatch`, `updateSummary`, `updateStatus`, plus
 * rehydration on `initHistoryStore`) notifies subscribers synchronously
 * after the state change and persists the fresh snapshot. Storage failures
 * are swallowed by the facade so in-memory mutations always take effect
 * (NFR-011-006).
 *
 * Lifecycle: `mount()` calls `initHistoryStore(token)` once after the
 * transport is constructed. Tests call `__resetHistoryStoreForTests()` in
 * `beforeEach` to reset the module cache AND the persisted key.
 */

import type { Batch, BatchStatus } from '@forjis/shared';
import {
  clearHistory,
  readHistory,
  writeHistory,
  type HistoryEntry,
} from './storage.js';

/** Listener signature passed to {@link subscribe}. */
export type HistoryListener = (history: readonly HistoryEntry[]) => void;

/** Disposer returned from {@link subscribe}. */
export type Unsubscribe = () => void;

let entries: HistoryEntry[] = [];
let sessionToken: string | null = null;
const listeners: Set<HistoryListener> = new Set();

/**
 * Notify every registered listener with the current entries snapshot.
 *
 * Listeners fire synchronously in insertion order after the caller has
 * finished mutating state. Each listener receives a fresh shallow copy so
 * downstream consumers cannot mutate the singleton's internal buffer.
 */
function notify(): void {
  const snapshot = entries.slice();
  for (const fn of listeners) {
    fn(snapshot);
  }
}

/**
 * Persist the current entries to `localStorage`, adopting the post-eviction
 * list returned by the storage facade when eviction shortened it. No-op
 * while no session token is set (before `initHistoryStore`).
 */
function persist(): void {
  if (sessionToken === null) {
    return;
  }
  const surviving = writeHistory(sessionToken, entries);
  if (surviving.length !== entries.length) {
    entries = surviving;
  }
}

/**
 * Initialize the history-store singleton. Called once by `mount()` after
 * the transport is constructed. Reads the persisted payload under the
 * token gate; on a matching-token hit the in-memory singleton adopts the
 * persisted entries. On any other result (absent, corrupt, mismatched) the
 * singleton remains empty and the persisted key is removed by the facade.
 *
 * Idempotent: calling twice with the same token is safe; the second call
 * re-reads storage.
 *
 * @param token - Session token used to gate rehydration.
 */
export function initHistoryStore(token: string): void {
  sessionToken = token;
  entries = readHistory(token);
  notify();
}

/**
 * Snapshot reader. Returns the in-memory entries as a readonly array.
 *
 * @returns The current `HistoryEntry[]` view.
 */
export function getHistory(): readonly HistoryEntry[] {
  return entries;
}

/**
 * Append (or replace-in-place) a finalized batch entry.
 *
 * When `batch.id` already exists in the list, the entry is updated in
 * place — the replacement overwrites `batch`, `taskPath`, and
 * `finalizedAt`, but preserves the existing `summary` (FR-011-027). When
 * the id is new, the entry is appended.
 *
 * After the in-memory mutation, the facade persists and may evict oldest
 * entries so the payload fits under `HISTORY_STORE_MAX_BYTES`; subscribers
 * are notified with the post-eviction list.
 *
 * @param batch - Snapshot of the finalized batch.
 * @param taskPath - Task directory path from `batch.finalize.taskPath`.
 * @param finalizedAt - ISO timestamp; defaults to `new Date().toISOString()`.
 */
export function pushBatch(
  batch: Batch,
  taskPath: string,
  finalizedAt?: string,
): void {
  const stamp = finalizedAt ?? new Date().toISOString();
  const existingIdx = entries.findIndex((e) => e.batch.id === batch.id);
  if (existingIdx >= 0) {
    const prev = entries[existingIdx];
    const next: HistoryEntry = {
      batch,
      taskPath,
      summary: prev.summary,
      finalizedAt: stamp,
    };
    entries = entries.slice();
    entries[existingIdx] = next;
  } else {
    const entry: HistoryEntry = {
      batch,
      taskPath,
      summary: null,
      finalizedAt: stamp,
    };
    entries = entries.concat([entry]);
  }
  persist();
  notify();
}

/**
 * Locate the entry by `batch.id` and set its `summary`. No-op on unknown
 * id.
 *
 * @param batchId - Batch identifier to match.
 * @param summary - Agent diff summary string.
 */
export function updateSummary(batchId: string, summary: string): void {
  const idx = entries.findIndex((e) => e.batch.id === batchId);
  if (idx < 0) {
    return;
  }
  const next: HistoryEntry = { ...entries[idx], summary };
  entries = entries.slice();
  entries[idx] = next;
  persist();
  notify();
}

/**
 * Locate the entry by `batch.id` and set its `batch.status`. No-op on
 * unknown id.
 *
 * @param batchId - Batch identifier to match.
 * @param status - Replacement status.
 */
export function updateStatus(batchId: string, status: BatchStatus): void {
  const idx = entries.findIndex((e) => e.batch.id === batchId);
  if (idx < 0) {
    return;
  }
  const prev = entries[idx];
  const nextBatch: Batch = { ...prev.batch, status };
  const next: HistoryEntry = { ...prev, batch: nextBatch };
  entries = entries.slice();
  entries[idx] = next;
  persist();
  notify();
}

/**
 * Subscribe to every history mutation. Listeners fire synchronously after
 * the mutation has been applied to the singleton. Returns an unsubscribe
 * function that removes the listener.
 *
 * @param fn - Listener to register.
 * @returns Disposer.
 */
export function subscribe(fn: HistoryListener): Unsubscribe {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test-only escape hatch: reset module-local state AND remove the
 * persisted localStorage key. Parallel to `__resetBatchStateForTests` in
 * `queue/batch-state.ts`.
 */
export function __resetHistoryStoreForTests(): void {
  entries = [];
  sessionToken = null;
  listeners.clear();
  clearHistory();
}
