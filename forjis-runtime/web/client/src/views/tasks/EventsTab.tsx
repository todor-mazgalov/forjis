/**
 * EventsTab — live event stream for the currently selected (taskId, stepId) pair.
 *
 * Owns the events list, the SSE subscription (only when {@link EventsTabProps.events}
 * is absent), and the polling fallback used when the runtime lacks `EventSource`.
 * Mounts once per `DetailPane` and re-subscribes whenever `props.taskId` or
 * `props.stepRoleId` changes — see design.md decisions D-3, D-4, D-5, D-6 of
 * redesign-008.
 *
 * Visual layout (redesign-018):
 *   1. Sticky filter row — four toggle chips ({@link FilterBucket}) plus a
 *      live/auto-scroll indicator on the right.
 *   2. Scrollable event body — one row per event, four visual buckets:
 *      collapsible {@link ToolCallBlock} for tool calls, a nested result row
 *      inside its parent block for tool results, a red-bordered one-liner for
 *      `error`, and a plain one-liner for everything else.
 *
 * Filter state is owned by the parent (DetailPane) so the Events tab badge can
 * render the post-filter count from the same memo. Auto-scroll state is local
 * to this component — it follows the body's scroll position, not a parent.
 *
 * The SSE handler de-dupes on append by dropping events whose timestamp is
 * `<=` the last stored event's timestamp — see risk R-2 in design.md for why
 * the join window between history and stream needs that guard.
 */

import type { Accessor, Component, JSX } from 'solid-js';
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from 'solid-js';
import { createStore } from 'solid-js/store';
import type { RoleIdentity, TaskEvent } from '@forjis/shared';
import { getTaskEvents, openTaskEventStream } from '../../shell/api';
import { highlight } from './highlighter';
import { EVENTS_PREVIEW_LINES, ToolCallBlock } from './ToolCallBlock';
import { ToolResultBlock } from './ToolResultBlock';
import styles from './EventsTab.module.css';

export { EVENTS_PREVIEW_LINES };

/**
 * Convert a selected step identity triple into the `{org?, team?, role?}`
 * query filter accepted by the events endpoints. Exported so DetailPane can
 * reuse the same rule when it owns the subscription. The synthetic
 * orchestrator step has empty `org`/`team`; the filter downgrades to
 * role-only so the controller routes to `getEventsByRole('orchestrator')`.
 */
export function identityToEventsFilter(
  identity: RoleIdentity | null,
): { org?: string; team?: string; role?: string } {
  if (identity === null) return {};
  const { org, team, role } = identity;
  if (org === '' || team === '' || role === '') {
    if (role !== '') return { role };
    return {};
  }
  return { org, team, role };
}

/** Polling cadence used when `EventSource` is unavailable. */
const POLL_FALLBACK_MS = 1500;

/**
 * True when the current runtime exposes the `EventSource` constructor. Read
 * once at module load — flipping it at runtime is not supported by browsers.
 */
const hasEventSource = typeof EventSource !== 'undefined';

/** Pixel slack used by the auto-scroll edge detector. A user is considered
 *  "at the bottom" when `scrollTop + clientHeight >= scrollHeight - SLACK`. */
const AUTO_SCROLL_EDGE_SLACK_PX = 8;

/**
 * Maximum number of event rows painted into the DOM. Older events stay in the
 * source store (so chip counts, filter recomputation, and future history
 * scroll can still see them) but are hidden from the `<For>` so long-running
 * tasks with thousands of events don't blow the browser's layout budget.
 *
 * Keeps the newest N because the auto-scroll UX already anchors users to the
 * tail; anyone reviewing history disables auto-scroll or opens the per-role
 * event file on disk.
 */
const RENDER_CAP = 300;

/** Visual bucket for a single event. Drives the row variant in the body. */
type EventBucket = 'tool-call' | 'tool-result' | 'one-line' | 'error';

/**
 * Filter bucket — one chip per value. Distinct from {@link EventBucket}: the
 * filter taxonomy collapses `assistant` into a `message` chip and treats
 * `tool-result` events as part of their parent `tool-call` group (the parent
 * already cascades visibility to nested results).
 */
export type FilterBucket = 'tool-call' | 'message' | 'system' | 'error';

/** Toggle map. `true` means the bucket is shown; `false` means hidden. */
export type FiltersState = Record<FilterBucket, boolean>;

/** Default filter state for redesign-018: every bucket on at first render. */
export const DEFAULT_FILTERS: FiltersState = {
  'tool-call': true,
  message: true,
  system: true,
  error: true,
};

/** Tool-call render item — carries its bucket of paired result events. */
interface ToolCallItem { kind: 'tool-call'; event: TaskEvent; results: TaskEvent[] }
/** Standard one-line render item used by system/assistant/text/load buckets. */
interface OneLineItem { kind: 'one-line'; event: TaskEvent }
/** Error render item — same shape as one-line but renders with red border. */
interface ErrorItem { kind: 'error'; event: TaskEvent }

/** Render-ready item for the body's `<For>`. Tool-result events are folded
 *  into the parent ToolCallItem's `results` and never appear at the top level. */
type RenderItem = ToolCallItem | OneLineItem | ErrorItem;

/** Props for {@link EventsTab}. */
export interface EventsTabProps {
  /** Currently selected task id. Null → renders the "select a task" empty state. */
  taskId: string | null;
  /** Currently selected step identity triple, or null for the unfiltered stream. */
  selectedStep: RoleIdentity | null;
  /**
   * Lifted events accessor. When provided, EventsTab reads from it instead of
   * running its own fetch + SSE subscription — the DetailPane-owned store
   * becomes the single source of truth for the tab body and the header's
   * tool-call counter. When absent, the tab falls back to the internal
   * fetch+subscribe path so unit tests that construct this component
   * directly (without DetailPane) keep working unchanged.
   */
  events?: Accessor<TaskEvent[]>;
  /**
   * Lifted filter state. Defaulted to {@link DEFAULT_FILTERS} when absent so
   * direct unit construction still works. When the parent (DetailPane) owns
   * the filter signal, the tab badge can read the same post-filter count
   * without re-deriving it.
   */
  filters?: Accessor<FiltersState>;
  /**
   * Toggle a single filter bucket. Required only when `filters` is provided —
   * the chip onClicks delegate here so the parent owns mutation.
   */
  setFilter?: (bucket: FilterBucket, on: boolean) => void;
  /**
   * Whether the underlying SSE channel (or polling fallback) is currently
   * active. Drives the live indicator dot. Defaults to `false` so direct
   * unit construction renders the dim/disconnected variant.
   */
  live?: Accessor<boolean>;
}

/**
 * Classify a single event into one of four visual (rendering) buckets. Order
 * matches design D-5: errors first, then tool-result (user + parentId +
 * toolName), then tool-call (toolName + payload), then everything else as
 * one-liner.
 *
 * Re-exported (see module footer) so DetailPane can reuse the same rule for
 * its header tool-call counter without duplicating the four-bucket logic.
 */
export function classify(event: TaskEvent): EventBucket {
  if (event.type === 'error') return 'error';
  if (
    event.toolName !== undefined &&
    event.parentId !== undefined &&
    event.type === 'user'
  ) {
    return 'tool-result';
  }
  if (event.toolName !== undefined && event.payload !== undefined) {
    return 'tool-call';
  }
  return 'one-line';
}

/**
 * Map an event onto its filter bucket, or `null` when the event is not
 * counted by any chip (e.g. `tool-result` rows piggy-back on their parent
 * `tool-call` chip and have no chip of their own). Used both by the chip
 * count memos and by the visibility filter.
 */
export function filterBucketOf(event: TaskEvent): FilterBucket | null {
  if (event.type === 'error') return 'error';
  const renderBucket = classify(event);
  if (renderBucket === 'tool-call') return 'tool-call';
  // tool-result events are visually nested inside their parent tool-call
  // block; the parent's chip already governs them, so they have no chip of
  // their own.
  if (renderBucket === 'tool-result') return null;
  if (event.type === 'system') return 'system';
  if (event.type === 'assistant') return 'message';
  return null;
}

/**
 * Drop events whose filter bucket is currently toggled off. `tool-result`
 * events (which return `null` from {@link filterBucketOf}) follow the
 * `tool-call` chip — turning that chip off hides the parent and every
 * nested result together (TASK.md §1). When the chip is on, results stay
 * in the list so {@link buildVisibleEvents} can fold them under their
 * parent block.
 */
function applyFilters(events: readonly TaskEvent[], filters: FiltersState): TaskEvent[] {
  return events.filter((event) => {
    const bucket = filterBucketOf(event);
    if (bucket === null) {
      // Tool-result rows piggy-back on the tool-call chip.
      return classify(event) === 'tool-result' ? filters['tool-call'] : true;
    }
    return filters[bucket];
  });
}

/**
 * Build the visible item list from the raw event store. Single-pass O(n) per
 * design D-6: tool-results are appended to the matching parent ToolCallItem's
 * `results` rather than rendered as top-level rows. Orphan results (no
 * matching parent yet) fall back to the one-liner bucket so the UI does not
 * crash on out-of-order delivery.
 */
function buildVisibleEvents(events: readonly TaskEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  const indexByParentId = new Map<string, number>();
  for (const event of events) {
    const bucket = classify(event);
    if (bucket === 'tool-result') {
      const key = event.parentId as string;
      const targetIdx = indexByParentId.get(key);
      if (targetIdx !== undefined) {
        const target = items[targetIdx];
        if (target !== undefined && target.kind === 'tool-call') {
          target.results.push(event);
          continue;
        }
      }
      items.push({ kind: 'one-line', event });
      continue;
    }
    if (bucket === 'tool-call') {
      const key = event.parentId ?? `_self_${items.length}`;
      items.push({ kind: 'tool-call', event, results: [] });
      indexByParentId.set(key, items.length - 1);
      continue;
    }
    if (bucket === 'error') {
      items.push({ kind: 'error', event });
      continue;
    }
    items.push({ kind: 'one-line', event });
  }
  return items;
}

/** Format an ISO timestamp as `HH:MM:SS` in the user's local time zone. */
function formatTimeOfDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Pick the right badge tint class for an event type. Falls back to the
 * neutral `.typeBadge` colour for anything outside the known bucket set so
 * future event types stay readable without code changes.
 */
function badgeClass(type: string): string {
  if (type === 'assistant') return styles.badgeAssistant;
  if (type === 'user') return styles.badgeUser;
  if (type === 'system') return styles.badgeSystem;
  if (type === 'error') return styles.badgeError;
  return '';
}

/** Display label for each filter chip. */
const CHIP_LABEL: Record<FilterBucket, string> = {
  'tool-call': 'Tool calls',
  message: 'Messages',
  system: 'System',
  error: 'Errors',
};

/**
 * Order in which the chips render. Stable across renders so the row layout
 * does not flicker when chip counts change.
 */
const CHIP_ORDER: readonly FilterBucket[] = ['tool-call', 'message', 'system', 'error'];

/**
 * Render a single one-line event row. Used for the standard buckets, for
 * orphan tool-results, and (with `errorMode = true`) for the red-bordered
 * error bucket. Pure presentational — no signals, no effects.
 */
function OneLineRow(props: { event: TaskEvent; errorMode?: boolean }): JSX.Element {
  const rowClass = (): string => {
    const parts = [styles.eventRow];
    if (props.errorMode) parts.push(styles.eventError);
    return parts.join(' ');
  };
  return (
    <div class={rowClass()}>
      <div class={styles.eventOneLine}>
        <span class={`${styles.typeBadge} ${badgeClass(props.event.type)}`}>
          {props.event.type}
        </span>
        <span class={styles.eventOneLineContent} title={props.event.content}>
          {props.event.content}
        </span>
        <span class={styles.timestamp}>{formatTimeOfDay(props.event.timestamp)}</span>
      </div>
    </div>
  );
}

/** Narrowing accessors used in the `<Match when>` slots. Each returns the
 *  specifically-typed variant or `null`, so Solid's keyed-callback signature
 *  hands the correct type to the child render function. */
const asToolCall = (item: RenderItem): ToolCallItem | null =>
  item.kind === 'tool-call' ? item : null;
const asError = (item: RenderItem): ErrorItem | null =>
  item.kind === 'error' ? item : null;
const asOneLine = (item: RenderItem): OneLineItem | null =>
  item.kind === 'one-line' ? item : null;

/**
 * Inline component that picks the right row variant for a single render item.
 * Centralises the discriminated-union switch so the parent's `<For>` body
 * stays a single expression and `ToolCallBlock` keeps its `renderResult`
 * slot pointing at the same `OneLineRow` used by top-level rows.
 */
function EventRow(props: { item: RenderItem }): JSX.Element {
  return (
    <Switch>
      <Match when={asToolCall(props.item)}>
        {(toolCall) => (
          <ToolCallBlock
            event={toolCall().event}
            results={toolCall().results}
            highlight={highlight}
            renderResult={(result) => <ToolResultBlock event={result} />}
          />
        )}
      </Match>
      <Match when={asError(props.item)}>
        {(errorItem) => <OneLineRow event={errorItem().event} errorMode />}
      </Match>
      <Match when={asOneLine(props.item)}>
        {(oneLine) => <OneLineRow event={oneLine().event} />}
      </Match>
    </Switch>
  );
}

/**
 * Render the sticky chip row + the live indicator. Pure presentational —
 * receives counts and toggle callbacks from the parent. Extracted as an
 * inline component so the main `EventsTab` body stays focused on data flow.
 */
function FilterRow(props: {
  filters: FiltersState;
  counts: Record<FilterBucket, number>;
  toggle: (bucket: FilterBucket) => void;
  live: boolean;
}): JSX.Element {
  return (
    <div class={styles.filterRow}>
      <For each={CHIP_ORDER}>
        {(bucket) => {
          const isOn = (): boolean => props.filters[bucket];
          const chipClass = (): string => {
            const parts = [styles.filterChip];
            if (isOn()) parts.push(styles.filterChipOn);
            return parts.join(' ');
          };
          return (
            <button
              type="button"
              class={chipClass()}
              aria-pressed={isOn()}
              onClick={() => props.toggle(bucket)}
            >
              <span class={styles.filterChipDot} />
              <span class={styles.filterChipLabel}>{CHIP_LABEL[bucket]}</span>
              <span class={styles.filterChipCount}>{props.counts[bucket]}</span>
            </button>
          );
        }}
      </For>
      <div class={styles.liveIndicator} aria-live="polite">
        <span class={`${styles.liveDot} ${props.live ? styles.liveDotOn : ''}`} />
        <span>live · auto-scroll</span>
      </div>
    </div>
  );
}

/** Live events list. See file header for behaviour. */
export const EventsTab: Component<EventsTabProps> = (props) => {
  const [state, setState] = createStore<{ events: TaskEvent[] }>({ events: [] });

  /**
   * Append one event to the internal fallback store, dropping any whose
   * timestamp is `<=` the last stored event's timestamp. Guards against the
   * SSE/history join overlap window described in risk R-2.
   */
  const appendEvent = (event: TaskEvent): void => {
    const last = state.events[state.events.length - 1];
    if (last !== undefined && event.timestamp <= last.timestamp) return;
    setState('events', (prev) => [...prev, event]);
  };

  // When DetailPane passes an `events` accessor, skip the local store and
  // subscription entirely — the parent owns a single SSE connection keyed on
  // (taskId, stepRoleId) and hands the materialised list down here. Absent
  // the prop (direct construction in unit tests), fall back to the internal
  // fetch+subscribe flow below.
  const sourceEvents = (): TaskEvent[] =>
    props.events !== undefined ? props.events() : state.events;

  // Filter state defaults to "all on" so direct construction renders every
  // event. When DetailPane passes the lifted `filters`, the parent owns the
  // truth and `setFilter` toggles propagate back upstream.
  const filters = (): FiltersState => props.filters ? props.filters() : DEFAULT_FILTERS;
  const live = (): boolean => props.live ? props.live() : false;

  const toggleFilter = (bucket: FilterBucket): void => {
    if (props.setFilter !== undefined) {
      props.setFilter(bucket, !filters()[bucket]);
    }
  };

  // Counts are derived from the unfiltered stream so a chip's number reflects
  // total available events for that bucket, not the post-toggle visible count.
  const chipCounts = createMemo<Record<FilterBucket, number>>(() => {
    const totals: Record<FilterBucket, number> = {
      'tool-call': 0,
      message: 0,
      system: 0,
      error: 0,
    };
    for (const event of sourceEvents()) {
      const bucket = filterBucketOf(event);
      if (bucket !== null) totals[bucket] += 1;
    }
    return totals;
  });

  // Fold + filter once per sourceEvents/filters change; downstream memos read
  // the cached list. Otherwise each derived view (render slice, hidden count)
  // would re-run `buildVisibleEvents` independently on every append.
  const allVisible = createMemo<RenderItem[]>(() =>
    buildVisibleEvents(applyFilters(sourceEvents(), filters())),
  );

  // Render cap — see {@link RENDER_CAP}. Hides older rows from the DOM to
  // keep the browser responsive on long-running tasks while leaving the
  // store intact for chip counts and the "earlier events hidden" banner.
  const visibleEvents = createMemo<RenderItem[]>(() => {
    const items = allVisible();
    if (items.length <= RENDER_CAP) return items;
    return items.slice(items.length - RENDER_CAP);
  });

  /** Number of older events present in the store but hidden by the render
   *  cap. Drives the "N earlier events hidden" banner above the list. */
  const hiddenOlderCount = createMemo<number>(() => {
    const total = allVisible().length;
    return total > RENDER_CAP ? total - RENDER_CAP : 0;
  });

  if (props.events === undefined) {
    // Subscribe to (taskId, selectedStep). The `on()` form means the body re-runs
    // on every change to either accessor; the inner cleanup tears down the
    // previous subscription before the next one is opened.
    createEffect(on(
      () => [props.taskId, props.selectedStep] as const,
      async ([taskId, identity]) => {
        setState('events', []);
        if (taskId === null) return;
        const filter = identityToEventsFilter(identity);
        const history = await getTaskEvents(taskId, filter);
        if (history === null) return;
        setState('events', history);

        if (!hasEventSource) {
          // Polling fallback: re-fetch every POLL_FALLBACK_MS using the latest
          // stored timestamp as the lower bound. The interval is cleared via
          // the same `onCleanup` so a task switch tears it down.
          const timer = setInterval(async () => {
            const last = state.events[state.events.length - 1];
            const opts: { org?: string; team?: string; role?: string; since?: string } = { ...filter };
            if (last !== undefined) opts.since = last.timestamp;
            const fresh = await getTaskEvents(taskId, opts);
            if (fresh === null) return;
            for (const event of fresh) appendEvent(event);
          }, POLL_FALLBACK_MS);
          onCleanup(() => clearInterval(timer));
          return;
        }

        const source = openTaskEventStream(taskId, filter);
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
        onCleanup(() => source.close());
      },
    ));
  }

  // Auto-scroll: hold a ref to the scrollable body, pin to the bottom on
  // every visibleEvents() update, and pause when the user scrolls up. The
  // signal flips back to `true` automatically when the user scrolls back to
  // the bottom edge.
  let bodyRef: HTMLDivElement | undefined;
  const [autoScroll, setAutoScroll] = createSignal<boolean>(true);

  const isAtBottom = (el: HTMLDivElement): boolean =>
    el.scrollTop + el.clientHeight >= el.scrollHeight - AUTO_SCROLL_EDGE_SLACK_PX;

  const handleBodyScroll = (event: Event): void => {
    const el = event.currentTarget as HTMLDivElement;
    setAutoScroll(isAtBottom(el));
  };

  // Scroll to bottom on every visibleEvents change, but only when auto-scroll
  // is enabled. Read the memo so the effect re-runs on append; read autoScroll
  // inside the same body so it stays current.
  createEffect(() => {
    visibleEvents();
    if (!autoScroll()) return;
    const el = bodyRef;
    if (el === undefined) return;
    // Defer to the next microtask so the DOM has flushed the new rows
    // before we measure scrollHeight.
    queueMicrotask(() => {
      if (bodyRef === undefined) return;
      bodyRef.scrollTop = bodyRef.scrollHeight;
    });
  });

  return (
    <div class={styles.root}>
      <Show when={props.taskId !== null}>
        <FilterRow
          filters={filters()}
          counts={chipCounts()}
          toggle={toggleFilter}
          live={live()}
        />
      </Show>
      <div class={styles.body} ref={bodyRef} onScroll={handleBodyScroll}>
        <Show
          when={props.taskId !== null}
          fallback={<div class={styles.placeholder}>Select a task to see events</div>}
        >
          <Show
            when={visibleEvents().length > 0}
            fallback={<div class={styles.placeholder}>No events yet</div>}
          >
            <Show when={hiddenOlderCount() > 0}>
              <div class={styles.placeholder}>
                {hiddenOlderCount()} earlier events hidden · open the per-role event file on disk to review
              </div>
            </Show>
            <For each={visibleEvents()}>
              {(item) => <EventRow item={item} />}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
};
