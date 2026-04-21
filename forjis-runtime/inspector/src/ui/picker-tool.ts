/**
 * Picker-tool state singleton: `"element"` (click-to-pick) vs `"region"`
 * (drag-to-rect). Parallel to `ui/mode.ts` but NOT persisted — each mount
 * defaults to `"element"` (design.md §D-003, FR-010-033).
 *
 * Overlay pointer-event routing consults `getTool()` on every gesture to
 * decide whether to dispatch to the element click path or the region drag
 * path. Switching tools while inspect is ON must NOT destroy the overlay,
 * comment sheet, or queue panel.
 */

/** Closed set of picker-tool identifiers. */
export type PickerTool = 'element' | 'region';

/** Listener invoked synchronously on tool change. */
export type PickerToolListener = (next: PickerTool) => void;

/** Disposer returned from {@link onToolChange}. */
export type Unsubscribe = () => void;

const DEFAULT_TOOL: PickerTool = 'element';

let currentTool: PickerTool = DEFAULT_TOOL;
const listeners: Set<PickerToolListener> = new Set();

/**
 * Read the currently-active picker tool.
 *
 * @returns The active {@link PickerTool}; defaults to `"element"`.
 */
export function getTool(): PickerTool {
  return currentTool;
}

/**
 * Assign the active picker tool. No-op when `next` equals the current
 * tool. Notifies every registered listener in insertion order.
 *
 * @param next - Tool to adopt.
 */
export function setTool(next: PickerTool): void {
  if (next === currentTool) {
    return;
  }
  currentTool = next;
  for (const fn of listeners) {
    fn(next);
  }
}

/**
 * Subscribe to tool-change events.
 *
 * @param fn - Listener invoked with the new tool each time it changes.
 * @returns {@link Unsubscribe} removing `fn` from the listener set.
 */
export function onToolChange(fn: PickerToolListener): Unsubscribe {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test-only escape hatch. Resets state to the default tool and clears the
 * listener set. Parallel to `__resetModeForTests`.
 */
export function __resetPickerToolForTests(): void {
  currentTool = DEFAULT_TOOL;
  listeners.clear();
}
