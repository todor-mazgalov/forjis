/**
 * TaskRail — left-hand column of the Tasks view.
 *
 * Polls `GET /api/tasks` every {@link POLL_INTERVAL_MS} ms while the tab is
 * visible and renders a {@link TaskCard} per item. Polling is gated by
 * `document.visibilityState` to mirror the legacy dashboard: the interval is
 * paused when the tab is hidden and resumed on `visibilitychange`. An
 * additional "now" timer ticks every second so elapsed-time labels on
 * running cards keep counting between polls.
 *
 * Selection state lives in the parent {@link TasksView}; this component is a
 * pure view over the task list and the current `selectedTaskId`.
 */

import type { Component } from 'solid-js';
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { TaskListItem } from '@forjis/shared';
import { getTasks } from '../../shell/api';
import { TaskCard } from './TaskCard';
import styles from './TaskRail.module.css';

/** Poll cadence for the task list, in milliseconds. Matches the legacy dashboard. */
const POLL_INTERVAL_MS = 2000;

/** Tick cadence for the elapsed-time refresh, in milliseconds. */
const NOW_TICK_MS = 1000;

/** Props for {@link TaskRail}. */
export interface TaskRailProps {
  /** Currently selected task id, or null when no task is selected. */
  selectedTaskId: string | null;
  /** Fired when the user clicks a task card. */
  onSelect: (taskId: string) => void;
}

/**
 * Return true when the environment considers the document currently visible.
 * Isolated so the visibility rule is named and trivially testable; treats an
 * SSR environment (no `document`) as visible so the initial fetch still runs.
 */
function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return !document.hidden;
}

/**
 * Left rail containing the polled task list. Owns its own `tasks` and `now`
 * signals; the `selectedTaskId` comes from the parent so the pipeline and
 * detail panes can read it too.
 */
export const TaskRail: Component<TaskRailProps> = (props) => {
  const [tasks, setTasks] = createSignal<TaskListItem[]>([]);
  const [now, setNow] = createSignal<number>(Date.now());
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const refresh = async (): Promise<void> => {
    const next = await getTasks();
    if (next !== null) setTasks(next);
  };

  const startPolling = (): void => {
    if (pollTimer !== null) return;
    void refresh();
    pollTimer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
  };

  const stopPolling = (): void => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const handleVisibilityChange = (): void => {
    if (isDocumentVisible()) startPolling();
    else stopPolling();
  };

  onMount(() => {
    if (isDocumentVisible()) startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const nowTimer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    onCleanup(() => {
      clearInterval(nowTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopPolling();
    });
  });

  return (
    <aside class={styles.rail} aria-label="Tasks">
      <header class={styles.head}>
        <span class={styles.heading}>Tasks</span>
        <span class={styles.counter}>{tasks().length}</span>
      </header>
      <div class={styles.body}>
        <Show
          when={tasks().length > 0}
          fallback={<div class={styles.empty}>no tasks</div>}
        >
          <For each={tasks()}>
            {(task) => (
              <TaskCard
                task={task}
                selected={task.id === props.selectedTaskId}
                now={now()}
                onSelect={props.onSelect}
              />
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
};
