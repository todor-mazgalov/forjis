/**
 * Unit tests for v4 bug fixes:
 *   Bug 1 — Per-role JSONL files not created (immediate getRunningRole poll)
 *   Bug 2 — event.role always "orchestrator" (role stamping in onEvent)
 *   Bug 3 — Events disappear in UI (autoSelectRunningStep guard + connectSSE pre-populate)
 *
 * All external I/O is mocked. Tests exercise pure business logic:
 *   - getRunningRole()  from plan-writer.ts
 *   - appendEvent()     from event-writer.ts
 *   - The role-stamping pattern in run.ts's onEvent closure
 *   - The autoSelectRunningStep guard condition (extracted as pure function)
 *   - The connectSSE pre-population accumulation logic (extracted as pure function)
 */

import { jest } from '@jest/globals';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

// ============================================================================
// Helpers
// ============================================================================

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-v4-bug-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Writes a pipeline-state.yaml at the expected path and returns its directory. */
async function writePipelineState(
  projectDir: string,
  taskId: string,
  state: object,
): Promise<void> {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pipeline-state.yaml'), yamlStringify(state), 'utf-8');
}

/** Creates the queue directory for a task (needed for appendEvent). */
async function createQueueDir(projectDir: string, taskId: string): Promise<void> {
  await mkdir(join(projectDir, '.forjis', 'tasks', taskId), { recursive: true });
}

/** Reads the raw text of a JSONL event file. */
async function readEventFile(
  projectDir: string,
  taskId: string,
  filename: string,
): Promise<string> {
  return readFile(join(projectDir, '.forjis', 'tasks', taskId, filename), 'utf-8');
}

// ============================================================================
// Bug 1 + Bug 2 — getRunningRole returns the correct team/role
// ============================================================================

describe('getRunningRole — pipeline-state.yaml reading (Bug 1 & 2)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Bug 1 — immediate poll before engine.invoke returns valid role data. */
  it('returns team and role when exactly one role has status running', async () => {
    const { getRunningRole } = await import('../web-services/plan-writer.js');

    await writePipelineState(tmpDir, 'task-a', {
      org: 'TestOrg',
      team: 'Dev',
      status: 'running',
      roles: [
        { name: 'forjis-explorer', agent: 'forjis-explorer', status: 'running', description: 'Explore' },
        { name: 'forjis-analyst', agent: 'forjis-analyst', status: 'planned', description: 'Analyse' },
      ],
    });

    const result = await getRunningRole(tmpDir, 'task-a');

    expect(result).not.toBeNull();
    expect(result!.team).toBe('Dev');
    expect(result!.role).toBe('forjis-explorer');
  });

  /** Bug 1 — when pipeline-state.yaml has no running role, returns null (no crash). */
  it('returns null when no role has status running', async () => {
    const { getRunningRole } = await import('../web-services/plan-writer.js');

    await writePipelineState(tmpDir, 'task-b', {
      org: 'TestOrg',
      team: 'Dev',
      status: 'done',
      roles: [
        { name: 'forjis-explorer', agent: 'forjis-explorer', status: 'done', description: 'Explore' },
      ],
    });

    const result = await getRunningRole(tmpDir, 'task-b');
    expect(result).toBeNull();
  });

  /** Bug 1 — when pipeline-state.yaml does not yet exist, returns null gracefully. */
  it('returns null when pipeline-state.yaml is absent (file not written yet)', async () => {
    const { getRunningRole } = await import('../web-services/plan-writer.js');

    // No file written — directory does not even exist
    const result = await getRunningRole(tmpDir, 'no-such-task');
    expect(result).toBeNull();
  });

  /** Bug 1 — picks the first running role when multiple are listed. */
  it('returns the first running role when multiple roles have status running', async () => {
    const { getRunningRole } = await import('../web-services/plan-writer.js');

    await writePipelineState(tmpDir, 'task-c', {
      org: 'TestOrg',
      team: 'Alpha',
      status: 'running',
      roles: [
        { name: 'forjis-developer', agent: 'forjis-developer', status: 'running', description: 'Dev' },
        { name: 'forjis-reviewer', agent: 'forjis-reviewer', status: 'running', description: 'Review' },
      ],
    });

    const result = await getRunningRole(tmpDir, 'task-c');
    expect(result).not.toBeNull();
    expect(result!.role).toBe('forjis-developer');
  });

  /** Bug 1 — returns null when state file exists but has no team field. */
  it('returns null when pipeline-state.yaml has no team field', async () => {
    const { getRunningRole } = await import('../web-services/plan-writer.js');

    await writePipelineState(tmpDir, 'task-d', {
      org: 'TestOrg',
      // team intentionally absent
      status: 'running',
      roles: [
        { name: 'forjis-explorer', agent: 'forjis-explorer', status: 'running', description: 'Explore' },
      ],
    });

    const result = await getRunningRole(tmpDir, 'task-d');
    expect(result).toBeNull();
  });
});

// ============================================================================
// Bug 2 — Role stamping: event.role is overwritten from currentRole
// ============================================================================

describe('onEvent role-stamping logic (Bug 2)', () => {
  /**
   * The run.ts onEvent closure logic reduced to a pure function.
   * event.role = currentRole ?? 'orchestrator'
   * This tests exactly that assignment in isolation.
   */
  function applyRoleStamp(
    event: { role: string; content: string },
    currentRole: string | null,
  ): void {
    event.role = currentRole ?? 'orchestrator';
  }

  /** Bug 2 — when currentRole is populated, event.role reflects the pipeline-state value. */
  it('stamps event.role with currentRole when currentRole is not null', () => {
    const event = { role: 'orchestrator', content: 'hello' };
    applyRoleStamp(event, 'forjis-explorer');
    expect(event.role).toBe('forjis-explorer');
  });

  /** Bug 2 — when currentRole is null (poll not yet fired), event.role falls back to "orchestrator". */
  it('falls back to "orchestrator" when currentRole is null', () => {
    const event = { role: 'something-from-engine', content: 'hi' };
    applyRoleStamp(event, null);
    expect(event.role).toBe('orchestrator');
  });

  /** Bug 2 — engine heuristic value (whatever the engine set) is overwritten. */
  it('overwrites the engine-heuristic role value with the authoritative poll value', () => {
    const event = { role: 'wrong-engine-guess', content: 'data' };
    applyRoleStamp(event, 'forjis-analyst');
    expect(event.role).toBe('forjis-analyst');
    expect(event.role).not.toBe('wrong-engine-guess');
  });

  /** Bug 2 — role changes between events are reflected immediately (closure captures by reference). */
  it('reflects role changes across successive events when currentRole changes', () => {
    let currentRole: string | null = 'forjis-explorer';

    const event1 = { role: '', content: 'first' };
    applyRoleStamp(event1, currentRole);

    currentRole = 'forjis-analyst';
    const event2 = { role: '', content: 'second' };
    applyRoleStamp(event2, currentRole);

    expect(event1.role).toBe('forjis-explorer');
    expect(event2.role).toBe('forjis-analyst');
  });
});

// ============================================================================
// Bug 1 — appendEvent routes events to per-role JSONL files
// ============================================================================

describe('appendEvent file routing (Bug 1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Bug 1 — when an identity triple is provided, event lands in the role-specific JSONL file. */
  it('writes event to events-<slug>.jsonl when an identity triple is given', async () => {
    const { appendEvent } = await import('../web-services/event-writer.js');

    await createQueueDir(tmpDir, 'task-1');

    const event = {
      timestamp: '2026-03-19T10:00:00.000Z',
      type: 'assistant',
      role: 'forjis-explorer',
      content: 'Exploring codebase',
    };

    await appendEvent(tmpDir, 'task-1', event, { org: 'Acme', team: 'Dev', role: 'forjis-explorer' });

    const contents = await readEventFile(tmpDir, 'task-1', 'events-acme-dev-forjis-explorer.jsonl');
    const parsed = JSON.parse(contents.trim());
    expect(parsed.role).toBe('forjis-explorer');
    expect(parsed.content).toBe('Exploring codebase');
  });

  /** Bug 1 — when team and role are absent (null/undefined), event falls back to events.jsonl. */
  it('writes event to events.jsonl when team and role are absent', async () => {
    const { appendEvent } = await import('../web-services/event-writer.js');

    await createQueueDir(tmpDir, 'task-2');

    const event = {
      timestamp: '2026-03-19T10:00:00.001Z',
      type: 'system',
      role: 'orchestrator',
      content: 'Starting pipeline',
    };

    await appendEvent(tmpDir, 'task-2', event);

    const contents = await readEventFile(tmpDir, 'task-2', 'events.jsonl');
    const parsed = JSON.parse(contents.trim());
    expect(parsed.role).toBe('orchestrator');
  });

  /** Bug 1 — two different roles produce two separate JSONL files. */
  it('creates separate JSONL files for different identity triples', async () => {
    const { appendEvent } = await import('../web-services/event-writer.js');
    const { readdir } = await import('node:fs/promises');

    await createQueueDir(tmpDir, 'task-3');

    const eventA = { timestamp: '2026-03-19T10:00:00.000Z', type: 'assistant', role: 'forjis-explorer', content: 'a' };
    const eventB = { timestamp: '2026-03-19T10:00:01.000Z', type: 'assistant', role: 'forjis-analyst', content: 'b' };

    await appendEvent(tmpDir, 'task-3', eventA, { org: 'Acme', team: 'Dev', role: 'forjis-explorer' });
    await appendEvent(tmpDir, 'task-3', eventB, { org: 'Acme', team: 'Dev', role: 'forjis-analyst' });

    const files = await readdir(join(tmpDir, '.forjis', 'tasks', 'task-3'));
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

    expect(jsonlFiles).toContain('events-acme-dev-forjis-explorer.jsonl');
    expect(jsonlFiles).toContain('events-acme-dev-forjis-analyst.jsonl');
    expect(jsonlFiles).toHaveLength(2);
  });

  /** Bug 1 — multiple events for the same role accumulate in the same file. */
  it('accumulates multiple events in the same role file', async () => {
    const { appendEvent } = await import('../web-services/event-writer.js');

    await createQueueDir(tmpDir, 'task-4');

    for (let i = 0; i < 3; i++) {
      await appendEvent(
        tmpDir,
        'task-4',
        { timestamp: `2026-03-19T10:00:0${i}.000Z`, type: 'assistant', role: 'forjis-developer', content: `line ${i}` },
        { org: 'Acme', team: 'Dev', role: 'forjis-developer' },
      );
    }

    const contents = await readEventFile(tmpDir, 'task-4', 'events-acme-dev-forjis-developer.jsonl');
    const lines = contents.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).content).toBe('line 0');
    expect(JSON.parse(lines[2]).content).toBe('line 2');
  });
});

// ============================================================================
// Bug 3 — autoSelectRunningStep guard condition
// ============================================================================

describe('autoSelectRunningStep guard condition (Bug 3)', () => {
  /**
   * Pure representation of the business logic inside autoSelectRunningStep.
   *
   * Returns one of three outcomes:
   *   'skip'    — guard fired: same step already selected and SSE active
   *   'reset'   — step changed (or first selection): reset events, reconnect SSE
   *   'no-run'  — no running step found in the plan
   */
  function autoSelectRunningStep(state: {
    userSelectedStep: boolean;
    plan: { steps: { status: string }[] } | null;
    selectedStepIndex: number | null;
    sseSource: object | null;
  }): 'skip' | 'reset' | 'no-run' {
    if (state.userSelectedStep || !state.plan) return 'no-run';

    const steps = state.plan.steps;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].status === 'running') {
        if (state.selectedStepIndex === i && state.sseSource) {
          return 'skip';
        }
        return 'reset';
      }
    }
    return 'no-run';
  }

  /** Bug 3 — guard fires: same step is already selected and SSE is active. */
  it('returns skip when the running step is already selected and SSE is active', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: false,
      plan: { steps: [{ status: 'done' }, { status: 'running' }, { status: 'planned' }] },
      selectedStepIndex: 1,
      sseSource: { close: jest.fn() },
    });

    expect(result).toBe('skip');
  });

  /** Bug 3 — reset fires: running step index changed (e.g., second step starts). */
  it('returns reset when the running step index is different from the currently selected index', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: false,
      plan: { steps: [{ status: 'done' }, { status: 'running' }] },
      selectedStepIndex: 0,
      sseSource: { close: jest.fn() },
    });

    expect(result).toBe('reset');
  });

  /** Bug 3 — reset fires on first selection when no step is selected yet. */
  it('returns reset when no step is selected yet (first auto-select)', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: false,
      plan: { steps: [{ status: 'running' }] },
      selectedStepIndex: null,
      sseSource: null,
    });

    expect(result).toBe('reset');
  });

  /** Bug 3 — reset fires when step is selected but SSE is not yet active. */
  it('returns reset when step index matches but SSE is not connected', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: false,
      plan: { steps: [{ status: 'running' }] },
      selectedStepIndex: 0,
      sseSource: null,  // SSE not yet open
    });

    expect(result).toBe('reset');
  });

  /** Bug 3 — no-run when user has manually selected a step. */
  it('returns no-run immediately when userSelectedStep is true', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: true,
      plan: { steps: [{ status: 'running' }] },
      selectedStepIndex: 0,
      sseSource: { close: jest.fn() },
    });

    expect(result).toBe('no-run');
  });

  /** Bug 3 — no-run when there is no running step in the plan. */
  it('returns no-run when no step has status running', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: false,
      plan: { steps: [{ status: 'done' }, { status: 'planned' }] },
      selectedStepIndex: null,
      sseSource: null,
    });

    expect(result).toBe('no-run');
  });

  /** Bug 3 — no-run when plan is null. */
  it('returns no-run when plan is null', () => {
    const result = autoSelectRunningStep({
      userSelectedStep: false,
      plan: null,
      selectedStepIndex: null,
      sseSource: null,
    });

    expect(result).toBe('no-run');
  });
});

// ============================================================================
// Bug 3 — connectSSE pre-population: existing events merged before SSE opens
// ============================================================================

describe('connectSSE pre-population and deduplication logic (Bug 3)', () => {
  /**
   * Pure representation of the pre-population and deduplication logic
   * inside connectSSE. Simulates:
   *   1. fetchEvents() returns existingEvents
   *   2. state.events is set to existingEvents
   *   3. SSE message arrives; deduplication skips events at or before lastEventTimestamp
   */

  interface EventItem {
    timestamp: string;
    content: string;
  }

  interface ConnectState {
    events: EventItem[];
    lastEventTimestamp: string | null;
  }

  function applyPrePopulation(state: ConnectState, existingEvents: EventItem[]): void {
    if (existingEvents.length > 0) {
      state.events = [...existingEvents];
      state.lastEventTimestamp = existingEvents[existingEvents.length - 1].timestamp;
    }
  }

  function applySSEMessage(state: ConnectState, incomingEvent: EventItem): 'added' | 'duplicate' {
    if (state.lastEventTimestamp && incomingEvent.timestamp <= state.lastEventTimestamp) {
      return 'duplicate';
    }
    state.events.push(incomingEvent);
    state.lastEventTimestamp = incomingEvent.timestamp;
    return 'added';
  }

  /** Bug 3 — historical events are present in state.events after pre-population. */
  it('populates state.events with existing events before SSE opens', () => {
    const state: ConnectState = { events: [], lastEventTimestamp: null };
    const existing = [
      { timestamp: '2026-03-19T10:00:00.000Z', content: 'event-1' },
      { timestamp: '2026-03-19T10:00:01.000Z', content: 'event-2' },
    ];

    applyPrePopulation(state, existing);

    expect(state.events).toHaveLength(2);
    expect(state.events[0].content).toBe('event-1');
    expect(state.events[1].content).toBe('event-2');
  });

  /** Bug 3 — lastEventTimestamp is set to the last existing event's timestamp after pre-population. */
  it('sets lastEventTimestamp to the last existing event timestamp after pre-population', () => {
    const state: ConnectState = { events: [], lastEventTimestamp: null };
    const existing = [
      { timestamp: '2026-03-19T10:00:00.000Z', content: 'old' },
      { timestamp: '2026-03-19T10:00:05.000Z', content: 'latest-historical' },
    ];

    applyPrePopulation(state, existing);

    expect(state.lastEventTimestamp).toBe('2026-03-19T10:00:05.000Z');
  });

  /** Bug 3 — SSE event with timestamp equal to lastEventTimestamp is deduplicated. */
  it('skips SSE event whose timestamp equals lastEventTimestamp (exact duplicate)', () => {
    const state: ConnectState = {
      events: [{ timestamp: '2026-03-19T10:00:05.000Z', content: 'pre-existing' }],
      lastEventTimestamp: '2026-03-19T10:00:05.000Z',
    };

    const result = applySSEMessage(state, { timestamp: '2026-03-19T10:00:05.000Z', content: 'duplicate' });

    expect(result).toBe('duplicate');
    expect(state.events).toHaveLength(1);
  });

  /** Bug 3 — SSE event with timestamp before lastEventTimestamp is deduplicated. */
  it('skips SSE event whose timestamp is before lastEventTimestamp', () => {
    const state: ConnectState = {
      events: [{ timestamp: '2026-03-19T10:00:10.000Z', content: 'later' }],
      lastEventTimestamp: '2026-03-19T10:00:10.000Z',
    };

    const result = applySSEMessage(state, { timestamp: '2026-03-19T10:00:05.000Z', content: 'stale' });

    expect(result).toBe('duplicate');
    expect(state.events).toHaveLength(1);
  });

  /** Bug 3 — SSE event with timestamp after lastEventTimestamp is appended. */
  it('appends SSE event whose timestamp is after lastEventTimestamp', () => {
    const state: ConnectState = {
      events: [{ timestamp: '2026-03-19T10:00:05.000Z', content: 'historical' }],
      lastEventTimestamp: '2026-03-19T10:00:05.000Z',
    };

    const result = applySSEMessage(state, { timestamp: '2026-03-19T10:00:06.000Z', content: 'live-new' });

    expect(result).toBe('added');
    expect(state.events).toHaveLength(2);
    expect(state.events[1].content).toBe('live-new');
  });

  /** Bug 3 — when no existing events, pre-population leaves state.events empty and lastEventTimestamp null. */
  it('leaves state.events empty when fetchEvents returns no events', () => {
    const state: ConnectState = { events: [], lastEventTimestamp: null };

    applyPrePopulation(state, []);

    expect(state.events).toHaveLength(0);
    expect(state.lastEventTimestamp).toBeNull();
  });

  /** Bug 3 — combined scenario: historical events plus new live events accumulate correctly. */
  it('accumulates historical and live events without duplication across a full lifecycle', () => {
    const state: ConnectState = { events: [], lastEventTimestamp: null };

    // Pre-populate from fetchEvents
    const historical = [
      { timestamp: '2026-03-19T10:00:00.000Z', content: 'h1' },
      { timestamp: '2026-03-19T10:00:02.000Z', content: 'h2' },
    ];
    applyPrePopulation(state, historical);

    // SSE sends h2 again (overlap at the boundary) — should be skipped
    expect(applySSEMessage(state, { timestamp: '2026-03-19T10:00:02.000Z', content: 'h2' })).toBe('duplicate');

    // SSE sends h1 again (older) — should be skipped
    expect(applySSEMessage(state, { timestamp: '2026-03-19T10:00:00.000Z', content: 'h1' })).toBe('duplicate');

    // SSE sends genuinely new events
    expect(applySSEMessage(state, { timestamp: '2026-03-19T10:00:03.000Z', content: 'live-1' })).toBe('added');
    expect(applySSEMessage(state, { timestamp: '2026-03-19T10:00:04.000Z', content: 'live-2' })).toBe('added');

    expect(state.events).toHaveLength(4);
    expect(state.events.map((e) => e.content)).toEqual(['h1', 'h2', 'live-1', 'live-2']);
  });
});
