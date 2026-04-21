/**
 * ViewContext — lightweight Solid context exposing the active top-level view
 * and the shared search query. Replaces a router library: the shell only has
 * two top-level views (`tasks` / `config`) so a router is overkill. See
 * design.md decision D-2 (redesign-004).
 *
 * The provider owns both signals; consumers read/write through `useView()`.
 * No persistence (the reference stored the active tab in localStorage — that
 * is explicitly out of scope for this task, per design D-2).
 */

import type { Accessor, Component, ParentProps } from 'solid-js';
import { createContext, createSignal, useContext } from 'solid-js';

/** Valid top-level view names. Drives both the tab nav and the main outlet. */
export type ViewName = 'tasks' | 'config';

/** Shape exposed to consumers via {@link useView}. */
export interface ViewContextValue {
  /** Current active view. Default: `'tasks'`. */
  activeView: Accessor<ViewName>;
  /** Switch to the given view. */
  setActiveView: (name: ViewName) => void;
  /** Current search query string. Default: empty string. */
  query: Accessor<string>;
  /** Update the search query. */
  setQuery: (q: string) => void;
}

/**
 * Raw context. Default value is `undefined` so `useView` can detect a missing
 * provider and throw instead of returning a silent stub.
 */
const ViewContextRef = createContext<ViewContextValue | undefined>(undefined);

/**
 * Provider that owns the `activeView` and `query` signals for the whole app.
 * Mount once at the root of the shell. Nesting additional providers is not
 * supported and would produce inconsistent state.
 */
export const ViewProvider: Component<ParentProps> = (props) => {
  const [activeView, setActiveView] = createSignal<ViewName>('tasks');
  const [query, setQuery] = createSignal<string>('');
  const value: ViewContextValue = { activeView, setActiveView, query, setQuery };
  return (
    <ViewContextRef.Provider value={value}>{props.children}</ViewContextRef.Provider>
  );
};

/**
 * Consumer hook. Returns the current {@link ViewContextValue}; throws when
 * called outside a {@link ViewProvider} so mis-wiring surfaces immediately
 * rather than silently falling back to a default signal.
 */
export function useView(): ViewContextValue {
  const value = useContext(ViewContextRef);
  if (value === undefined) {
    throw new Error('useView() must be called inside a <ViewProvider>');
  }
  return value;
}
