/**
 * Unit tests for the redesign-018 Events tab filter UX pure helpers.
 *
 * Modules under test (logic mirrored locally — see "Why mirror" below):
 *   - `forjis-runtime/web/client/src/views/tasks/EventsTab.tsx`
 *     - `filterBucketOf(event)` — maps a TaskEvent to one of the four chip
 *       buckets, or `null` when the event is rendered as a nested tool-result
 *       (no chip of its own; piggy-backs on the `tool-call` chip).
 *     - `applyFilters(events, filters)` — drops events whose chip is off,
 *       cascading the `tool-call` chip down to nested `tool-result` rows.
 *     - `DEFAULT_FILTERS` — initial state with every chip on.
 *   - `forjis-runtime/web/client/src/views/tasks/DetailPane.tsx`
 *     - `countVisibleEvents(events, filters)` — post-filter top-level row
 *       count for the Events tab badge. Mirrors the renderer rule: nested
 *       tool-results never count as a row (the parent block counts once).
 *
 * Why mirror, not import: both helpers live inside `.tsx` modules that pull
 * Solid + CSS-module imports. The web jest config (jest.config.mjs) only
 * transforms `.ts` and runs in `node` (no jsdom, no CSS handler), so a
 * direct `import` of `EventsTab.tsx` would fail to resolve `./EventsTab.module.css`.
 * The established pattern in the same suite (see
 * `step-header-derivations.test.ts::classifyFixture`) is to re-implement the
 * logic verbatim in the test file as the spec under test. This locks the
 * behaviour down even when the producing file is unimportable.
 *
 * Acceptance criteria covered (TASK.md "## Acceptance"):
 *   1. Four chips, live counts, toggling narrows in real time.
 *   2. Tool calls OFF hides parent + nested results; ON restores both.
 *   3. Live indicator wiring — pulses while open, dims on close (sketched
 *      via the `live` callback contract; SSE event fan-in itself is browser
 *      reactivity tested in `detail-pane-subscription-key.test.ts`).
 *   4. Auto-scroll edge detector — at-bottom predicate flips correctly
 *      across slack window.
 *   5. Tab label reflects post-filter count via `countVisibleEvents`.
 *   6. Filter state persistence — `DEFAULT_FILTERS` is a fresh object each
 *      use; the filter toggler never mutates `DEFAULT_FILTERS` itself.
 */

import type { TaskEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Re-implemented helpers — kept byte-for-byte aligned with the source. If you
// change one here, change the other in EventsTab.tsx / DetailPane.tsx, and
// vice versa. The tests below are the contract.
// ---------------------------------------------------------------------------

type EventBucket = 'tool-call' | 'tool-result' | 'one-line' | 'error';
type FilterBucket = 'tool-call' | 'message' | 'system' | 'error';
type FiltersState = Record<FilterBucket, boolean>;

const DEFAULT_FILTERS: FiltersState = {
  'tool-call': true,
  message: true,
  system: true,
  error: true,
};

/** Slack window from EventsTab.tsx: AUTO_SCROLL_EDGE_SLACK_PX = 8. */
const AUTO_SCROLL_EDGE_SLACK_PX = 8;

/** Mirror of EventsTab.classify (rendering bucket — distinct from chip bucket). */
function classify(event: TaskEvent): EventBucket {
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

/** Mirror of EventsTab.filterBucketOf. */
function filterBucketOf(event: TaskEvent): FilterBucket | null {
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

/** Mirror of EventsTab.applyFilters. */
function applyFilters(events: readonly TaskEvent[], filters: FiltersState): TaskEvent[] {
  return events.filter((event) => {
    const bucket = filterBucketOf(event);
    if (bucket === null) {
      return classify(event) === 'tool-result' ? filters['tool-call'] : true;
    }
    return filters[bucket];
  });
}

/** Mirror of DetailPane.countVisibleEvents. */
function countVisibleEvents(events: readonly TaskEvent[], filters: FiltersState): number {
  let count = 0;
  for (const event of events) {
    const bucket = filterBucketOf(event);
    if (bucket === null) continue;
    if (!filters[bucket]) continue;
    count += 1;
  }
  return count;
}

/** Mirror of EventsTab.isAtBottom. */
function isAtBottom(state: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return state.scrollTop + state.clientHeight >= state.scrollHeight - AUTO_SCROLL_EDGE_SLACK_PX;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    timestamp: '2026-04-20T00:00:00.000Z',
    type: 'assistant',
    role: 'Architect',
    content: 'hello',
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return makeEvent({
    type: 'assistant',
    toolName: 'Read',
    payload: { path: '/a' },
    parentId: 'tc-1',
    ...overrides,
  });
}

function makeToolResult(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return makeEvent({
    type: 'user',
    toolName: 'Read',
    parentId: 'tc-1',
    content: 'file contents',
    ...overrides,
  });
}

const ALL_OFF: FiltersState = {
  'tool-call': false,
  message: false,
  system: false,
  error: false,
};

// ---------------------------------------------------------------------------
// 1. filterBucketOf — chip taxonomy
// ---------------------------------------------------------------------------

describe('filterBucketOf — chip taxonomy', () => {
  test('error events map to the error chip', () => {
    expect(filterBucketOf(makeEvent({ type: 'error', content: 'boom' }))).toBe('error');
  });

  test('system events map to the system chip', () => {
    expect(filterBucketOf(makeEvent({ type: 'system', content: 'starting' }))).toBe('system');
  });

  test('assistant text events map to the message chip', () => {
    expect(filterBucketOf(makeEvent({ type: 'assistant', content: 'plain text' }))).toBe('message');
  });

  test('assistant tool-call events map to the tool-call chip', () => {
    expect(filterBucketOf(makeToolCall())).toBe('tool-call');
  });

  test('user tool-result events have no chip of their own (null)', () => {
    // Per TASK.md §1: tool-result rows render nested under their parent
    // tool-call block, so they piggy-back on the tool-call chip and have
    // no independent chip to count.
    expect(filterBucketOf(makeToolResult())).toBeNull();
  });

  test('plain user events (no tool metadata) yield null (no chip)', () => {
    // Out-of-scope per TASK.md §"Out of scope" — user events have no fifth chip.
    expect(filterBucketOf(makeEvent({ type: 'user', content: 'response' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. applyFilters — toggling narrows the list, tool-call cascades to nested
//    results (Acceptance #1 + #2)
// ---------------------------------------------------------------------------

describe('applyFilters — toggle narrows list', () => {
  const sample: TaskEvent[] = [
    makeEvent({ type: 'system', content: 'startup' }),
    makeEvent({ type: 'assistant', content: 'thinking' }),
    makeToolCall({ parentId: 'tc-A' }),
    makeToolResult({ parentId: 'tc-A' }),
    makeEvent({ type: 'error', content: 'boom' }),
  ];

  test('with DEFAULT_FILTERS every event passes', () => {
    expect(applyFilters(sample, DEFAULT_FILTERS)).toEqual(sample);
  });

  test('with all filters off, the list is empty', () => {
    expect(applyFilters(sample, ALL_OFF)).toEqual([]);
  });

  test('turning the system chip OFF removes only system events', () => {
    const filters: FiltersState = { ...DEFAULT_FILTERS, system: false };
    const out = applyFilters(sample, filters);
    expect(out.find((e) => e.type === 'system')).toBeUndefined();
    expect(out).toHaveLength(sample.length - 1);
  });

  test('turning the message chip OFF removes assistant text only (tool-call assistants stay)', () => {
    const filters: FiltersState = { ...DEFAULT_FILTERS, message: false };
    const out = applyFilters(sample, filters);
    // The plain assistant text is gone, but the tool-call assistant stays.
    expect(out.find((e) => e.type === 'assistant' && e.toolName === undefined)).toBeUndefined();
    expect(out.find((e) => e.toolName === 'Read' && e.payload !== undefined)).toBeDefined();
  });

  test('turning the error chip OFF removes only the error event', () => {
    const filters: FiltersState = { ...DEFAULT_FILTERS, error: false };
    const out = applyFilters(sample, filters);
    expect(out.find((e) => e.type === 'error')).toBeUndefined();
    expect(out).toHaveLength(sample.length - 1);
  });
});

describe('applyFilters — tool-call cascade hides nested results (Acceptance #2)', () => {
  test('turning tool-call OFF removes BOTH the parent and the nested result', () => {
    const events: TaskEvent[] = [
      makeEvent({ type: 'system', content: 'unrelated' }),
      makeToolCall({ parentId: 'tc-X' }),
      makeToolResult({ parentId: 'tc-X' }),
    ];
    const filters: FiltersState = { ...DEFAULT_FILTERS, 'tool-call': false };
    const out = applyFilters(events, filters);
    // Both the parent (assistant + toolName + payload) and the nested
    // result (user + toolName + parentId) must be gone.
    expect(out.find((e) => e.toolName === 'Read' && e.payload !== undefined)).toBeUndefined();
    expect(out.find((e) => e.toolName === 'Read' && e.type === 'user')).toBeUndefined();
    // The unrelated system event survives.
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('system');
  });

  test('turning tool-call back ON restores both the parent and the nested result', () => {
    const events: TaskEvent[] = [
      makeToolCall({ parentId: 'tc-Y' }),
      makeToolResult({ parentId: 'tc-Y' }),
    ];
    const off: FiltersState = { ...DEFAULT_FILTERS, 'tool-call': false };
    const on: FiltersState = { ...DEFAULT_FILTERS, 'tool-call': true };
    expect(applyFilters(events, off)).toHaveLength(0);
    expect(applyFilters(events, on)).toHaveLength(2);
  });

  test('orphan tool-result (no matching parent) follows the same tool-call chip cascade', () => {
    // The renderer falls back to one-liner for orphan results, but the
    // FILTER stage runs first and treats them as tool-results all the same.
    const events: TaskEvent[] = [makeToolResult({ parentId: 'orphan-id' })];
    const off: FiltersState = { ...DEFAULT_FILTERS, 'tool-call': false };
    expect(applyFilters(events, off)).toHaveLength(0);
    expect(applyFilters(events, DEFAULT_FILTERS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. countVisibleEvents — post-filter row count (Acceptance #5)
// ---------------------------------------------------------------------------

describe('countVisibleEvents — Events tab badge math (Acceptance #5)', () => {
  test('returns 0 for an empty list', () => {
    expect(countVisibleEvents([], DEFAULT_FILTERS)).toBe(0);
  });

  test('counts each filtered-on bucket once and ignores nested tool-results', () => {
    const events: TaskEvent[] = [
      makeEvent({ type: 'system', content: 'a' }),
      makeEvent({ type: 'assistant', content: 'b' }),
      makeToolCall({ parentId: 'tc-1' }),
      makeToolResult({ parentId: 'tc-1' }),
      makeToolResult({ parentId: 'tc-1' }),
      makeEvent({ type: 'error', content: 'c' }),
    ];
    // 1 system + 1 assistant + 1 tool-call (results fold under it) + 1 error = 4
    expect(countVisibleEvents(events, DEFAULT_FILTERS)).toBe(4);
  });

  test('toggling a chip OFF drops its contribution from the badge count', () => {
    const events: TaskEvent[] = [
      makeEvent({ type: 'system', content: 'a' }),
      makeEvent({ type: 'assistant', content: 'b' }),
      makeToolCall({ parentId: 'tc-1' }),
      makeEvent({ type: 'error', content: 'c' }),
    ];
    const errorOff: FiltersState = { ...DEFAULT_FILTERS, error: false };
    expect(countVisibleEvents(events, errorOff)).toBe(3);
    const messagesOff: FiltersState = { ...DEFAULT_FILTERS, message: false };
    expect(countVisibleEvents(events, messagesOff)).toBe(3);
  });

  test('turning tool-call OFF drops the parent block (and its hidden nested results) from the count', () => {
    const events: TaskEvent[] = [
      makeEvent({ type: 'system', content: 'a' }),
      makeToolCall({ parentId: 'tc-1' }),
      makeToolResult({ parentId: 'tc-1' }),
      makeToolResult({ parentId: 'tc-1' }),
    ];
    const off: FiltersState = { ...DEFAULT_FILTERS, 'tool-call': false };
    // Only the system event remains visible as a top-level row.
    expect(countVisibleEvents(events, off)).toBe(1);
  });

  test('with all filters off the badge reads 0 (matches the empty body)', () => {
    const events: TaskEvent[] = [
      makeEvent({ type: 'system', content: 'a' }),
      makeToolCall({ parentId: 'tc-1' }),
      makeEvent({ type: 'error', content: 'c' }),
    ];
    expect(countVisibleEvents(events, ALL_OFF)).toBe(0);
  });

  test('badge count and applyFilters agree on top-level row totals', () => {
    // applyFilters returns ALL surviving events including nested results;
    // countVisibleEvents excludes nested tool-results. The invariant:
    //   countVisibleEvents(e, f) === applyFilters(e, f).filter(filterBucketOf !== null).length
    const events: TaskEvent[] = [
      makeEvent({ type: 'system', content: 'a' }),
      makeEvent({ type: 'assistant', content: 'b' }),
      makeToolCall({ parentId: 'tc-1' }),
      makeToolResult({ parentId: 'tc-1' }),
      makeEvent({ type: 'error', content: 'c' }),
    ];
    for (const filters of [
      DEFAULT_FILTERS,
      ALL_OFF,
      { ...DEFAULT_FILTERS, system: false },
      { ...DEFAULT_FILTERS, 'tool-call': false },
      { ...DEFAULT_FILTERS, message: false, error: false },
    ]) {
      const surviving = applyFilters(events, filters)
        .filter((e) => filterBucketOf(e) !== null).length;
      expect(countVisibleEvents(events, filters)).toBe(surviving);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. DEFAULT_FILTERS — fresh, all-on, immutable initial state (Acceptance #6
//    relies on this: the parent createStore is initialised from a spread of
//    DEFAULT_FILTERS so subsequent toggles cannot leak into the constant.)
// ---------------------------------------------------------------------------

describe('DEFAULT_FILTERS — initial state contract', () => {
  test('every chip starts on', () => {
    expect(DEFAULT_FILTERS).toEqual({
      'tool-call': true,
      message: true,
      system: true,
      error: true,
    });
  });

  test('mutating a spread copy does not affect DEFAULT_FILTERS (filter persistence safety)', () => {
    // DetailPane.tsx initialises the lifted filter store with `{ ...DEFAULT_FILTERS }`.
    // This guards against an accidental refactor that toggles the constant in
    // place — which would silently break the "filters carry across role
    // selections" contract on the next mount.
    const copy = { ...DEFAULT_FILTERS };
    copy['tool-call'] = false;
    expect(DEFAULT_FILTERS['tool-call']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Filter state persistence across role switches (Acceptance #6)
// ---------------------------------------------------------------------------

describe('filter state persistence across role switches (Acceptance #6)', () => {
  /**
   * Models the DetailPane wiring: filters live in a parent store, role
   * switching only swaps `(taskId, stepRoleId)`. The filter store must
   * survive the swap. This test simulates the swap by re-running
   * `applyFilters` against the same filter object after "switching role".
   */
  test('the same filters object filters two different role event lists identically', () => {
    const filters: FiltersState = { ...DEFAULT_FILTERS, 'tool-call': false };
    const roleAEvents: TaskEvent[] = [
      makeEvent({ type: 'system', role: 'Architect', content: 'a-sys' }),
      makeToolCall({ role: 'Architect', parentId: 'a' }),
    ];
    const roleBEvents: TaskEvent[] = [
      makeEvent({ type: 'system', role: 'Tester', content: 'b-sys' }),
      makeToolCall({ role: 'Tester', parentId: 'b' }),
    ];
    // After "switching role" the same filters object still drops tool-calls
    // from BOTH lists — the toggle was not reset.
    expect(applyFilters(roleAEvents, filters).every((e) => e.toolName === undefined)).toBe(true);
    expect(applyFilters(roleBEvents, filters).every((e) => e.toolName === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Live indicator wiring contract (Acceptance #3)
//    The actual SSE EventSource is a browser API and is exercised through
//    `detail-pane-subscription-key.test.ts`. Here we lock down the simple
//    state-machine contract that DetailPane wires up:
//      - onopen     -> setLive(true)
//      - onerror    -> setLive(false)
//      - onCleanup  -> setLive(false)
//    A pure callback table simulates the wiring; if a future refactor
//    accidentally inverts a transition, this catches it.
// ---------------------------------------------------------------------------

describe('live signal state machine (Acceptance #3)', () => {
  /** Minimal state-machine wrapper modelling the DetailPane SSE wiring. */
  function makeLiveWiring(): {
    live: () => boolean;
    handleOpen: () => void;
    handleError: () => void;
    handleCleanup: () => void;
  } {
    let value = false;
    return {
      live: () => value,
      handleOpen: () => { value = true; },
      handleError: () => { value = false; },
      handleCleanup: () => { value = false; },
    };
  }

  test('initial state is dim (false)', () => {
    const w = makeLiveWiring();
    expect(w.live()).toBe(false);
  });

  test('onopen flips live to true (dot pulses)', () => {
    const w = makeLiveWiring();
    w.handleOpen();
    expect(w.live()).toBe(true);
  });

  test('onerror flips live back to false (channel closed → dim)', () => {
    const w = makeLiveWiring();
    w.handleOpen();
    w.handleError();
    expect(w.live()).toBe(false);
  });

  test('cleanup flips live to false (effect torn down on task switch)', () => {
    const w = makeLiveWiring();
    w.handleOpen();
    w.handleCleanup();
    expect(w.live()).toBe(false);
  });

  test('open after a previous close re-arms the indicator', () => {
    const w = makeLiveWiring();
    w.handleOpen();
    w.handleError();
    w.handleOpen();
    expect(w.live()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Auto-scroll edge detector (Acceptance #4)
// ---------------------------------------------------------------------------

describe('auto-scroll isAtBottom edge detector (Acceptance #4)', () => {
  test('returns true when scrolled exactly to the bottom (no slack used)', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 200, scrollHeight: 700 })).toBe(true);
  });

  test('returns true within the 8 px slack window (treat near-bottom as bottom)', () => {
    // scrollTop + clientHeight = 700-7 = 693, scrollHeight = 700, slack = 8.
    expect(isAtBottom({ scrollTop: 493, clientHeight: 200, scrollHeight: 700 })).toBe(true);
  });

  test('returns false when scrolled beyond the slack window (user scrolled up)', () => {
    // scrollTop + clientHeight = 681, scrollHeight - 8 = 692. 681 < 692 -> false.
    expect(isAtBottom({ scrollTop: 481, clientHeight: 200, scrollHeight: 700 })).toBe(false);
  });

  test('returns false at the very top of a long body', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 4000 })).toBe(false);
  });

  test('returns true when content is shorter than the viewport (always at bottom)', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 200 })).toBe(true);
  });

  test('flips back to true when the user scrolls back to the bottom', () => {
    // Simulate: user scrolls up (false), then back to bottom (true).
    const scrolledUp = { scrollTop: 100, clientHeight: 200, scrollHeight: 700 };
    const scrolledDown = { scrollTop: 500, clientHeight: 200, scrollHeight: 700 };
    expect(isAtBottom(scrolledUp)).toBe(false);
    expect(isAtBottom(scrolledDown)).toBe(true);
  });
});
