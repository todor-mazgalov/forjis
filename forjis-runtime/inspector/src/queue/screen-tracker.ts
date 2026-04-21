/**
 * Screen tracker singleton: mirrors `window.location.pathname` across SPA
 * navigation so `pipeline.buildPin` can record the route the user was on
 * at pick-confirm time (design.md §D-010, FR-010-030, FR-010-031).
 *
 * Patches `history.pushState` / `history.replaceState` to delegate via
 * `.apply` into the captured originals and then refresh the module-local
 * cache. Listens on `popstate` for browser-history navigation. The
 * `destroyScreenTracker` path restores the original function references
 * so the next `initScreenTracker` starts from a clean slate (R-002
 * mitigation).
 */

let currentScreen: string | null = null;
let initialized = false;

type HistoryStateFn = (
  data: unknown,
  unused: string,
  url?: string | URL | null,
) => void;

let origPushState: HistoryStateFn | null = null;
let origReplaceState: HistoryStateFn | null = null;
let popstateListener: ((ev: Event) => void) | null = null;

/**
 * Refresh the cached screen from `window.location.pathname`. Called after
 * the original `history.pushState` / `replaceState` delegate and on
 * `popstate`.
 */
function refreshFromLocation(): void {
  currentScreen = window.location.pathname;
}

/**
 * Install the `history.pushState` / `replaceState` wrappers and the
 * `popstate` listener. Idempotent — a second call is a no-op so callers
 * can guard-mount during tests without re-patching.
 */
export function initScreenTracker(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  // Capture the raw function references BEFORE any assignment so destroy
  // can restore exactly the same function identity the host app may have
  // already captured. Do NOT bind — binding produces a new function
  // identity and defeats the restore path.
  origPushState = history.pushState as HistoryStateFn;
  origReplaceState = history.replaceState as HistoryStateFn;
  const capturedPush = origPushState;
  const capturedReplace = origReplaceState;
  currentScreen = window.location.pathname;

  const pushWrapper = function patchedPushState(
    this: History,
    ...args: Parameters<HistoryStateFn>
  ): void {
    capturedPush.apply(this, args);
    refreshFromLocation();
  };
  const replaceWrapper = function patchedReplaceState(
    this: History,
    ...args: Parameters<HistoryStateFn>
  ): void {
    capturedReplace.apply(this, args);
    refreshFromLocation();
  };
  // Cast through `unknown` — `History.pushState` is typed as `History["pushState"]`
  // whose parameter tuple uses named params; the wrappers' `...args` rest
  // fulfills the same shape structurally.
  (history as unknown as { pushState: HistoryStateFn }).pushState = pushWrapper;
  (history as unknown as { replaceState: HistoryStateFn }).replaceState =
    replaceWrapper;

  const listener = (): void => {
    refreshFromLocation();
  };
  popstateListener = listener;
  window.addEventListener('popstate', listener);
}

/**
 * Read the cached screen. Lazy-initializes from `window.location.pathname`
 * when the tracker has never been installed (defensive fallback used by
 * `pipeline.buildPin` in test environments — FR-010-031).
 *
 * @returns The current screen pathname or `null` when uninitialized and
 *   the caller wants the pipeline's explicit fallback path.
 */
export function getCurrentScreen(): string | null {
  if (!initialized && currentScreen === null) {
    return null;
  }
  return currentScreen;
}

/**
 * Restore the original `history.pushState` / `replaceState` and remove
 * the `popstate` listener. Safe to call repeatedly; subsequent calls
 * before a re-init are no-ops.
 */
export function destroyScreenTracker(): void {
  if (!initialized) {
    return;
  }
  if (origPushState) {
    (history as unknown as { pushState: HistoryStateFn }).pushState =
      origPushState;
  }
  if (origReplaceState) {
    (history as unknown as { replaceState: HistoryStateFn }).replaceState =
      origReplaceState;
  }
  if (popstateListener) {
    window.removeEventListener('popstate', popstateListener);
    popstateListener = null;
  }
  origPushState = null;
  origReplaceState = null;
  initialized = false;
  currentScreen = null;
}

/**
 * Test-only escape hatch. Parallel to `__resetModeForTests`. Restores the
 * patched history methods and clears the cached screen so tests can
 * re-init cleanly.
 */
export function __resetScreenTrackerForTests(): void {
  destroyScreenTracker();
  currentScreen = null;
}
