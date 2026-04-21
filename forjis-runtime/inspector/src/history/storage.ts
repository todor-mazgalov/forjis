/**
 * Narrow, typed `localStorage` facade used by the history-store singleton to
 * persist finalized-batch entries across panel close + reopen within one
 * `forjis dev` session.
 *
 * The facade (design.md §D-002) owns the fixed key
 * `"forjis-inspector:history"`, the `{ token, entries }` payload shape
 * (FR-011-026), the token-gate used by {@link readHistory}, the
 * oldest-first eviction loop enforced by {@link writeHistory} when the
 * serialized payload exceeds `HISTORY_STORE_MAX_BYTES`, and the
 * `try/catch` discipline that prevents `QuotaExceededError`, private-mode
 * Safari, or corrupt JSON from propagating through the history-store
 * public API. Every function in this module never throws.
 */

import type { Batch } from '@forjis/shared';

/** Fixed localStorage key under which the serialized payload is stored. */
export const HISTORY_STORAGE_KEY = 'forjis-inspector:history' as const;

/** Serialized payload byte-length cap; oldest entries are evicted above this. */
export const HISTORY_STORE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * One persisted record representing a single finalized batch's worth of
 * data observable to the sidebar.
 */
export interface HistoryEntry {
  /** Finalized batch snapshot captured at `batch.finalize` time. */
  readonly batch: Batch;
  /** Task directory path returned by the facilitator's `batch.finalize` frame. */
  readonly taskPath: string;
  /** Agent diff summary from `task.status.summary`, or `null` when unset. */
  readonly summary: string | null;
  /** ISO-8601 timestamp marking when the batch was finalized. */
  readonly finalizedAt: string;
}

/**
 * Exact JSON shape written to `localStorage`.
 *
 * `token` is the session token supplied to the history store's
 * `initHistoryStore`; `entries` is the list of {@link HistoryEntry}
 * values. No other fields are permitted (NFR-011-006 forbids auth tokens,
 * WebSocket URLs, cookies, and any `InspectorClient.options` field beyond
 * the explicit session token).
 */
export interface PersistedHistoryPayload {
  readonly token: string;
  readonly entries: HistoryEntry[];
}

/**
 * Narrow an unknown JSON value into a {@link PersistedHistoryPayload}.
 *
 * Returns `true` only when the value is an object with a non-empty string
 * `token` and an `entries` array. Entry-shape validation is deliberately
 * loose — the SDK trusts the token gate to reject foreign writes.
 *
 * @param value - Value returned by `JSON.parse`.
 * @returns `true` when `value` satisfies the payload contract.
 */
function isPersistedHistoryPayload(
  value: unknown,
): value is PersistedHistoryPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['token'] !== 'string' || record['token'].length === 0) {
    return false;
  }
  if (!Array.isArray(record['entries'])) {
    return false;
  }
  return true;
}

/**
 * Remove the storage key, swallowing any thrown exception (private-mode
 * Safari, disabled storage, etc.).
 */
export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    /* swallow: never propagate storage errors. */
  }
}

/**
 * Read and token-validate the persisted history payload.
 *
 * Returns an empty array when the key is absent, the JSON is malformed,
 * the parsed shape is invalid, or the stored `token` does not match
 * `currentToken`. On any rejection the stored key is also removed so the
 * next write starts clean (FR-011-026 discard-on-mismatch).
 *
 * @param currentToken - The session token supplied to the history store.
 * @returns Parsed `HistoryEntry[]` on success, empty array otherwise.
 */
export function readHistory(currentToken: string): HistoryEntry[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(HISTORY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearHistory();
    return [];
  }
  if (!isPersistedHistoryPayload(parsed)) {
    clearHistory();
    return [];
  }
  if (parsed.token !== currentToken) {
    clearHistory();
    return [];
  }
  return parsed.entries.slice();
}

/**
 * Return the oldest-entry index (lowest `finalizedAt`) so
 * {@link writeHistory} can evict in age order.
 *
 * @param entries - Candidate entries to search.
 * @returns Index of the oldest entry, or `-1` when empty.
 */
function findOldestIndex(entries: readonly HistoryEntry[]): number {
  if (entries.length === 0) {
    return -1;
  }
  let oldest = 0;
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].finalizedAt < entries[oldest].finalizedAt) {
      oldest = i;
    }
  }
  return oldest;
}

/**
 * Shrink `entries` until the serialized payload fits under the budget or
 * the list is empty. Returns the (possibly truncated) array plus its
 * serialized form for the caller's `setItem`.
 *
 * @param currentToken - Token branded onto the payload.
 * @param entries - Entries the caller wants to persist.
 * @returns The post-eviction entries array and its JSON serialization.
 */
function evictToFit(
  currentToken: string,
  entries: readonly HistoryEntry[],
): { surviving: HistoryEntry[]; serialized: string } {
  let surviving = entries.slice();
  let serialized = JSON.stringify({ token: currentToken, entries: surviving });
  while (serialized.length > HISTORY_STORE_MAX_BYTES && surviving.length > 0) {
    const oldest = findOldestIndex(surviving);
    if (oldest === -1) {
      break;
    }
    surviving.splice(oldest, 1);
    serialized = JSON.stringify({ token: currentToken, entries: surviving });
  }
  return { surviving, serialized };
}

/**
 * Stringify and persist `entries` under {@link HISTORY_STORAGE_KEY}.
 *
 * Before writing, the serialized payload's byte length is compared against
 * {@link HISTORY_STORE_MAX_BYTES}; oldest entries (lowest `finalizedAt`)
 * are evicted until the payload fits. The post-eviction array is returned
 * so the caller can adopt it and notify subscribers with the post-eviction
 * state (FR-011-028).
 *
 * Swallows `QuotaExceededError` and any other
 * `localStorage.setItem` exception (NFR-011-006 — the in-memory caller's
 * state-change remains authoritative even when persistence fails).
 *
 * @param currentToken - Session token to brand the payload with.
 * @param entries - Candidate history entries to persist.
 * @returns The (possibly-evicted) entries actually persisted.
 */
export function writeHistory(
  currentToken: string,
  entries: readonly HistoryEntry[],
): HistoryEntry[] {
  const { surviving, serialized } = evictToFit(currentToken, entries);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, serialized);
  } catch {
    /* swallow: never propagate storage errors. */
  }
  return surviving;
}
