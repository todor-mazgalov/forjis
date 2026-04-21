/**
 * Factory for the persistent inspect-mode toggle button that sits in the
 * bottom-right of the viewport. The button is a native `<button>` so Tab /
 * Enter activation are handled by the platform.
 */

import { getMode, onModeChange, setMode, type Unsubscribe } from './mode.js';

/** Public handle returned by {@link createToggleButton}. */
export interface ToggleButtonHandle {
  /** The `<button>` element. Caller mounts it into the shadow root. */
  readonly element: HTMLButtonElement;
  /** Remove the click listener, unsubscribe, and detach the element. */
  destroy(): void;
}

/**
 * Reflect the current mode onto the button's attributes.
 *
 * @param btn - Button element to update.
 * @param mode - Mode to reflect. `"inspect"` sets `aria-pressed="true"` and
 *   `data-mode="inspect"`; `"use"` sets their falsy counterparts.
 */
function syncButtonState(btn: HTMLButtonElement, mode: 'inspect' | 'use'): void {
  btn.setAttribute('aria-pressed', mode === 'inspect' ? 'true' : 'false');
  btn.setAttribute('data-mode', mode);
}

/**
 * Build a fresh toggle button wired to the mode singleton.
 *
 * Clicking flips the mode via {@link setMode}; an {@link onModeChange}
 * subscription keeps `aria-pressed` and `data-mode` in sync. The returned
 * handle's `destroy` releases all listeners.
 *
 * @returns A {@link ToggleButtonHandle}.
 */
export function createToggleButton(): ToggleButtonHandle {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('data-forjis-role', 'toggle');
  element.setAttribute('aria-label', 'Toggle Forjis Inspector');
  // Inline magnifier SVG via textContent-safe construction: no host-derived data.
  element.textContent = 'Inspect';
  syncButtonState(element, getMode());

  const onClick = (): void => {
    setMode(getMode() === 'inspect' ? 'use' : 'inspect');
  };
  element.addEventListener('click', onClick);

  const unsubscribe: Unsubscribe = onModeChange((next) => {
    syncButtonState(element, next);
  });

  return {
    element,
    destroy() {
      element.removeEventListener('click', onClick);
      unsubscribe();
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    },
  };
}
