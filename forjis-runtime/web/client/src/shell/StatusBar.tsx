/**
 * StatusBar — the shell's bottom status strip.
 *
 * Renders eight condensed chips so the operator can read the
 * orchestrator's state at a glance without switching views. Left to
 * right: orchestrator health + version, running count, queued count,
 * worker slots, tokens, cost, plugins, git branch. The clock chip from
 * earlier drafts was dropped — redesign-014 §2 explicitly omits it.
 *
 * Optional chips (`cost`, `gitBranch`) are skipped entirely when the
 * runtime endpoint returns them as absent / null so the bar does not
 * leave visible gaps. A single consolidated poll kicks off on mount
 * and fires every `POLL_INTERVAL_MS` — the four fetches (tasks,
 * runtime, token-usage, resources) run concurrently per tick so a slow
 * endpoint never stalls the others. `onCleanup` clears the interval.
 *
 * See redesign-014 for the chip inventory and redesign-013 for the
 * runtime endpoint contract.
 */

import type { Component } from 'solid-js';
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import type {
  ResourcesResponse,
  RuntimeResponse,
  TaskListItem,
  TokenUsageResponse,
} from '@forjis/shared';
import { StatusDot } from '../components/primitives/StatusDot';
import {
  fetchRuntime,
  fetchTokenUsage,
  getResources,
  getTasks,
} from './api';
import styles from './StatusBar.module.css';

/** Poll cadence for every status-bar chip source. Matches TaskRail. */
const POLL_INTERVAL_MS = 2000;

/**
 * Derive the connection-health label from the current runtime response.
 * When the runtime endpoint responded successfully (`runtime !== null`) the
 * orchestrator process is up; when the endpoint is unreachable the whole
 * runtime is considered down.
 */
function deriveConnectionLabel(runtime: RuntimeResponse | null): string {
  if (runtime === null) return 'orchestrator down';
  return 'orchestrator up';
}

/**
 * Derive the `StatusDot` state for the connection chip.
 * `done` (green) when the orchestrator is reachable; `failed` (red) when
 * the runtime endpoint returned no response.
 */
function deriveConnectionDotState(runtime: RuntimeResponse | null): 'done' | 'failed' {
  return runtime !== null ? 'done' : 'failed';
}

/** Count running tasks. Safe against `null` (endpoint unavailable). */
function countRunning(tasks: TaskListItem[] | null): number {
  if (tasks === null) return 0;
  return tasks.filter((t) => t.status === 'running').length;
}

/** Count queued + pending tasks. Safe against `null`. */
function countQueued(tasks: TaskListItem[] | null): number {
  if (tasks === null) return 0;
  return tasks.filter((t) => t.status === 'queued' || t.status === 'pending').length;
}

/**
 * Format the tokens chip text. Renders `<total>/<cap>` when a budget is
 * configured, otherwise just the total — matches the contract in
 * redesign-014 §2.5.
 */
function formatTokens(usage: TokenUsageResponse): string {
  if (usage.budget === null) {
    return `tokens ${usage.totalTokens}`;
  }
  return `tokens ${usage.totalTokens}/${usage.budget.maxTokens}`;
}

/**
 * Format the cost chip text. Currency is rendered as `$<total>` when USD
 * (the facilitator's only observed currency today) and as
 * `<CURRENCY> <total>` otherwise so unexpected future currencies do not
 * silently mislabel the chip.
 */
function formatCost(cost: { total: number; currency: string }): string {
  const rounded = cost.total.toFixed(2);
  if (cost.currency.toUpperCase() === 'USD') {
    return `cost $${rounded}`;
  }
  return `cost ${cost.currency} ${rounded}`;
}

/** Bottom status strip. Polls the four data sources in parallel every 2s. */
export const StatusBar: Component = () => {
  const [tasks, setTasks] = createSignal<TaskListItem[] | null>(null);
  const [runtime, setRuntime] = createSignal<RuntimeResponse | null>(null);
  const [tokens, setTokens] = createSignal<TokenUsageResponse | null>(null);
  const [resources, setResources] = createSignal<ResourcesResponse | null>(null);

  async function pollOnce(): Promise<void> {
    const [tasksResult, runtimeResult, tokensResult, resourcesResult] = await Promise.all([
      getTasks(),
      fetchRuntime(),
      fetchTokenUsage(),
      getResources(),
    ]);
    setTasks(tasksResult);
    setRuntime(runtimeResult);
    setTokens(tokensResult);
    setResources(resourcesResult);
  }

  onMount(() => {
    void pollOnce();
    const handle = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(handle));
  });

  return (
    <footer class={styles.statusbar}>
      <span class={styles.chip}>
        <StatusDot state={deriveConnectionDotState(runtime())} variant={runtime() !== null ? 'pulse' : 'static'} />
        {deriveConnectionLabel(runtime())}
        <Show when={runtime()}>
          {(rt) => <span>{` \u00b7 v${rt().version}`}</span>}
        </Show>
      </span>
      <span class={styles.chip}>{countRunning(tasks())} running</span>
      <span class={styles.chip}>{countQueued(tasks())} queued</span>
      <Show when={runtime()}>
        {(rt) => (
          <span class={styles.chip}>
            {`workers ${rt().workers.busy}/${rt().workers.max}`}
          </span>
        )}
      </Show>
      <Show when={tokens()}>
        {(u) => <span class={styles.chip}>{formatTokens(u())}</span>}
      </Show>
      <Show when={runtime()?.cost}>
        {(cost) => <span class={styles.chip}>{formatCost(cost())}</span>}
      </Show>
      <Show when={resources()}>
        {(r) => <span class={styles.chip}>{`plugins ${r().plugins.length}`}</span>}
      </Show>
      <Show when={runtime()?.gitBranch}>
        {(branch) => <span class={styles.chip}>{branch()}</span>}
      </Show>
    </footer>
  );
};
