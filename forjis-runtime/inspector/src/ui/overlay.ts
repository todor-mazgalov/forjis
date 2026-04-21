/**
 * Inspector overlay: composes the toggle button, highlight box, and
 * document-level pointer/keyboard listeners inside a shadow root attached to
 * the `#forjis-inspector-root` host div. Emits a `PinTarget` through the
 * supplied `onPick` callback on the two-tap confirm gesture.
 */

import type { Pin, PinTarget } from '@forjis/shared';
import { captureElement } from '../capture/element.js';
import { captureRegion } from '../capture/region.js';
import { captureComputedStyles } from '../capture/styles.js';
import { captureViewport } from '../capture/viewport.js';
import {
  computeBbox,
  computeSelector,
  readComponentName,
  readSourceInfo,
} from '../pick/source-info.js';
import { initRegionPicker, type RegionPickerHandle } from '../pick/region.js';
import { getCurrentScreen } from '../queue/screen-tracker.js';
import { createCommentSheet, type CommentSheetHandle } from './comment-sheet.js';
import { createHighlightBox, type HighlightBoxHandle } from './highlight-box.js';
import { getMode, onModeChange, type Unsubscribe } from './mode.js';
import {
  getTool,
  onToolChange,
  setTool,
} from './picker-tool.js';
import { createToggleButton, type ToggleButtonHandle } from './toggle-button.js';

/** Options accepted by {@link initOverlay}. */
export interface InitOverlayOptions {
  /** Host element — `#forjis-inspector-root` created by `mount()`. */
  readonly root: HTMLElement;
  /**
   * Called once with a {@link PinTarget} per confirmed two-tap pick.
   *
   * Preserved from the task-008 contract for backwards compatibility; task-009
   * additionally threads the target through the capture pipeline and into
   * {@link InitOverlayOptions.onSubmitPin}.
   */
  readonly onPick: (target: PinTarget) => void;
  /**
   * Called once with the finalized {@link Pin} when the user clicks Send in
   * the comment sheet. Not fired when the user clicks Cancel.
   */
  readonly onSubmitPin: (pin: Pin) => void;
  /**
   * Optional middleware invoked AFTER capture blobs are produced but
   * BEFORE the comment sheet is opened. Returning `true` suppresses the
   * comment-sheet dispatch — the caller (`mount.ts`) owns the capture
   * bundle and is responsible for either invoking
   * {@link OverlayHandle.dispatchPendingCapture} later or discarding it.
   * Additive extension (task-011, design.md §D-004).
   */
  readonly onPickConfirmed?: (
    el: Element,
    target: PinTarget,
    blobs: {
      elementBlob: Blob;
      viewportBlob: Blob;
      computedStyles: Record<string, string>;
    },
  ) => boolean;
}

/** Public handle returned by {@link initOverlay}. */
export interface OverlayHandle {
  /** Remove all listeners and clear the shadow root. Idempotent. */
  destroy(): void;
  /**
   * Forward a previously-captured bundle (held by `mount.ts` across a
   * reply-banner decline) to the comment sheet as if the pick had just
   * been confirmed. Additive extension (task-011, design.md §D-004).
   *
   * @param target - `PinTarget` captured at pick-confirm time.
   * @param blobs - Blobs + computed styles captured alongside the target.
   */
  dispatchPendingCapture(
    target: PinTarget,
    blobs: {
      elementBlob: Blob;
      viewportBlob: Blob;
      computedStyles: Record<string, string>;
    },
  ): void;
}

type OverlayState =
  | { phase: 'idle' }
  | { phase: 'pending'; el: Element };

const OVERLAY_STYLE = `
:host, :root { all: initial; }
div[data-forjis-role="toggle-container"] {
  position: fixed;
  right: 16px;
  bottom: 16px;
  pointer-events: auto;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  background: #1f2937;
  color: #f9fafb;
  border: 1px solid #374151;
  border-radius: 999px;
  padding: 4px;
  box-shadow: 0 4px 10px rgba(0,0,0,0.2);
  font: 500 13px/1 system-ui, -apple-system, sans-serif;
}
div[data-forjis-role="toggle-container"] button {
  pointer-events: auto;
  background: transparent;
  color: inherit;
  border: 0;
  border-radius: 999px;
  padding: 6px 12px;
  min-height: 28px;
  min-width: 28px;
  font: inherit;
  cursor: pointer;
}
button[data-forjis-role="toggle"][data-mode="inspect"] {
  background: #2563eb;
  border-color: #1d4ed8;
  color: #ffffff;
}
div[data-forjis-role="toggle-container"] button:hover {
  background: rgba(255,255,255,0.08);
}
div[data-forjis-role="toggle-container"] button:active {
  background: rgba(255,255,255,0.16);
}
div[data-forjis-role="toggle-container"] button:focus-visible {
  outline: 2px solid #60a5fa;
  outline-offset: 2px;
}
button[data-forjis-role="tool-element"][data-visible="false"],
button[data-forjis-role="tool-region"][data-visible="false"] {
  display: none;
}
button[data-forjis-role="tool-element"][data-active="true"],
button[data-forjis-role="tool-region"][data-active="true"] {
  background: #2563eb;
  color: #ffffff;
}
div[data-forjis-role="highlight"] {
  position: fixed;
  pointer-events: none;
  border: 2px solid rgba(37, 99, 235, 0.6);
  background: rgba(37, 99, 235, 0.1);
  box-sizing: border-box;
}
div[data-forjis-role="highlight"][data-variant="pending"] {
  border-color: rgba(234, 88, 12, 0.9);
  background: rgba(234, 88, 12, 0.15);
  box-shadow: 0 0 0 2px rgba(234, 88, 12, 0.35);
}
div[data-forjis-role="label"] {
  position: fixed;
  pointer-events: none;
  background: #111827;
  color: #f9fafb;
  font: 500 11px/1.2 system-ui, -apple-system, sans-serif;
  padding: 4px 6px;
  border-radius: 4px;
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

/**
 * Style the root host element per design §D-006.
 *
 * @param root - Host element attached to `document.body` by `mount()`.
 */
function styleRoot(root: HTMLElement): void {
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '2147483646';
}

/**
 * Build the inline `<style>` node for the shadow root.
 *
 * @returns A detached `<style>` element carrying the overlay CSS.
 */
function createStyleNode(): HTMLStyleElement {
  const style = document.createElement('style');
  // Static markup — zero user-derived substrings, safe to assign.
  style.textContent = OVERLAY_STYLE;
  return style;
}

/**
 * Build a human-readable label for the pending state.
 *
 * @param el - Element being pinned.
 * @returns Label text combining component/tag name and `file:line` (when
 *   available).
 */
function buildPendingLabel(el: Element): string {
  const name = readComponentName(el) ?? el.tagName.toLowerCase();
  const src = readSourceInfo(el);
  if (src === null) {
    return name;
  }
  return name + ' @ ' + src.file + ':' + String(src.line);
}

/**
 * Build the {@link PinTarget} emitted by `onPick`.
 *
 * @param el - Confirmed element.
 * @returns Fully populated `PinTarget` with `kind: "element"`.
 */
function buildPinTarget(el: Element): PinTarget {
  return {
    kind: 'element',
    source: readSourceInfo(el),
    selector: computeSelector(el),
    componentName: readComponentName(el),
    bbox: computeBbox(el),
  };
}

/**
 * Walk `event.composedPath()` looking for the first `Element` that is NOT
 * owned by the overlay.
 *
 * @param event - The document-level event.
 * @param isOwned - Predicate that returns true for overlay-owned nodes.
 * @returns First non-overlay `Element` or `null` when nothing qualifies.
 */
function walkToHostTarget(
  event: Event,
  isOwned: (node: EventTarget) => boolean,
): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (isOwned(node)) {
      continue;
    }
    if (node instanceof Element) {
      return node;
    }
  }
  const target = event.target;
  if (target instanceof Element && !isOwned(target)) {
    return target;
  }
  return null;
}

/**
 * Mount the overlay UI inside `opts.root` and wire document-level listeners.
 *
 * Side effects on entry:
 * - Styles `opts.root` for fixed-overlay positioning.
 * - Opens an open shadow root and appends `<style>` + toggle + highlight.
 * - Registers capture-phase `click` + `pointermove` and bubble-phase `keydown`
 *   listeners on `document`.
 *
 * @param opts - {@link InitOverlayOptions}.
 * @returns A {@link OverlayHandle} whose `destroy` tears everything down.
 */
export function initOverlay(opts: InitOverlayOptions): OverlayHandle {
  styleRoot(opts.root);
  const shadow = opts.root.attachShadow({ mode: 'open' });
  shadow.appendChild(createStyleNode());
  const toggleButton: ToggleButtonHandle = createToggleButton();
  const highlightBox: HighlightBoxHandle = createHighlightBox();
  shadow.appendChild(toggleButton.element);
  shadow.appendChild(highlightBox.element);
  shadow.appendChild(highlightBox.label);
  const commentSheetHandle: CommentSheetHandle = createCommentSheet({
    shadow,
    onSubmit: (pin) => opts.onSubmitPin(pin),
    onCancel: () => {
      /* close lifecycle is handled inside the sheet */
    },
    onAddAnotherPin: () => {
      // Re-arm picker mode: the sheet has already hidden itself; the current
      // tool remains active. setTool with the same value is a no-op but
      // keeps the callback shape for future expansion.
      setTool(getTool());
    },
  });

  let state: OverlayState = { phase: 'idle' };
  let lastHoverEl: Element | null = null;

  const dispatchToSheet = (
    target: PinTarget,
    elementBlob: Blob,
    viewportBlob: Blob,
    computedStyles: Record<string, string>,
  ): void => {
    const screen = getCurrentScreen();
    const ctx = {
      target,
      elementBlob,
      viewportBlob,
      bbox: target.bbox,
      computedStyles,
      screen,
    } as const;
    if (commentSheetHandle.isOpen()) {
      commentSheetHandle.addPinToGroup(ctx);
      return;
    }
    commentSheetHandle.open(ctx);
  };

  const handleElementPickConfirmed = async (
    el: Element,
    target: PinTarget,
  ): Promise<void> => {
    const computedStyles = captureComputedStyles(el);
    const elementBlob = await captureElement(el);
    const viewportBlob = await captureViewport(target.bbox);
    if (opts.onPickConfirmed) {
      const suppressed = opts.onPickConfirmed(el, target, {
        elementBlob,
        viewportBlob,
        computedStyles,
      });
      if (suppressed) {
        return;
      }
    }
    dispatchToSheet(target, elementBlob, viewportBlob, computedStyles);
  };

  const handleRegionPickConfirmed = async (
    target: PinTarget,
  ): Promise<void> => {
    const { regionPng, viewportPng } = await captureRegion(target.bbox);
    dispatchToSheet(target, regionPng, viewportPng, {});
  };

  const isOverlayOwned = (node: EventTarget): boolean => {
    if (node === opts.root || node === shadow) {
      return true;
    }
    if (node instanceof Node && shadow.contains(node)) {
      return true;
    }
    return false;
  };

  const regionPickerHandle: RegionPickerHandle = initRegionPicker({
    shadow,
    isOverlayOwned,
    onRegionPick: (target) => {
      opts.onPick(target);
      void handleRegionPickConfirmed(target);
    },
  });

  const drawPending = (el: Element): void => {
    highlightBox.update(computeBbox(el), 'pending', buildPendingLabel(el));
  };

  const drawHover = (el: Element): void => {
    highlightBox.update(computeBbox(el), 'hover', null);
  };

  const onDocumentClick = (e: MouseEvent): void => {
    if (getMode() === 'use') {
      return;
    }
    if (getTool() !== 'element') {
      return;
    }
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const first = path[0] ?? e.target;
    if (first && isOverlayOwned(first)) {
      return;
    }
    const walked = walkToHostTarget(e, isOverlayOwned);
    e.stopPropagation();
    e.preventDefault();
    if (walked === null || walked === document.body || walked === document.documentElement) {
      if (state.phase === 'pending') {
        state = { phase: 'idle' };
        highlightBox.hide();
      }
      return;
    }
    if (state.phase === 'idle') {
      state = { phase: 'pending', el: walked };
      drawPending(walked);
      return;
    }
    if (state.el === walked) {
      const target = buildPinTarget(walked);
      state = { phase: 'idle' };
      highlightBox.hide();
      opts.onPick(target);
      void handleElementPickConfirmed(walked, target);
      return;
    }
    state = { phase: 'pending', el: walked };
    drawPending(walked);
  };

  const onDocumentPointerMove = (e: PointerEvent): void => {
    if (getMode() === 'use') {
      return;
    }
    if (getTool() !== 'element') {
      return;
    }
    if (e.pointerType === 'touch') {
      return;
    }
    const walked = walkToHostTarget(e, isOverlayOwned);
    if (walked === null) {
      return;
    }
    if (walked === lastHoverEl) {
      return;
    }
    lastHoverEl = walked;
    if (state.phase === 'pending' && walked === state.el) {
      return;
    }
    drawHover(walked);
  };

  const onDocumentKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') {
      return;
    }
    if (state.phase !== 'pending') {
      return;
    }
    state = { phase: 'idle' };
    highlightBox.hide();
  };

  const modeUnsubscribe: Unsubscribe = onModeChange((next) => {
    if (next === 'use') {
      state = { phase: 'idle' };
      highlightBox.hide();
      lastHoverEl = null;
    }
  });

  const toolUnsubscribe: Unsubscribe = onToolChange(() => {
    // Clear in-flight element-pick state when the tool switches so the
    // stale pending highlight does not linger into the region gesture.
    if (state.phase === 'pending') {
      state = { phase: 'idle' };
      highlightBox.hide();
    }
    lastHoverEl = null;
  });

  document.addEventListener('click', onDocumentClick, { capture: true });
  document.addEventListener('pointermove', onDocumentPointerMove, { capture: true });
  document.addEventListener('keydown', onDocumentKeyDown);

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      document.removeEventListener('click', onDocumentClick, { capture: true });
      document.removeEventListener('pointermove', onDocumentPointerMove, { capture: true });
      document.removeEventListener('keydown', onDocumentKeyDown);
      modeUnsubscribe();
      toolUnsubscribe();
      regionPickerHandle.destroy();
      toggleButton.destroy();
      highlightBox.destroy();
      commentSheetHandle.destroy();
      while (shadow.firstChild) {
        shadow.removeChild(shadow.firstChild);
      }
    },
    dispatchPendingCapture(target, blobs) {
      if (destroyed) {
        return;
      }
      dispatchToSheet(
        target,
        blobs.elementBlob,
        blobs.viewportBlob,
        blobs.computedStyles,
      );
    },
  };
}
