/**
 * Shared "hide the inspector overlay during a screenshot" helper.
 *
 * Both element and viewport capture wrap the screenshot-library call in a
 * `visibility: hidden` toggle on `#forjis-inspector-root` and an rAF tick so
 * that any in-flight paint has committed before traversal begins. The toggle
 * is belt-and-braces protection layered on top of the library's `filter`
 * predicate (see `design.md` §D-002 and `specs/inspector-sdk/spec.md`
 * FR-009-009). `visibility: hidden` is chosen over `display: none` because it
 * preserves layout — the overlay host is fixed-position with
 * `pointer-events: none`, so removing it from the layout tree risks a reflow
 * that would shift the target element's bounding rect.
 */

/** `id` of the inspector's shadow-host root element in `document.body`. */
export const OVERLAY_ROOT_ID = 'forjis-inspector-root';

/**
 * Resolve the overlay root element or return `null` when the inspector is not
 * mounted. Pure DOM read; no listeners, no mutations.
 *
 * @returns The `#forjis-inspector-root` element or `null`.
 */
export function getOverlayRoot(): HTMLElement | null {
  return document.getElementById(OVERLAY_ROOT_ID);
}

/**
 * Resolve a Promise on the next animation frame; falls back to `setTimeout(0)`
 * when `requestAnimationFrame` is unavailable (jsdom without RAF polyfill).
 *
 * @returns Promise that settles on the next frame tick.
 */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Run `task` with the inspector overlay temporarily hidden.
 *
 * The prior `visibility` value is captured before mutation and restored in a
 * `finally` block so a thrown `task` never leaves the overlay in an
 * inconsistent visual state (FR-009-009's "Visibility restored after failure"
 * scenario). When the overlay root is absent the task runs unmodified.
 *
 * @param task - Async callback to execute while the overlay is hidden.
 * @returns Whatever `task` resolves to.
 */
export async function withOverlayHidden<T>(task: () => Promise<T>): Promise<T> {
  const overlayRoot = getOverlayRoot();
  if (!overlayRoot) {
    return task();
  }
  const prev = overlayRoot.style.visibility;
  overlayRoot.style.visibility = 'hidden';
  try {
    await nextFrame();
    return await task();
  } finally {
    overlayRoot.style.visibility = prev;
  }
}

/**
 * Predicate passed to `modern-screenshot`'s `filter` option: returns `true`
 * for every node except the inspector's overlay root. Suitable for inclusion
 * filters where `true` keeps the node in traversal.
 *
 * @returns Function that returns `false` only for the overlay root, `true`
 *   otherwise.
 */
export function buildOverlayFilter(): (node: Node) => boolean {
  const overlayRoot = getOverlayRoot();
  return (node) => node !== overlayRoot;
}
