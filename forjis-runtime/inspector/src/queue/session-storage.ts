/**
 * Narrow, typed sessionStorage facade used by the batch-state singleton to
 * persist the active `Batch` across SPA navigation and same-tab reloads.
 *
 * The facade (design.md §D-002) exists to keep the JSON contract in one
 * place — the module owns the fixed key `"forjis-inspector:batch"`, the
 * `{ token, batch }` payload shape (FR-010-013, NFR-010-002), and the
 * `try/catch` discipline that prevents `QuotaExceededError` or private-mode
 * Safari from propagating through BatchState's mutation APIs
 * (NFR-010-001). Every function never throws.
 */

import type { Batch } from '@forjis/shared';

/** Fixed sessionStorage key under which the serialized payload is stored. */
export const STORAGE_KEY = 'forjis-inspector:batch' as const;

/**
 * Exact JSON shape written to `sessionStorage`.
 *
 * `token` is the session token supplied to `initBatchState`; `batch` is the
 * full `Batch` value from `@forjis/shared`. No other fields are permitted
 * (NFR-010-002 forbids auth tokens, WebSocket URLs, cookies, and any
 * `InspectorClient.options` field beyond the explicit session token).
 */
export interface PersistedPayload {
  readonly token: string;
  readonly batch: Batch;
}

/**
 * Narrow an unknown JSON value into a {@link PersistedPayload}.
 *
 * Returns `true` only when the value is an object with exactly two
 * top-level keys (`token`, `batch`) where `token` is a non-empty string
 * and `batch` is an object with the expected `Batch` fields. Further
 * structural validation is deliberately loose — the SDK trusts the token
 * gate to reject foreign writes.
 *
 * @param value - Value returned by `JSON.parse`.
 * @returns `true` when `value` satisfies the payload contract.
 */
function isPersistedPayload(value: unknown): value is PersistedPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['token'] !== 'string' || record['token'].length === 0) {
    return false;
  }
  const batch = record['batch'];
  if (batch === null || typeof batch !== 'object') {
    return false;
  }
  const batchRecord = batch as Record<string, unknown>;
  if (typeof batchRecord['id'] !== 'string') {
    return false;
  }
  if (!Array.isArray(batchRecord['pins'])) {
    return false;
  }
  if (!Array.isArray(batchRecord['screens'])) {
    return false;
  }
  return true;
}

/**
 * Remove the storage key, swallowing any thrown exception (private-mode
 * Safari, disabled storage, etc.).
 */
export function clearBatch(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow: never propagate storage errors (NFR-010-001). */
  }
}

/**
 * Read and token-validate the persisted batch payload.
 *
 * Returns `null` when the key is absent, the JSON is malformed, the parsed
 * shape is invalid, or the stored `token` does not match
 * {@link currentToken}. On any rejection the stored key is also removed so
 * the next write starts clean (FR-010-010 discard-on-mismatch).
 *
 * @param currentToken - The session token supplied to `initBatchState`.
 * @returns Parsed `Batch` on success, `null` otherwise.
 */
export function readBatch(currentToken: string): Batch | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearBatch();
    return null;
  }
  if (!isPersistedPayload(parsed)) {
    clearBatch();
    return null;
  }
  if (parsed.token !== currentToken) {
    clearBatch();
    return null;
  }
  return parsed.batch;
}

/**
 * Stringify and persist `batch` under {@link STORAGE_KEY}.
 *
 * Swallows `QuotaExceededError` and any other `sessionStorage.setItem`
 * exception. The in-memory caller's state-change remains authoritative;
 * the reload restore path may lose the most recent batch on quota failure
 * but the running session is unaffected (NFR-010-001).
 *
 * @param currentToken - Session token to brand the payload with.
 * @param batch - Current `Batch` snapshot to persist.
 */
export function writeBatch(currentToken: string, batch: Batch): void {
  const payload: PersistedPayload = { token: currentToken, batch };
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('forjis-inspector: failed to serialize batch payload', err);
    return;
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, serialized);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('forjis-inspector: failed to persist batch payload', err);
  }
}
