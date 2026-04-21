/**
 * Unit tests for `pick/region.ts`.
 *
 * Covers FR-010-014 (region PinTarget emission with document coords;
 * zero-movement pointerup is suppressed) and FR-010-033 scenarios 2-3
 * (tool active vs inactive gating).
 */

import { jest } from '@jest/globals';
import type { PinTarget } from '@forjis/shared';
import { initRegionPicker } from '../pick/region.js';
import { __resetModeForTests, setMode } from '../ui/mode.js';
import {
  __resetPickerToolForTests,
  setTool,
} from '../ui/picker-tool.js';

/**
 * Build a pointer-like event with the coordinates and dispatch target
 * needed by the region picker's math. jsdom lacks `PointerEvent`, so we
 * synthesize a bubbling `Event` and attach `clientX`/`clientY` via
 * `Object.defineProperty`.
 *
 * @param type - Event type.
 * @param x - Viewport x coord.
 * @param y - Viewport y coord.
 * @returns Configured event castable to `PointerEvent`.
 */
function makePointerEvent(type: string, x: number, y: number): PointerEvent {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clientX', { value: x, configurable: true });
  Object.defineProperty(evt, 'clientY', { value: y, configurable: true });
  Object.defineProperty(evt, 'pointerType', { value: 'mouse', configurable: true });
  return evt as unknown as PointerEvent;
}

describe('region-picker', () => {
  let shadowHost: HTMLDivElement;
  let shadow: ShadowRoot;
  let onRegionPick: jest.Mock;

  beforeEach(() => {
    __resetModeForTests();
    __resetPickerToolForTests();
    document.body.innerHTML = '';
    shadowHost = document.createElement('div');
    document.body.appendChild(shadowHost);
    shadow = shadowHost.attachShadow({ mode: 'open' });
    onRegionPick = jest.fn();
    // Reset scroll to 0/0 for deterministic document-coord math.
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  afterEach(() => {
    __resetModeForTests();
    __resetPickerToolForTests();
    document.body.innerHTML = '';
  });

  it('drag emits a region PinTarget with document-coord bbox (FR-010-014)', () => {
    setMode('inspect');
    setTool('region');
    Object.defineProperty(window, 'scrollX', { value: 100, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 200, configurable: true });
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: () => false,
      onRegionPick,
    });
    document.dispatchEvent(makePointerEvent('pointerdown', 10, 20));
    document.dispatchEvent(makePointerEvent('pointermove', 50, 80));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 80));
    expect(onRegionPick).toHaveBeenCalledTimes(1);
    const target: PinTarget = onRegionPick.mock.calls[0][0];
    expect(target.kind).toBe('region');
    expect(target.source).toBeNull();
    expect(target.selector).toBe('viewport-region');
    expect(target.componentName).toBeNull();
    expect(target.bbox).toEqual({ x: 10 + 100, y: 20 + 200, w: 40, h: 60 });
    handle.destroy();
  });

  it('zero-movement pointerup does not emit (FR-010-014 scenario 2)', () => {
    setMode('inspect');
    setTool('region');
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: () => false,
      onRegionPick,
    });
    document.dispatchEvent(makePointerEvent('pointerdown', 50, 50));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 50));
    expect(onRegionPick).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('region tool inactive → drag does not emit (FR-010-033 scenario 3)', () => {
    setMode('inspect');
    setTool('element');
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: () => false,
      onRegionPick,
    });
    document.dispatchEvent(makePointerEvent('pointerdown', 10, 10));
    document.dispatchEvent(makePointerEvent('pointermove', 50, 50));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 50));
    expect(onRegionPick).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('use mode → drag does not emit', () => {
    setMode('use');
    setTool('region');
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: () => false,
      onRegionPick,
    });
    document.dispatchEvent(makePointerEvent('pointerdown', 10, 10));
    document.dispatchEvent(makePointerEvent('pointermove', 50, 50));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 50));
    expect(onRegionPick).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('drag started on overlay-owned node is ignored', () => {
    setMode('inspect');
    setTool('region');
    const overlayEl = document.createElement('div');
    document.body.appendChild(overlayEl);
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: (n) => n === overlayEl,
      onRegionPick,
    });
    const pd = makePointerEvent('pointerdown', 10, 10);
    overlayEl.dispatchEvent(pd);
    document.dispatchEvent(makePointerEvent('pointermove', 50, 50));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 50));
    expect(onRegionPick).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('destroy is idempotent and removes listeners', () => {
    setMode('inspect');
    setTool('region');
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: () => false,
      onRegionPick,
    });
    handle.destroy();
    handle.destroy();
    document.dispatchEvent(makePointerEvent('pointerdown', 10, 10));
    document.dispatchEvent(makePointerEvent('pointermove', 50, 50));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 50));
    expect(onRegionPick).not.toHaveBeenCalled();
  });

  it('picker-tool default is element (FR-010-033 scenario 1)', () => {
    // No setTool call — defaults to element.
    setMode('inspect');
    const handle = initRegionPicker({
      shadow,
      isOverlayOwned: () => false,
      onRegionPick,
    });
    document.dispatchEvent(makePointerEvent('pointerdown', 10, 10));
    document.dispatchEvent(makePointerEvent('pointermove', 50, 50));
    document.dispatchEvent(makePointerEvent('pointerup', 50, 50));
    expect(onRegionPick).not.toHaveBeenCalled();
    handle.destroy();
  });
});
