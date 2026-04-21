/**
 * Factory for the inspect-mode toggle + picker-tool segmented control.
 *
 * Layout: a container `<div>` with three buttons — one inspect ON/OFF
 * switch plus two tool segments (Element / Region). The tool segments
 * are hidden while inspect is OFF. Each button is a native `<button>`
 * for keyboard accessibility.
 *
 * design.md §D-004, FR-010-033.
 */

import { getMode, onModeChange, setMode, type Unsubscribe } from './mode.js';
import {
  getTool,
  onToolChange,
  setTool,
  type PickerTool,
} from './picker-tool.js';

/** Public handle returned by {@link createToggleButton}. */
export interface ToggleButtonHandle {
  /** The segmented-control container. Caller mounts it into the shadow root. */
  readonly element: HTMLElement;
  /** Remove listeners, unsubscribe, and detach the element. */
  destroy(): void;
}

/**
 * Reflect the current mode onto the inspect toggle button.
 *
 * @param btn - Inspect toggle button.
 * @param mode - Active mode.
 */
function syncInspectButton(btn: HTMLButtonElement, mode: 'inspect' | 'use'): void {
  btn.setAttribute('aria-pressed', mode === 'inspect' ? 'true' : 'false');
  btn.setAttribute('data-mode', mode);
}

/**
 * Reflect the active tool onto both tool segments and show/hide the
 * segments based on whether inspect is ON.
 *
 * @param elementBtn - Element tool segment.
 * @param regionBtn - Region tool segment.
 * @param tool - Active picker tool.
 * @param mode - Active inspect mode (used to toggle visibility).
 */
function syncToolButtons(
  elementBtn: HTMLButtonElement,
  regionBtn: HTMLButtonElement,
  tool: PickerTool,
  mode: 'inspect' | 'use',
): void {
  elementBtn.setAttribute('aria-pressed', tool === 'element' ? 'true' : 'false');
  elementBtn.setAttribute('data-active', tool === 'element' ? 'true' : 'false');
  regionBtn.setAttribute('aria-pressed', tool === 'region' ? 'true' : 'false');
  regionBtn.setAttribute('data-active', tool === 'region' ? 'true' : 'false');
  const visible = mode === 'inspect';
  elementBtn.setAttribute('data-visible', visible ? 'true' : 'false');
  regionBtn.setAttribute('data-visible', visible ? 'true' : 'false');
}

/**
 * Build the toggle + segmented-control DOM.
 *
 * @returns A tuple of (container, inspect button, element-tool button,
 *   region-tool button).
 */
function buildDom(): {
  container: HTMLElement;
  inspectBtn: HTMLButtonElement;
  elementBtn: HTMLButtonElement;
  regionBtn: HTMLButtonElement;
} {
  const container = document.createElement('div');
  container.setAttribute('data-forjis-role', 'toggle-container');
  const inspectBtn = document.createElement('button');
  inspectBtn.type = 'button';
  inspectBtn.setAttribute('data-forjis-role', 'toggle');
  inspectBtn.setAttribute('aria-label', 'Toggle Forjis Inspector');
  inspectBtn.textContent = 'Inspect';
  const elementBtn = document.createElement('button');
  elementBtn.type = 'button';
  elementBtn.setAttribute('data-forjis-role', 'tool-element');
  elementBtn.setAttribute('aria-label', 'Pick by element');
  elementBtn.textContent = 'Element';
  const regionBtn = document.createElement('button');
  regionBtn.type = 'button';
  regionBtn.setAttribute('data-forjis-role', 'tool-region');
  regionBtn.setAttribute('aria-label', 'Pick by region');
  regionBtn.textContent = 'Region';
  container.appendChild(inspectBtn);
  container.appendChild(elementBtn);
  container.appendChild(regionBtn);
  return { container, inspectBtn, elementBtn, regionBtn };
}

/**
 * Build a fresh toggle button wired to the mode and picker-tool
 * singletons.
 *
 * @returns A {@link ToggleButtonHandle}.
 */
export function createToggleButton(): ToggleButtonHandle {
  const { container, inspectBtn, elementBtn, regionBtn } = buildDom();
  syncInspectButton(inspectBtn, getMode());
  syncToolButtons(elementBtn, regionBtn, getTool(), getMode());

  const onInspectClick = (): void => {
    setMode(getMode() === 'inspect' ? 'use' : 'inspect');
  };
  const onElementClick = (): void => {
    setTool('element');
  };
  const onRegionClick = (): void => {
    setTool('region');
  };
  inspectBtn.addEventListener('click', onInspectClick);
  elementBtn.addEventListener('click', onElementClick);
  regionBtn.addEventListener('click', onRegionClick);

  const modeUnsub: Unsubscribe = onModeChange((next) => {
    syncInspectButton(inspectBtn, next);
    syncToolButtons(elementBtn, regionBtn, getTool(), next);
  });
  const toolUnsub: Unsubscribe = onToolChange((next) => {
    syncToolButtons(elementBtn, regionBtn, next, getMode());
  });

  return {
    element: container,
    destroy() {
      inspectBtn.removeEventListener('click', onInspectClick);
      elementBtn.removeEventListener('click', onElementClick);
      regionBtn.removeEventListener('click', onRegionClick);
      modeUnsub();
      toolUnsub();
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    },
  };
}
