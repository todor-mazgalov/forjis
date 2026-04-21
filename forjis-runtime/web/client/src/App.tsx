/**
 * App — root component for the Forjis dashboard.
 *
 * Two render paths:
 *  1. DEV-only primitive playground when `?playground=1` is in the URL. The
 *     DEV gate is compile-time (`import.meta.env.DEV` → literal `false` in
 *     production, so Vite tree-shakes the playground chunk) and the query
 *     gate is runtime.
 *  2. The redesigned shell: `ViewProvider` → three-row grid containing
 *     `<TopBar/>`, a `<main>` outlet that switches on the active view, and
 *     `<StatusBar/>`.
 *
 * See design.md decision D-5 (redesign-004).
 */

import type { Component, JSX } from 'solid-js';
import { Show, lazy, Suspense } from 'solid-js';
import { TopBar } from './shell/TopBar';
import { StatusBar } from './shell/StatusBar';
import { ViewProvider, useView } from './shell/ViewContext';
import { TasksView } from './views/tasks/TasksView';
import { ConfigView } from './views/config/ConfigView';
import { FileViewer } from './components/FileViewer';
import styles from './shell/App.module.css';

/**
 * Return true when the playground query toggle is present in the URL.
 * Isolated as a helper so the gating rule is named and testable.
 */
function isPlaygroundRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('playground');
}

/**
 * DEV-only lazy-mounted primitive playground. The dynamic `import()` is
 * guarded by `import.meta.env.DEV`; Vite's DCE replaces the DEV literal
 * with `false` in production, which elides both the gate and the import
 * so the `dev/playground` chunk never ships.
 */
const DevPlaygroundLazy = import.meta.env.DEV
  ? lazy(() => import('./dev/playground').then((module) => ({ default: module.Playground })))
  : null;

/**
 * Main outlet — switches between the real tasks view and the full config
 * view based on the active view signal. Extracted from `Shell` so the
 * `useView` call stays narrow and the switch rule is named.
 */
const Outlet: Component = () => {
  const { activeView } = useView();
  return (
    <Show when={activeView() === 'tasks'} fallback={<ConfigView />}>
      <TasksView />
    </Show>
  );
};

/** Shell grid: TopBar + outlet + StatusBar. Must be rendered inside ViewProvider. */
const Shell: Component = () => (
  <div class={styles.app}>
    <TopBar />
    <main class={styles.outlet}>
      <Outlet />
    </main>
    <StatusBar />
  </div>
);

/**
 * Resolve whether the playground gate is open. Double gate: compile-time
 * (`DevPlaygroundLazy` is null in production) plus runtime (query string).
 */
function isPlaygroundActive(): boolean {
  return DevPlaygroundLazy !== null && isPlaygroundRequested();
}

/** Root component. Chooses between playground and shell render paths. */
export const App: Component = (): JSX.Element => {
  return (
    <Show
      when={isPlaygroundActive() && DevPlaygroundLazy}
      fallback={
        <ViewProvider>
          <Shell />
          <FileViewer />
        </ViewProvider>
      }
    >
      {(PlaygroundComponent) => (
        <Suspense fallback={
          <ViewProvider>
            <Shell />
            <FileViewer />
          </ViewProvider>
        }>
          {PlaygroundComponent()({})}
        </Suspense>
      )}
    </Show>
  );
};
