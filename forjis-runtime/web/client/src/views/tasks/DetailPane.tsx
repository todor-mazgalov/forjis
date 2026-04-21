/**
 * DetailPane — right-column shell for the Tasks view (redesign-008 shell,
 * redesign-009 tab bodies, redesign-017 header + stats strip).
 *
 * Three vertical regions: a header that swaps between a selected-step view
 * and an orchestrator-summary card, a four-tab strip (Events / Files
 * touched / OpenSpec / Config), and a tab body. Reads `selectedStepId` from
 * `usePipelineSelection()` so the wiring stays symmetric with the pipeline
 * panel; receives `selectedTaskId` as an accessor so its own resources and
 * effects react to task switches without prop-drilling.
 *
 * State ownership (redesign-017 § D-2, D-3):
 * - `tab` is component-local and intentionally NOT reset on selection change.
 * - `now` ticks every {@link NOW_TICK_MS} ms so the elapsed label keeps moving
 *   and the token-usage resource refetches on every tick (D-4).
 * - `plan` is fetched here independently from `PipelinePanel` (risk R-1) so
 *   the orchestrator-summary fallback and the selected-step lookup share one
 *   source of truth without coupling to a sibling component.
 * - `events` (+ SSE subscription), `manifest`, and `tokenUsage` are lifted
 *   into this component so the header stats strip and the tab bodies read
 *   from a single source of truth without remounting on selection change.
 */

import type { Accessor, Component, JSX } from 'solid-js';
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import { createStore } from 'solid-js/store';
import type {
  ManifestResponse,
  PipelinePlanResponse,
  PipelineStep,
  RoleIdentity,
  TaskEvent,
  TokenUsageResponse,
} from '@forjis/shared';
import { Pill, type PillState } from '../../components/primitives/Pill';
import { StatusDot, type StatusDotState } from '../../components/primitives/StatusDot';
import {
  fetchTokenUsage,
  getManifest,
  getPlan,
  getTaskEvents,
  getTaskFiles,
  openTaskEventStream,
} from '../../shell/api';
import {
  classify,
  DEFAULT_FILTERS,
  EventsTab,
  filterBucketOf,
  type FilterBucket,
  type FiltersState,
} from './EventsTab';
import { FilesTouchedTab } from './FilesTouchedTab';
import { OpenSpecTab } from './OpenSpecTab';
import { RoleConfigTab } from './RoleConfigTab';
import { RoleLabel } from './RoleLabel';
import { usePipelineSelection } from './PipelineSelectionContext';
import { DecisionPill } from './DecisionPill';
import { ELAPSED_FALLBACK, formatElapsed } from './time';
import {
  countFilesTouched,
  countToolCalls,
  deriveDecision,
  displayScoreOf,
  isSkipped,
  tokensForStep,
} from './step-header-derivations';
import {
  computeVisibleFilesCount,
  computeVisibleOpenSpecCount,
  pickAutoSelectStep,
} from './detail-pane-utils';
import styles from './DetailPane.module.css';

// Re-export the pure helpers so callers (tests, other views) can import them
// from DetailPane without knowing about the companion module.
export { computeVisibleFilesCount, computeVisibleOpenSpecCount, pickAutoSelectStep } from './detail-pane-utils';

/** Tick cadence for the elapsed-time refresh, in milliseconds. */
const NOW_TICK_MS = 1000;

/** Polling cadence used by the lifted events subscription when
 *  `EventSource` is unavailable (mirrors EventsTab's fallback). */
const POLL_FALLBACK_MS = 1500;

/** Tool names that cause the manifest resource to refetch when a new event
 *  with one of these names lands in the events store. */
const MANIFEST_TRIGGERING_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
]);

/**
 * True when the current runtime exposes the `EventSource` constructor. Read
 * once at module load — flipping it at runtime is not supported by browsers.
 */
const hasEventSource = typeof EventSource !== 'undefined';

/** Identifier for the currently active tab. Listed in display order. */
type TabKey = 'events' | 'files' | 'openspec' | 'config';

/** Tab metadata used to render the strip and look up labels for stub bodies. */
interface TabDescriptor {
  key: TabKey;
  label: string;
}

/** Ordered tab list. Order matches the spec: Events, Files touched, OpenSpec, Config. */
const TABS: readonly TabDescriptor[] = [
  { key: 'events', label: 'Events' },
  { key: 'files', label: 'Files touched' },
  { key: 'openspec', label: 'OpenSpec' },
  { key: 'config', label: 'Config' },
];

/**
 * Count the post-filter top-level rows that the Events tab body would render
 * for the given event list. Mirrors the rendering rule: `tool-result` events
 * fold into their parent `tool-call` block and never count as a top-level
 * row (the parent counts once for the whole pair). When the parent
 * `tool-call` chip is off, the parent — and with it every nested result — is
 * dropped from the badge count.
 */
function countVisibleEvents(events: readonly TaskEvent[], filters: FiltersState): number {
  let count = 0;
  for (const event of events) {
    const bucket = filterBucketOf(event);
    if (bucket === null) {
      // tool-result: nests under its parent and is not counted as a row.
      continue;
    }
    if (!filters[bucket]) continue;
    count += 1;
  }
  return count;
}

/** Props for {@link DetailPane}. */
export interface DetailPaneProps {
  /** TasksView's task accessor — re-fetches and re-subscribes when this changes. */
  selectedTaskId: Accessor<string | null>;
}

/**
 * Map a `PipelineStep.status` to the matching `Pill` state. Centralised so
 * the same translation rule lives in one place even though the receivers
 * (Pill / StatusDot) take different state enums.
 */
function toPillState(status: PipelineStep['status']): PillState {
  if (status === 'planned' || status === 'running' || status === 'done' || status === 'skipped') {
    return status;
  }
  return 'pending';
}

/**
 * Map a `PipelineStep.status` to the matching `StatusDot` state. `planned`
 * funnels to `queued` to share the idle visual language with the rail.
 */
function toDotState(status: PipelineStep['status']): StatusDotState {
  if (status === 'running' || status === 'done' || status === 'skipped') return status;
  return 'queued';
}

/**
 * Pick the orchestrator-summary headline step per design D-13: first running
 * step, else first non-`done` step, else `null` when every step is done.
 * The "completed" literal is inserted at the render site when this returns
 * `null`.
 */
function headlineStep(plan: PipelinePlanResponse): PipelineStep | null {
  const running = plan.steps.find((step) => step.status === 'running');
  if (running) return running;
  const pending = plan.steps.find((step) => step.status !== 'done');
  if (pending) return pending;
  return null;
}

/** Props for {@link StepHeader}. The lifted accessors are required — this
 *  component only renders under `<Show when={selectedStep()}>`, so `taskId`
 *  is always a string by construction. */
interface StepHeaderProps {
  step: PipelineStep;
  now: number;
  events: Accessor<TaskEvent[]>;
  manifest: Accessor<ManifestResponse | null>;
  tokenUsage: Accessor<TokenUsageResponse | null>;
  taskId: string;
}

/**
 * Three-region header for a selected pipeline step. Renders the title row
 * (status dot + role + status pill + decision pill + elapsed), the
 * `role · agent` sub-line, and the five-stat counter strip. Swaps to a
 * reduced variant (no sub-line, no decision pill, three stats) when the
 * orchestrator pseudo-step is selected (`step.kind === 'orchestrator'`).
 */
function StepHeader(props: StepHeaderProps): JSX.Element {
  const elapsed = (): string =>
    formatElapsed(props.step.startedAt ?? null, props.step.completedAt ?? null, props.now);
  const isOrchestrator = (): boolean => props.step.kind === 'orchestrator';
  const skipped = createMemo<boolean>(() => isSkipped(props.step));
  const durationText = createMemo<string>(() => elapsed());
  const tokensForRole = createMemo<string>(() => {
    if (skipped()) return ELAPSED_FALLBACK;
    return tokensForStep(props.step, props.taskId, props.tokenUsage());
  });
  const toolCallCount = createMemo<string>(() => {
    if (skipped()) return ELAPSED_FALLBACK;
    return String(countToolCalls(props.events(), classify));
  });
  const filesTouchedCount = createMemo<string>(() => {
    if (skipped()) return ELAPSED_FALLBACK;
    const data = props.manifest();
    if (data === null) return ELAPSED_FALLBACK;
    return String(countFilesTouched(data, props.step.role));
  });
  const displayScore = createMemo<string>(() => displayScoreOf(props.step));

  /** Combined title text for the native tooltip. Role steps use
   *  `<role> @ <team>` so the tooltip matches the two-span render; the
   *  orchestrator step has no team qualifier. */
  const titleText = (): string =>
    isOrchestrator()
      ? props.step.role
      : `${props.step.role} @ ${props.step.team}`;

  return (
    <>
      <div class={styles.title}>
        <StatusDot
          state={toDotState(props.step.status)}
          variant={props.step.status === 'running' ? 'ring' : 'static'}
          size={8}
        />
        <span title={titleText()}>
          <Show
            when={!isOrchestrator()}
            fallback={props.step.role}
          >
            <RoleLabel role={props.step.role} team={props.step.team} />
          </Show>
        </span>
        <Pill state={toPillState(props.step.status)} />
        <Show when={!isOrchestrator()}>
          <DecisionPill state={deriveDecision(props.step)} />
        </Show>
        <span class={styles.elapsed}>{elapsed()}</span>
      </div>
      <Show when={!isOrchestrator()}>
        <div class={styles.subtitle}>
          <RoleLabel role={props.step.role} team={props.step.team} /> &middot; {props.step.agent}
        </div>
      </Show>
      <div class={styles.stats}>
        <div class={styles.stat}>
          <div class={styles.statLabel}>Duration</div>
          <div class={styles.statValue}>{durationText()}</div>
        </div>
        <div class={styles.stat}>
          <div class={styles.statLabel}>Tokens</div>
          <div class={styles.statValue}>{tokensForRole()}</div>
        </div>
        <div class={styles.stat}>
          <div class={styles.statLabel}>Tool calls</div>
          <div class={styles.statValue}>{toolCallCount()}</div>
        </div>
        <Show when={!isOrchestrator()}>
          <div class={styles.stat}>
            <div class={styles.statLabel}>Files touched</div>
            <div class={styles.statValue}>{filesTouchedCount()}</div>
          </div>
          <div class={styles.stat}>
            <div class={styles.statLabel}>Score</div>
            <div class={styles.statValue}>{displayScore()}</div>
          </div>
        </Show>
      </div>
    </>
  );
}

/**
 * Inline orchestrator-summary card shown when no step is selected. Lists each
 * step in `plan.steps` order with a `StatusDot` + role label. Highlights the
 * "current stage" (first running, else first non-done, else "completed").
 */
function OrchestratorSummary(props: { plan: PipelinePlanResponse }): JSX.Element {
  const headline = (): PipelineStep | null => headlineStep(props.plan);
  return (
    <div class={styles.summaryCard}>
      <div class={styles.summaryHeadline}>
        <Show
          when={headline()}
          fallback={<>completed</>}
        >
          {(step) => (
            <Show
              when={step().kind !== 'orchestrator'}
              fallback={step().role}
            >
              <RoleLabel role={step().role} team={step().team} />
            </Show>
          )}
        </Show>
      </div>
      <For each={props.plan.steps}>
        {(step) => {
          const current = headline();
          const isCurrent = (): boolean =>
            current !== null &&
            step.org === current.org &&
            step.team === current.team &&
            step.role === current.role;
          const rowClass = (): string => {
            const parts = [styles.summaryRow];
            if (isCurrent()) parts.push(styles.summaryRowCurrent);
            return parts.join(' ');
          };
          const rowTitle = (): string =>
            step.kind === 'orchestrator'
              ? step.role
              : `${step.role} @ ${step.team}`;
          return (
            <div class={rowClass()}>
              <StatusDot
                state={toDotState(step.status)}
                variant={step.status === 'running' ? 'ring' : 'static'}
                size={8}
              />
              <span class={styles.summaryRowName} title={rowTitle()}>
                <Show
                  when={step.kind !== 'orchestrator'}
                  fallback={step.role}
                >
                  <RoleLabel role={step.role} team={step.team} />
                </Show>
              </span>
              <span class={styles.summaryRowStatus}>{step.status}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

/** Right-column shell. See file header for behaviour. */
export const DetailPane: Component<DetailPaneProps> = (props) => {
  const selection = usePipelineSelection();
  const [tab, setTab] = createSignal<TabKey>('events');
  const [plan] = createResource(
    () => props.selectedTaskId(),
    async (id) => (id ? getPlan(id) : null),
  );

  const [now, setNow] = createSignal<number>(Date.now());
  const [tokenTick, setTokenTick] = createSignal<number>(0);
  onMount(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      setTokenTick((n) => n + 1);
    }, NOW_TICK_MS);
    onCleanup(() => clearInterval(timer));
  });

  // Lifted events store. The SSE subscription below is the sole writer; the
  // `events` accessor below is the read path exposed to StepHeader and to
  // the EventsTab body.
  const [eventStore, setEventStore] = createStore<{ events: TaskEvent[] }>({ events: [] });
  const events: Accessor<TaskEvent[]> = () => eventStore.events;

  // Lifted Events-tab filter state (redesign-018). Component-local; intentionally
  // NOT reset when `selectedTaskId` or `selectedStepId` change so the user's
  // "I want only tool calls" preference carries across role switches.
  const [filters, setFilters] = createStore<FiltersState>({ ...DEFAULT_FILTERS });
  const filtersAccessor: Accessor<FiltersState> = () => filters;
  const setFilter = (bucket: FilterBucket, on: boolean): void => {
    setFilters(bucket, on);
  };

  // Live indicator state (redesign-018). The SSE subscription below flips this
  // to `true` on `onopen` and back to `false` on `onerror`/teardown. In the
  // polling-fallback branch, the interval being active counts as "live".
  const [live, setLive] = createSignal<boolean>(false);

  /**
   * Append one event to the store, dropping any whose timestamp is `<=` the
   * last stored event's timestamp. Matches the guard in the former
   * EventsTab implementation so the history/stream join window stays safe.
   */
  const appendEvent = (event: TaskEvent): void => {
    const last = eventStore.events[eventStore.events.length - 1];
    if (last !== undefined && event.timestamp <= last.timestamp) return;
    setEventStore('events', (prev) => [...prev, event]);
  };

  /**
   * Convert a selected step identity into the `{org, team, role}` query
   * filter understood by the events endpoints. Returns `{}` for null
   * identities and for the synthetic orchestrator step whose `org`/`team`
   * are empty strings — the controller treats "missing any of the three"
   * as the unfiltered stream.
   */
  const identityToFilter = (
    identity: RoleIdentity | null,
  ): { org?: string; team?: string; role?: string } => {
    if (identity === null) return {};
    const { org, team, role } = identity;
    if (org === '' || team === '' || role === '') {
      // Orchestrator pseudo-step: fall back to role-only so the
      // server-side `getEventsByRole('orchestrator')` path still narrows the
      // stream (see web/src/controllers.ts handleEvents dispatch).
      if (role !== '') return { role };
      return {};
    }
    return { org, team, role };
  };

  // SSE subscription scoped to (taskId, selectedStepIdentity). Do NOT read
  // `events()` inside this effect body — that would subscribe the effect to
  // its own store and reopen the connection on every append (R-001). Also
  // drives the `live` signal: open → true, error/close/teardown → false.
  createEffect(on(
    [
      () => props.selectedTaskId(),
      () => selection.selectedStepIdentity(),
    ] as const,
    async ([taskId, identity]) => {
      setEventStore('events', []);
      setLive(false);
      if (taskId === null) return;
      const filter = identityToFilter(identity);
      const history = await getTaskEvents(taskId, filter);
      if (history === null) return;
      setEventStore('events', history);

      if (!hasEventSource) {
        // Polling fallback: re-fetch every POLL_FALLBACK_MS using the latest
        // stored timestamp as the lower bound. The interval being active
        // is treated as "live" for the indicator. The interval is cleared
        // via the effect's onCleanup so a task switch tears it down.
        const timer = setInterval(async () => {
          const last = eventStore.events[eventStore.events.length - 1];
          const opts: { org?: string; team?: string; role?: string; since?: string } = { ...filter };
          if (last !== undefined) opts.since = last.timestamp;
          const fresh = await getTaskEvents(taskId, opts);
          if (fresh === null) return;
          for (const event of fresh) appendEvent(event);
        }, POLL_FALLBACK_MS);
        setLive(true);
        onCleanup(() => {
          clearInterval(timer);
          setLive(false);
        });
        return;
      }

      const source = openTaskEventStream(taskId, filter);
      source.onopen = (): void => {
        setLive(true);
      };
      source.onerror = (): void => {
        setLive(false);
      };
      source.onmessage = (messageEvent: MessageEvent<string>): void => {
        try {
          const event = JSON.parse(messageEvent.data) as TaskEvent;
          appendEvent(event);
        } catch {
          // Malformed frames are silently dropped — the server-side contract
          // guarantees JSON-encoded TaskEvents, and a logged warning here
          // would spam the console without giving the user anything to act on.
        }
      };
      onCleanup(() => {
        source.close();
        setLive(false);
      });
    },
  ));

  const [manifest, { refetch: refetchManifest }] =
    createResource<ManifestResponse | null, string | null>(
      () => props.selectedTaskId(),
      async (id) => (id === null ? null : getManifest(id)),
    );

  // Token-usage polls on the `tokenTick` cadence (same 1-second interval as
  // the elapsed-label `now` signal). `fetchTokenUsage` returns the whole
  // per-task table so this single resource backs every selection without
  // a per-role refetch (design D-4, R-007).
  const [tokenUsage] = createResource<TokenUsageResponse | null, number>(
    tokenTick,
    async () => (await fetchTokenUsage()) ?? null,
  );

  // Fingerprint the tail event; when a new Write/Edit/NotebookEdit tool-call
  // lands, refetch the manifest so the Files-touched counter stays live
  // without a dedicated time-based poller (design D-5).
  const lastEventFingerprint = createMemo<string | null>(() => {
    const list = eventStore.events;
    const last = list[list.length - 1];
    return last ? `${last.timestamp}|${last.toolName ?? ''}` : null;
  });

  createEffect(on(
    lastEventFingerprint,
    (fingerprint) => {
      if (fingerprint === null) return;
      const list = eventStore.events;
      const last = list[list.length - 1];
      if (last === undefined) return;
      if (last.toolName !== undefined && MANIFEST_TRIGGERING_TOOLS.has(last.toolName)) {
        void refetchManifest();
      }
    },
    { defer: true },
  ));

  const safeManifest: Accessor<ManifestResponse | null> = () => manifest() ?? null;
  const safeTokenUsage: Accessor<TokenUsageResponse | null> = () => tokenUsage() ?? null;

  // Lifted task-files resource (redesign-021 §13 / §8). Provides the file list
  // that OpenSpecTab needs for the task-dir portion of the union AND drives the
  // `openspec` tab badge count — a single resource backs both without a second
  // fetch inside the tab body.
  const [taskFiles] = createResource<string[] | null, string | null>(
    () => props.selectedTaskId(),
    async (id) => (id === null ? null : getTaskFiles(id)),
  );

  const safeTaskFiles: Accessor<string[] | null> = () => taskFiles() ?? null;

  /**
   * Resolve the currently-selected step from the plan. Returns `null` when
   * either the plan has not loaded yet or the selected identity is no longer
   * in the plan (the latter should be impossible in practice but the guard
   * keeps the header from crashing during a race). Matches on the structured
   * `{org, team, role}` triple.
   */
  const selectedStep = createMemo<PipelineStep | null>(() => {
    const identity = selection.selectedStepIdentity();
    const planValue = plan();
    if (identity === null || !planValue) return null;
    return (
      planValue.steps.find(
        (step) =>
          step.org === identity.org &&
          step.team === identity.team &&
          step.role === identity.role,
      ) ?? null
    );
  });

  // Auto-select the currently running (or first non-done) step whenever the
  // plan becomes non-null and no step is explicitly selected. This fires once
  // per plan load and is a no-op when the user has already selected a step.
  // `PipelineSelectionContext` resets `selectedStepIdentity` to null on task
  // change, so this effect re-runs after each task switch as the plan loads.
  createEffect(on(
    plan,
    (loadedPlan) => {
      if (loadedPlan === null || loadedPlan === undefined) return;
      if (selection.selectedStepIdentity() !== null) return;
      const identity = pickAutoSelectStep(loadedPlan);
      if (identity !== null) {
        selection.setSelectedStepIdentity(identity);
      }
      // All steps done or plan has no non-done step — leave selection null.
    },
  ));

  const tabClass = (key: TabKey): string => {
    const parts = [styles.tab];
    if (tab() === key) parts.push(styles.tabActive);
    return parts.join(' ');
  };

  // Post-filter visible-event row count for the Events tab badge. Derived
  // from the same lifted `events` store + `filters` state that EventsTab
  // reads, so the badge stays in lock-step with the tab body.
  const visibleEventsCount = createMemo<number>(() =>
    countVisibleEvents(eventStore.events, filters),
  );

  /**
   * Count the Files-touched entries visible for the current task/step selection.
   * Delegates to the exported pure function {@link computeVisibleFilesCount}.
   */
  const visibleFilesCount = createMemo<number>(() =>
    computeVisibleFilesCount(
      safeManifest(),
      props.selectedTaskId(),
      selection.selectedStepIdentity(),
    ),
  );

  /**
   * Count the OpenSpec entries (union of task-dir .md files and manifest
   * openspec/changes/<taskId>/ entries) for the openspec tab badge.
   * Delegates to the exported pure function {@link computeVisibleOpenSpecCount}.
   */
  const visibleOpenSpecCount = createMemo<number>(() =>
    computeVisibleOpenSpecCount(safeManifest(), safeTaskFiles(), props.selectedTaskId()),
  );

  /**
   * Resolve the badge text appended after a tab label (e.g. "Events 12").
   * Returns `null` when no badge should render.
   * - `events` badge: count of visible events when a task is selected.
   * - `files` badge: count of visible Files-touched entries (openspec excluded).
   * - `openspec` badge: count of task-dir .md + openspec manifest entries.
   * - `config` is never badged.
   */
  const tabBadge = (key: TabKey): string | null => {
    if (props.selectedTaskId() === null) return null;
    if (key === 'events') return String(visibleEventsCount());
    if (key === 'files') return String(visibleFilesCount());
    if (key === 'openspec') return String(visibleOpenSpecCount());
    return null;
  };

  /**
   * Render the header fallback when no step is selected.
   * Three states:
   *   1. No task selected at all → `No task selected`.
   *   2. Task selected but plan not yet loaded → `Waiting for pipeline plan…`.
   *   3. Plan loaded, no step selected → `OrchestratorSummary`.
   */
  const headerFallback = (): JSX.Element => {
    if (props.selectedTaskId() === null) {
      return <div class={styles.placeholder}>No task selected</div>;
    }
    const loadedPlan = plan();
    if (!loadedPlan) {
      return <div class={styles.placeholder}>{'Waiting for pipeline plan\u2026'}</div>;
    }
    return <OrchestratorSummary plan={loadedPlan} />;
  };

  return (
    <aside class={styles.root} aria-label="Detail">
      <header class={styles.header}>
        <Show
          when={selectedStep()}
          fallback={headerFallback()}
        >
          {(step) => {
            // `taskId` is guaranteed non-null here because `selectedStep()`
            // only resolves when the plan loaded, which only happens with a
            // real task id.
            const taskId = (): string => props.selectedTaskId() ?? '';
            return (
              <StepHeader
                step={step()}
                now={now()}
                events={events}
                manifest={safeManifest}
                tokenUsage={safeTokenUsage}
                taskId={taskId()}
              />
            );
          }}
        </Show>
      </header>
      <nav class={styles.tabs} aria-label="Detail tabs">
        <For each={TABS}>
          {(descriptor) => {
            const badge = (): string | null => tabBadge(descriptor.key);
            return (
              <button
                type="button"
                class={tabClass(descriptor.key)}
                aria-pressed={tab() === descriptor.key}
                onClick={() => setTab(descriptor.key)}
              >
                {descriptor.label}
                <Show when={badge() !== null}>
                  <span class={styles.tabBadge}>{badge()}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </nav>
      <div class={styles.body}>
        <Switch>
          <Match when={tab() === 'events'}>
            <EventsTab
              taskId={props.selectedTaskId()}
              selectedStep={selection.selectedStepIdentity()}
              events={events}
              filters={filtersAccessor}
              setFilter={setFilter}
              live={live}
            />
          </Match>
          <Match when={tab() === 'files'}>
            <FilesTouchedTab
              taskId={props.selectedTaskId()}
              selectedStep={selection.selectedStepIdentity()}
              manifest={safeManifest}
            />
          </Match>
          <Match when={tab() === 'openspec'}>
            <OpenSpecTab
              taskId={props.selectedTaskId()}
              manifest={safeManifest}
              taskFiles={safeTaskFiles}
            />
          </Match>
          <Match when={tab() === 'config'}>
            <RoleConfigTab
              taskId={props.selectedTaskId()}
              selectedStep={selection.selectedStepIdentity()}
            />
          </Match>
        </Switch>
      </div>
    </aside>
  );
};
