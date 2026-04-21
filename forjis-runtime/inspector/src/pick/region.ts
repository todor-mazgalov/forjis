/**
 * Region picker (design.md §D-005, FR-010-014, FR-010-033).
 *
 * Attaches document-level `pointerdown` / `pointermove` / `pointerup`
 * listeners with `capture: true`. Gates on inspect mode × region tool.
 * Ignores overlay-owned pointers via the injected `isOverlayOwned`
 * predicate. Renders a visual drag rectangle inside the overlay shadow
 * with `pointer-events: none` (R-004 mitigation). On pointerup with
 * non-zero movement emits a `PinTarget` whose `bbox` is expressed in
 * document coordinates so queue-panel navigation can later scroll to it.
 */

import type { PinTarget } from '@forjis/shared';
import { getMode } from '../ui/mode.js';
import { getTool } from '../ui/picker-tool.js';

/** Options accepted by {@link initRegionPicker}. */
export interface InitRegionPickerOptions {
  /** Open shadow root the drag rectangle is appended to. */
  readonly shadow: ShadowRoot;
  /** Returns `true` when a pointer event target is overlay-owned. */
  readonly isOverlayOwned: (node: EventTarget) => boolean;
  /** Invoked once per completed drag with a region-kind `PinTarget`. */
  readonly onRegionPick: (target: PinTarget) => void;
}

/** Public handle returned by {@link initRegionPicker}. */
export interface RegionPickerHandle {
  /** Remove listeners and the drag-rect element. Idempotent. */
  destroy(): void;
}

/** Inline CSS applied to the drag-rect overlay element. */
const DRAG_RECT_STYLE = `
position: fixed;
pointer-events: none;
border: 1.5px dashed rgba(37, 99, 235, 0.85);
background: rgba(37, 99, 235, 0.12);
box-sizing: border-box;
display: none;
z-index: 2147483647;
`;

/**
 * Build the drag-rectangle DOM element.
 *
 * @returns A fresh `<div>` styled per {@link DRAG_RECT_STYLE}.
 */
function createDragRect(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-forjis-role', 'region-drag');
  el.style.cssText = DRAG_RECT_STYLE;
  return el;
}

/**
 * Determine whether the region picker should react to a pointer event.
 *
 * @returns `true` when inspect mode is ON and the region tool is active.
 */
function isRegionActive(): boolean {
  return getMode() === 'inspect' && getTool() === 'region';
}

/** Mutable drag state. */
interface DragState {
  readonly startX: number;
  readonly startY: number;
  currentX: number;
  currentY: number;
}

/**
 * Install the region picker listeners and return a teardown handle.
 *
 * Side effects:
 * - Appends a drag-rect element to `opts.shadow`.
 * - Attaches three document-level listeners with `capture: true`.
 *
 * @param opts - {@link InitRegionPickerOptions}.
 * @returns {@link RegionPickerHandle}.
 */
export function initRegionPicker(
  opts: InitRegionPickerOptions,
): RegionPickerHandle {
  const dragRect = createDragRect();
  opts.shadow.appendChild(dragRect);
  let drag: DragState | null = null;
  let destroyed = false;

  const paintRect = (): void => {
    if (!drag) {
      dragRect.style.display = 'none';
      return;
    }
    const x = Math.min(drag.startX, drag.currentX);
    const y = Math.min(drag.startY, drag.currentY);
    const w = Math.abs(drag.currentX - drag.startX);
    const h = Math.abs(drag.currentY - drag.startY);
    dragRect.style.left = String(x) + 'px';
    dragRect.style.top = String(y) + 'px';
    dragRect.style.width = String(w) + 'px';
    dragRect.style.height = String(h) + 'px';
    dragRect.style.display = 'block';
  };

  const hideRect = (): void => {
    drag = null;
    dragRect.style.display = 'none';
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!isRegionActive()) {
      return;
    }
    const target = e.target;
    if (target && opts.isOverlayOwned(target)) {
      return;
    }
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
    };
    paintRect();
    e.stopPropagation();
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || !isRegionActive()) {
      return;
    }
    drag.currentX = e.clientX;
    drag.currentY = e.clientY;
    paintRect();
    e.stopPropagation();
    e.preventDefault();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!drag || !isRegionActive()) {
      hideRect();
      return;
    }
    const dx = Math.abs(drag.currentX - drag.startX);
    const dy = Math.abs(drag.currentY - drag.startY);
    const x0 = Math.min(drag.startX, drag.currentX);
    const y0 = Math.min(drag.startY, drag.currentY);
    hideRect();
    if (dx < 1 || dy < 1) {
      return;
    }
    const scrollX = typeof window.scrollX === 'number' ? window.scrollX : 0;
    const scrollY = typeof window.scrollY === 'number' ? window.scrollY : 0;
    const target: PinTarget = {
      kind: 'region',
      source: null,
      selector: 'viewport-region',
      componentName: null,
      bbox: { x: x0 + scrollX, y: y0 + scrollY, w: dx, h: dy },
    };
    e.stopPropagation();
    e.preventDefault();
    opts.onRegionPick(target);
  };

  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  document.addEventListener('pointermove', onPointerMove, { capture: true });
  document.addEventListener('pointerup', onPointerUp, { capture: true });

  return {
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      document.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      });
      document.removeEventListener('pointermove', onPointerMove, {
        capture: true,
      });
      document.removeEventListener('pointerup', onPointerUp, {
        capture: true,
      });
      if (dragRect.parentNode) {
        dragRect.parentNode.removeChild(dragRect);
      }
    },
  };
}
