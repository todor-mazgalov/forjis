/**
 * Inspector overlay mode state (session-backed) with a small subscribe API.
 *
 * Holds module-local `currentMode` + `listeners` mirroring the `currentHandle`
 * singleton pattern used in `mount.ts`. The mode persists across page reloads
 * via `sessionStorage` (key `"forjis-inspector:mode"`). Session-storage writes
 * are wrapped in try/catch because private-mode Safari may throw on quota.
 */

/** Permitted overlay mode values. */
export type InspectMode = 'inspect' | 'use';

/** Listener invoked synchronously on each mode change. */
export type ModeListener = (next: InspectMode) => void;

/** Disposer returned from {@link onModeChange}. */
export type Unsubscribe = () => void;

/** `sessionStorage` key used to persist the current mode per tab. */
const STORAGE_KEY = 'forjis-inspector:mode';

/** Default mode when no persisted value exists. */
const DEFAULT_MODE: InspectMode = 'use';

let currentMode: InspectMode | null = null;
const listeners: Set<ModeListener> = new Set();

/**
 * Read the stored mode from `sessionStorage` safely.
 *
 * @returns A valid {@link InspectMode} or {@link DEFAULT_MODE} when missing,
 *   unrecognised, or when `sessionStorage` access throws.
 */
function readStoredMode(): InspectMode {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === 'inspect' || raw === 'use') {
      return raw;
    }
  } catch {
    /* swallow: private-mode Safari / disabled storage */
  }
  return DEFAULT_MODE;
}

/**
 * Write the mode to `sessionStorage`, swallowing storage errors.
 *
 * @param next - Mode value to persist.
 */
function writeStoredMode(next: InspectMode): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* swallow: private-mode Safari / quota */
  }
}

/**
 * Return the currently-active overlay mode.
 *
 * Lazy-loads from `sessionStorage` on first call so test `beforeEach` hooks
 * that seed storage before `mount()` are honoured.
 *
 * @returns The active {@link InspectMode}.
 */
export function getMode(): InspectMode {
  if (currentMode === null) {
    currentMode = readStoredMode();
  }
  return currentMode;
}

/**
 * Set the active overlay mode.
 *
 * No-op when `next` equals the current mode. Otherwise persists to
 * `sessionStorage` and notifies every registered listener in insertion order.
 *
 * @param next - Mode to adopt.
 */
export function setMode(next: InspectMode): void {
  const current = getMode();
  if (next === current) {
    return;
  }
  currentMode = next;
  writeStoredMode(next);
  for (const fn of listeners) {
    fn(next);
  }
}

/**
 * Subscribe to mode-change events.
 *
 * @param fn - Listener invoked with the new mode each time it changes.
 * @returns An {@link Unsubscribe} that removes `fn` from the listener set.
 */
export function onModeChange(fn: ModeListener): Unsubscribe {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test-only escape hatch: reset module-local state.
 *
 * Not exported from the package barrel. Tests call this in `beforeEach` to
 * prevent cross-test bleed of the memoised `currentMode` cache.
 */
export function __resetModeForTests(): void {
  currentMode = null;
  listeners.clear();
}
