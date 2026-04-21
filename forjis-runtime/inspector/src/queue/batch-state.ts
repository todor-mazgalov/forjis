/**
 * BatchState singleton: the inspector SDK's module-local cache of the
 * in-flight `Batch` (design.md §D-001, FR-010-001..008, FR-010-028..029).
 *
 * The module owns one `Batch | null` slot, a set of synchronous subscribers,
 * and a mirror to `sessionStorage` via the `session-storage` facade. Every
 * mutation (`addPin`, `updatePin`, `removePin`, `setStatus`, `clear`, plus
 * rehydration on `initBatchState`) notifies subscribers synchronously after
 * the state change and persists the fresh snapshot. Storage failures are
 * swallowed by the facade so in-memory mutations always take effect
 * (NFR-010-001).
 *
 * Lifecycle: `mount()` calls `initBatchState(token)` once after the
 * transport is constructed. Tests call `__resetBatchStateForTests()` in
 * `beforeEach` to reset the module cache AND the persisted key.
 */

import type { Batch, BatchStatus, Pin } from '@forjis/shared';
import {
  clearBatch as storageClearBatch,
  readBatch,
  writeBatch,
} from './session-storage.js';
import { generateUuid } from '../util/uuid.js';

/** Listener signature passed to {@link subscribe}. */
export type BatchListener = (batch: Batch | null) => void;

/** Disposer returned from {@link subscribe}. */
export type Unsubscribe = () => void;

let currentBatch: Batch | null = null;
let sessionToken: string | null = null;
const listeners: Set<BatchListener> = new Set();

/**
 * Notify every registered listener with the current batch snapshot.
 *
 * Listeners fire synchronously in insertion order after the caller has
 * finished mutating state. Errors thrown by a listener propagate out to
 * the caller; consumers are responsible for keeping their handlers
 * exception-free.
 */
function notify(): void {
  for (const fn of listeners) {
    fn(currentBatch);
  }
}

/**
 * Persist the current batch to `sessionStorage` when both a token and a
 * batch are present. No-op on either missing value; storage failures are
 * swallowed inside the facade.
 */
function persist(): void {
  if (sessionToken === null) {
    return;
  }
  if (currentBatch === null) {
    storageClearBatch();
    return;
  }
  writeBatch(sessionToken, currentBatch);
}

/**
 * Initialize the BatchState singleton. Called once by `mount()` after the
 * transport is constructed. Attempts to rehydrate the persisted batch via
 * the session-storage facade; on a matching-token hit the in-memory
 * singleton is set and subscribers are notified. On any other result
 * (absent, corrupt, mismatched) the singleton remains `null` and the
 * persisted key is removed by the facade.
 *
 * Idempotent: calling twice with the same token is safe; the second call
 * re-reads storage.
 *
 * @param token - Session token used to gate rehydration.
 */
export function initBatchState(token: string): void {
  sessionToken = token;
  const rehydrated = readBatch(token);
  if (rehydrated !== null) {
    currentBatch = rehydrated;
    notify();
  }
}

/**
 * Snapshot reader. Returns `null` until the first `addPin` or successful
 * rehydration.
 *
 * @returns The current `Batch` or `null`.
 */
export function getBatch(): Batch | null {
  return currentBatch;
}

/**
 * Construct a fresh `Batch` from the first pin supplied to
 * {@link addPin}. Applies the canonical defaults from FR-010-002:
 * `platform: "web"`, `parentBatchId: null`, `status: "queued"`,
 * `createdAt: new Date().toISOString()`, a freshly-generated v4 UUID, and
 * `screens` derived from `pin.screen` (empty array when `pin.screen` is
 * `null`).
 *
 * @param pin - The first pin appended to the new batch.
 * @returns A ready-to-persist `Batch`.
 */
function createBatchFromFirstPin(pin: Pin): Batch {
  return {
    id: generateUuid(),
    platform: 'web',
    screens: pin.screen === null ? [] : [pin.screen],
    pins: [pin],
    createdAt: new Date().toISOString(),
    parentBatchId: null,
    status: 'queued',
  };
}

/**
 * Append `pin` to the current batch (creating one lazily on the first
 * call when `getBatch() === null`). On subsequent calls `pin.screen` is
 * appended to `batch.screens` only when non-null and not already present.
 *
 * @param pin - Fully-built pin produced by the comment-sheet Send path.
 */
export function addPin(pin: Pin): void {
  if (currentBatch === null) {
    currentBatch = createBatchFromFirstPin(pin);
    notify();
    persist();
    return;
  }
  const nextPins = currentBatch.pins.slice();
  nextPins.push(pin);
  const nextScreens = currentBatch.screens.slice();
  if (pin.screen !== null && !nextScreens.includes(pin.screen)) {
    nextScreens.push(pin.screen);
  }
  currentBatch = { ...currentBatch, pins: nextPins, screens: nextScreens };
  notify();
  persist();
}

/**
 * Replace the pin matching `pinId` with a merged `{ ...orig, ...patch }`.
 * Position in the `pins` array is preserved. No-op on unknown id.
 *
 * @param pinId - Pin identifier to locate.
 * @param patch - Partial pin fields to overlay.
 */
export function updatePin(pinId: string, patch: Partial<Pin>): void {
  if (currentBatch === null) {
    return;
  }
  const idx = currentBatch.pins.findIndex((p) => p.id === pinId);
  if (idx === -1) {
    return;
  }
  const nextPins = currentBatch.pins.slice();
  nextPins[idx] = { ...nextPins[idx], ...patch } as Pin;
  currentBatch = { ...currentBatch, pins: nextPins };
  notify();
  persist();
}

/**
 * Remove the pin matching `pinId` from the current batch. Remaining pins
 * retain their relative order. `screens` is NOT re-derived. No-op on
 * unknown id or when no batch exists.
 *
 * @param pinId - Pin identifier to remove.
 */
export function removePin(pinId: string): void {
  if (currentBatch === null) {
    return;
  }
  const nextPins = currentBatch.pins.filter((p) => p.id !== pinId);
  if (nextPins.length === currentBatch.pins.length) {
    return;
  }
  currentBatch = { ...currentBatch, pins: nextPins };
  notify();
  persist();
}

/**
 * Assign `batch.status = next`. No-op when no batch exists.
 *
 * @param next - Target status.
 */
export function setStatus(next: BatchStatus): void {
  if (currentBatch === null) {
    return;
  }
  currentBatch = { ...currentBatch, status: next };
  notify();
  persist();
}

/**
 * Reset the singleton to `null` and remove the persisted sessionStorage
 * entry. Notifies subscribers with `null` (FR-010-007).
 */
export function clear(): void {
  currentBatch = null;
  storageClearBatch();
  notify();
}

/**
 * Subscribe to every batch mutation. Listeners fire synchronously after
 * the mutation has been applied to the singleton. Returns an unsubscribe
 * function that removes the listener.
 *
 * @param fn - Listener to register.
 * @returns Disposer.
 */
export function subscribe(fn: BatchListener): Unsubscribe {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test-only escape hatch: reset module-local state AND remove the
 * persisted sessionStorage key. Parallel to `__resetModeForTests` in
 * `ui/mode.ts`.
 */
export function __resetBatchStateForTests(): void {
  currentBatch = null;
  sessionToken = null;
  listeners.clear();
  storageClearBatch();
}
