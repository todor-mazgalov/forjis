/**
 * PipelinePanel — middle column of the Tasks view.
 *
 * Wraps the pipeline plan in the `Panel` primitive. The header carries the
 * `Pipeline Plan` label, a step-count badge, and a right-aligned
 * `SegmentedToggle` that swaps the body between {@link PipelineList} and
 * {@link PipelineGraph}. Owns two `createResource` calls per design D-4: the
 * plan is keyed on the current `selectedTaskId` and re-fetches on task
 * switch; the resources list is fetched once on mount. A `now` signal ticks
 * every {@link NOW_TICK_MS} ms so running steps' elapsed labels keep counting
 * between plan fetches.
 *
 * The `viz` signal is local and session-scoped (no persistence). Toggling
 * between `list` and `graph` swaps only the body's child; the panel itself,
 * the shared `selectedStepId` (in `PipelineSelectionContext`), and the
 * sibling right-column detail pane are all unaffected.
 *
 * Error/empty handling mirrors the existing `TaskRail` convention: any null
 * resolution or empty `steps` array renders the `no steps` placeholder — no
 * spinner, no toast, no retry UI.
 */

import type { Component, JSX } from 'solid-js';
import { Show, createMemo, createResource, createSignal, onCleanup, onMount, batch } from 'solid-js';
import type { PipelinePlanResponse, ResourcesResponse, RoleResource } from '@forjis/shared';
import { Panel } from '../../components/primitives/Panel';
import { SegmentedToggle } from '../../components/primitives/SegmentedToggle';
import { getPlan, getResources } from '../../shell/api';
import { PipelineList } from './PipelineList';
import { PipelineGraph } from './PipelineGraph';
import styles from './PipelinePanel.module.css';

/** Visualisation mode for the pipeline body. */
type Viz = 'list' | 'graph';

/** Tick cadence for the elapsed-time refresh, in milliseconds. */
const NOW_TICK_MS = 1000;

/**
 * Plan-refetch cadence, in milliseconds. Matches the 2-second polling cadence
 * of TaskRail and StatusBar so all columns advance in lock-step.
 */
const PLAN_POLL_MS = 2000;

/** Props for {@link PipelinePanel}. */
export interface PipelinePanelProps {
  /** Currently selected task id. `null` → empty state; no fetch issued. */
  selectedTaskId: string | null;
}

/**
 * Fetcher used by the plan `createResource`. Resolves immediately to `null`
 * when the id is absent so no HTTP request is made. Isolated so the "don't
 * fetch when there's no task" rule is named.
 */
async function fetchPlanForId(id: string | null): Promise<PipelinePlanResponse | null> {
  if (id === null) return null;
  return getPlan(id);
}

/**
 * Flatten a `ResourcesResponse` into a map keyed by bare role name.
 *
 * The resolver now emits bare role names (e.g. `Architect`) with plugin
 * origin carried in a separate `plugin` field, so the index keys directly
 * on `role.name`. On name collision the first occurrence wins — documented
 * trade-off in design D-4 of redesign-006.
 */
function indexResourcesByRole(resources: ResourcesResponse | null): Record<string, RoleResource> {
  const map: Record<string, RoleResource> = {};
  if (resources === null) return map;
  for (const org of resources.orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        if (map[role.name] === undefined) {
          map[role.name] = role;
        }
      }
    }
  }
  return map;
}

/** Middle column panel that owns plan + resources fetching. */
export const PipelinePanel: Component<PipelinePanelProps> = (props) => {
  // `tick` increments every PLAN_POLL_MS so the plan resource re-fetches at
  // the same 2-second cadence as TaskRail and StatusBar. When `selectedTaskId`
  // is null, `fetchPlanForId` short-circuits to `null` immediately — no HTTP
  // request fires regardless of tick. The tick and the task id are packed into
  // a tuple so a single `createResource` keyed on `[id, tick]` handles both
  // task-switch refetches and time-based polling.
  const [tick, setTick] = createSignal<number>(0);

  const [plan] = createResource(
    (): [string | null, number] => [props.selectedTaskId, tick()],
    ([id]) => fetchPlanForId(id),
  );

  const [resources] = createResource(() => true, () => getResources());

  const resourcesByRole = createMemo<Record<string, RoleResource>>(() =>
    indexResourcesByRole(resources() ?? null),
  );

  const [now, setNow] = createSignal<number>(Date.now());
  const [viz, setViz] = createSignal<Viz>('list');
  onMount(() => {
    // Both the elapsed-label ticker and the plan-poll ticker share one interval
    // so they advance together. The plan poll fires every PLAN_POLL_MS (2s),
    // while `now` updates every NOW_TICK_MS (1s) — run a single interval at the
    // GCD (1s) and increment `tick` only every second iteration.
    let planCycle = 0;
    const timer = setInterval(() => {
      planCycle += 1;
      const shouldPoll = planCycle % (PLAN_POLL_MS / NOW_TICK_MS) === 0;
      batch(() => {
        setNow(Date.now());
        if (shouldPoll) setTick((n) => n + 1);
      });
    }, NOW_TICK_MS);
    onCleanup(() => clearInterval(timer));
  });

  const stepCount = (): number => plan()?.steps.length ?? 0;
  const steps = (): PipelinePlanResponse['steps'] => plan()?.steps ?? [];

  const header = (): JSX.Element => (
    <div class={styles.headerRow}>
      <span class={styles.heading}>Pipeline Plan</span>
      <span class={styles.counter}>{stepCount()}</span>
      <SegmentedToggle
        class={styles.toggle}
        value={viz()}
        onChange={(v) => setViz(v as Viz)}
        options={[
          { value: 'list', label: 'List' },
          { value: 'graph', label: 'Graph' },
        ]}
      />
    </div>
  );

  return (
    <section class={styles.root} aria-label="Pipeline plan">
      <Panel header={header()} class={styles.panel}>
        <div class={styles.body}>
          <Show
            when={steps().length > 0}
            fallback={<div class={styles.empty}>no steps</div>}
          >
            <Show
              when={viz() === 'list'}
              fallback={
                <PipelineGraph
                  steps={steps()}
                  resourcesByRole={resourcesByRole()}
                  now={now()}
                />
              }
            >
              <PipelineList
                steps={steps()}
                resourcesByRole={resourcesByRole()}
                now={now()}
              />
            </Show>
          </Show>
        </div>
      </Panel>
    </section>
  );
};
