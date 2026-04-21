/**
 * Free-function alias for `handle.unmount()`.
 *
 * This entry point exists so the Vite plugin's injected teardown snippet can
 * call `unmount()` by name without holding a handle reference. It simply
 * delegates to the currently-active mount handle, or does nothing when no
 * mount is live.
 */

import { getCurrentHandle } from './mount.js';

/**
 * Tear down the active Inspector mount, if any.
 *
 * No-op when {@link mount} has not been called, or when the previous handle
 * has already been unmounted. Never throws — the Vite plugin's injected
 * teardown must be safe on pages where `mount()` never ran (for example, a
 * 404 page) so a global `unmount()` call cannot produce an unhandled error.
 */
export function unmount(): void {
  const handle = getCurrentHandle();
  if (handle === null) {
    return;
  }
  handle.unmount();
}
