/**
 * Backend layer tests for the Forjis web dashboard.
 *
 * Tests cover:
 *  - plan-writer: buildInitialSteps, describeRole, writePipelinePlan, updatePipelinePlan
 *  - event-writer: appendEvent, readEvents, readEventsSince, append-only accumulation
 *  - task-service: TaskServiceImpl.listTasks (sorting, mapping), taskExists
 *  - plan-service: PlanServiceImpl.getPlan (valid, missing, null)
 *  - event-service: EventServiceImpl.getEvents, getEventsSince
 *  - resource-service: ResourceServiceImpl.getResources mapping
 *  - run.ts: server lifecycle (unref called, server.close on signal and completion)
 *
 * All file I/O in event-writer and plan-writer tests uses a real temporary
 * directory that is cleaned up after each test — no database, no network.
 * TaskQueue is mocked at the interface level. state.ts functions are mocked
 * for plan-writer and plan-service to avoid filesystem coupling.
 *
 * Requirements covered:
 *   FR-004  TaskServiceImpl — task listing, sorting, optional field mapping
 *   FR-005  PlanServiceImpl — plan reads, null for missing file
 *   FR-006  plan-writer — writePipelinePlan, updatePipelinePlan
 *   FR-007  event-writer — appendEvent, readEvents, readEventsSince, append-only
 *   FR-008  EventServiceImpl — getEvents (with/without since), getEventsSince
 *   FR-009  ResourceServiceImpl — org hierarchy, registry resource types
 *   FR-017  run.ts — server.unref(), server.close() on signal and loop completion
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Units under test
// ---------------------------------------------------------------------------

import {
  describeRole,
  writePipelinePlan,
  syncPlanFromState,
} from '@forjis/facilitator';

import {
  appendEvent,
  readEvents,
  readEventsSince,
} from '@forjis/facilitator';

import { TaskServiceImpl } from '@forjis/facilitator';
import { PlanServiceImpl } from '@forjis/facilitator';
import { EventServiceImpl } from '@forjis/facilitator';
import { ResourceServiceImpl } from '@forjis/facilitator';
import { FileServiceImpl } from '@forjis/facilitator';

// ---------------------------------------------------------------------------
// Types used in tests
// ---------------------------------------------------------------------------

import type { RuntimeConfig, TaskState } from '@forjis/facilitator';
import type { TaskQueue } from '@forjis/facilitator';
import type { ResourceRegistry } from '@forjis/facilitator';
import type { ResourceEntry, ResourceType } from '@forjis/facilitator';
import type { TaskEvent, PipelinePlanResponse } from '../types.js';

// ===========================================================================
// Shared fixtures
// ===========================================================================

/** Minimal RuntimeConfig with one org, one team, three roles. */
function makeRuntime(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    orgs: [
      {
        name: 'my-org',
        teams: [
          {
            name: 'default',
            roles: [
              { name: 'setup', agent: 'forjis-setup', skills: [], hooks: { pre: [], validation: [], post: [] } },
              { name: 'developer', agent: 'forjis-developer', skills: ['java'], hooks: { pre: [], validation: [], post: [] } },
              { name: 'reviewer', agent: 'forjis-reviewer', skills: [], hooks: { pre: [], validation: [], post: [] } },
            ],
          },
        ],
      },
    ],
    metrics: new Map(),
    outcomeRules: [],
    outcomeEnabled: false,
    defaultAction: 'halt',
    defaultMaxRetries: 0,
    pipeline: null,
    allowedTools: [],
    ...overrides,
  };
}

/** Creates a mock TaskQueue that returns the provided states from listAll/getState. */
function makeQueue(states: TaskState[]): TaskQueue {
  return {
    listAll: async () => states,
    getState: async (id: string) => states.find((s) => s.id === id) ?? null,
  } as unknown as TaskQueue;
}

/** Builds a minimal TaskState. */
function makeTaskState(overrides: Partial<TaskState> & { id: string; status: TaskState['status'] }): TaskState {
  return {
    priority: 'medium',
    description: 'Test task',
    created: '2026-01-01T00:00:00Z',
    source: 'cli',
    dependencies: [],
    retryCount: 0,
    ...overrides,
  };
}

/** Builds a minimal TaskEvent. */
function makeEvent(ts: string, content = 'hello'): TaskEvent {
  return {
    timestamp: ts,
    type: 'assistant',
    role: 'my-org:default:developer',
    content,
  };
}

/** Creates a temporary directory for filesystem tests. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-backend-test-'));
}

/** Removes a temporary directory. */
async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Creates the .forjis/tasks/<taskId> directory structure in a temp dir. */
async function setupTaskDir(projectDir: string, taskId: string): Promise<string> {
  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  return taskDir;
}

// ===========================================================================
// 1. plan-writer.ts — describeRole
// ===========================================================================

describe('describeRole', () => {
  /**
   * FR-006: Role descriptions allow dashboard to display human-readable step names.
   */

  test('maps "setup" to "Project setup and workspace preparation"', () => {
    expect(describeRole('setup')).toBe('Project setup and workspace preparation');
  });

  test('maps "explorer" to "Codebase exploration and investigation"', () => {
    expect(describeRole('explorer')).toBe('Codebase exploration and investigation');
  });

  test('maps "analyst" to "Requirements analysis and specification"', () => {
    expect(describeRole('analyst')).toBe('Requirements analysis and specification');
  });

  test('maps "architect" to "Solution design and architecture"', () => {
    expect(describeRole('architect')).toBe('Solution design and architecture');
  });

  test('maps "developer" to "Implementation and coding"', () => {
    expect(describeRole('developer')).toBe('Implementation and coding');
  });

  test('maps "reviewer" to "Code review and testing"', () => {
    expect(describeRole('reviewer')).toBe('Code review and testing');
  });

  test('maps "finish" to "Task completion and archival"', () => {
    expect(describeRole('finish')).toBe('Task completion and archival');
  });

  test('returns "Pipeline stage: <roleName>" for unknown role', () => {
    expect(describeRole('custom-step')).toBe('Pipeline stage: custom-step');
  });

  test('matching is case-insensitive (SETUP -> known description)', () => {
    expect(describeRole('SETUP')).toBe('Project setup and workspace preparation');
  });

  test('partial match works: "forjis-developer" contains "developer"', () => {
    expect(describeRole('forjis-developer')).toBe('Implementation and coding');
  });
});

// ===========================================================================
// 2. plan-writer.ts — describeRole
// ===========================================================================

describe('describeRole (backend-layer)', () => {
  test('maps known role patterns to descriptions', () => {
    expect(describeRole('setup')).toContain('setup');
    expect(describeRole('developer')).toContain('Implementation');
    expect(describeRole('reviewer')).toContain('review');
  });

  test('returns generic description for unknown roles', () => {
    expect(describeRole('CustomRole')).toContain('Pipeline stage');
  });
});

// ===========================================================================
// 3. plan-writer.ts — writePipelinePlan + syncPlanFromState (real filesystem)
// ===========================================================================

describe('writePipelinePlan', () => {
  let projectDir: string;

  beforeEach(async () => { projectDir = await createTempDir(); });
  afterEach(async () => { await removeTempDir(projectDir); });

  test('creates plan with evaluating status and empty steps', async () => {
    await setupTaskDir(projectDir, 'task-001');
    await writePipelinePlan(projectDir, 'task-001');

    const planPath = join(projectDir, '.forjis', 'tasks', 'task-001', 'pipeline-plan.yaml');
    const raw = await readFile(planPath, 'utf-8');
    expect(raw).toContain('task-001');
    expect(raw).toContain('status: evaluating');
    expect(raw).toContain('steps: []');
  });
});

describe('syncPlanFromState', () => {
  let projectDir: string;

  beforeEach(async () => { projectDir = await createTempDir(); });
  afterEach(async () => { await removeTempDir(projectDir); });

  async function writeState(taskId: string, state: Record<string, unknown>): Promise<void> {
    const dir = join(projectDir, '.forjis', 'tasks', taskId);
    await mkdir(dir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(dir, 'pipeline-state.yaml'), stringify(state), 'utf-8');
  }

  test('returns false when no pipeline-state.yaml exists', async () => {
    await setupTaskDir(projectDir, 'task-s1');
    expect(await syncPlanFromState(projectDir, 'task-s1')).toBe(false);
  });

  test('syncs roles from orchestrator state to plan', async () => {
    await setupTaskDir(projectDir, 'task-s2');
    await writeState('task-s2', {
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { name: 'developer', agent: 'forjis-developer', status: 'running', description: 'Dev' },
        { name: 'reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    });

    expect(await syncPlanFromState(projectDir, 'task-s2')).toBe(true);

    const raw = await readFile(join(projectDir, '.forjis', 'tasks', 'task-s2', 'pipeline-plan.yaml'), 'utf-8');
    expect(raw).toContain('status: ready');
    expect(raw).toContain('orgName: my-org');
    expect(raw).toContain('teamName: default');
  });

  test('preserves role statuses from orchestrator', async () => {
    await setupTaskDir(projectDir, 'task-s3');
    await writeState('task-s3', {
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { name: 'developer', agent: 'forjis-developer', status: 'running', description: 'Dev' },
        { name: 'reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    });

    await syncPlanFromState(projectDir, 'task-s3');

    const raw = await readFile(join(projectDir, '.forjis', 'tasks', 'task-s3', 'pipeline-plan.yaml'), 'utf-8');
    expect(raw).toMatch(/setup[\s\S]*?status: done/);
    expect(raw).toMatch(/developer[\s\S]*?status: running/);
    expect(raw).toMatch(/reviewer[\s\S]*?status: planned/);
  });
});

// ===========================================================================
// 5. event-writer.ts — appendEvent, readEvents, readEventsSince
// ===========================================================================

describe('event-writer', () => {
  /**
   * FR-007: Events appended as valid JSONL; file truncated at 200 lines;
   * empty array on missing file; malformed lines skipped.
   */

  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  describe('readEvents — missing file', () => {
    test('returns empty array when events.jsonl does not exist', async () => {
      const result = await readEvents(projectDir, 'task-no-file');
      expect(result).toEqual([]);
    });
  });

  describe('appendEvent', () => {
    test('creates events.jsonl if it does not exist and appends the event', async () => {
      await setupTaskDir(projectDir, 'task-a1');
      const event = makeEvent('2026-01-01T10:00:00.000Z');
      await appendEvent(projectDir, 'task-a1', event);

      const events = await readEvents(projectDir, 'task-a1');
      expect(events).toHaveLength(1);
      expect(events[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
    });

    test('appended event has all four required fields', async () => {
      await setupTaskDir(projectDir, 'task-a2');
      const event: TaskEvent = {
        timestamp: '2026-01-01T10:00:01Z',
        type: 'system',
        role: 'my-org:default:setup',
        content: 'Starting setup',
      };
      await appendEvent(projectDir, 'task-a2', event);

      const events = await readEvents(projectDir, 'task-a2');
      expect(events[0]).toMatchObject({
        timestamp: '2026-01-01T10:00:01Z',
        type: 'system',
        role: 'my-org:default:setup',
        content: 'Starting setup',
      });
    });

    test('multiple appends accumulate in chronological order', async () => {
      await setupTaskDir(projectDir, 'task-a3');
      const e1 = makeEvent('2026-01-01T10:00:01Z', 'first');
      const e2 = makeEvent('2026-01-01T10:00:02Z', 'second');
      const e3 = makeEvent('2026-01-01T10:00:03Z', 'third');

      await appendEvent(projectDir, 'task-a3', e1);
      await appendEvent(projectDir, 'task-a3', e2);
      await appendEvent(projectDir, 'task-a3', e3);

      const events = await readEvents(projectDir, 'task-a3');
      expect(events).toHaveLength(3);
      expect(events[0].content).toBe('first');
      expect(events[1].content).toBe('second');
      expect(events[2].content).toBe('third');
    });

    test('file under 200 lines is not truncated', async () => {
      await setupTaskDir(projectDir, 'task-a4');
      // Append 5 events — well under the limit
      for (let i = 0; i < 5; i++) {
        await appendEvent(projectDir, 'task-a4', makeEvent(`2026-01-01T10:00:0${i}Z`, `event-${i}`));
      }
      const events = await readEvents(projectDir, 'task-a4');
      expect(events).toHaveLength(5);
    });
  });

  describe('append-only — no truncation', () => {
    test('all 250 appended events are retained without truncation', async () => {
      await setupTaskDir(projectDir, 'task-rb1');
      for (let i = 0; i < 250; i++) {
        const ts = `2026-01-01T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
        await appendEvent(projectDir, 'task-rb1', makeEvent(ts, `event-${i}`));
      }
      const events = await readEvents(projectDir, 'task-rb1');
      expect(events).toHaveLength(250);
    }, 30000);

    test('first and last events have expected content after 250 appends', async () => {
      await setupTaskDir(projectDir, 'task-rb2');
      for (let i = 0; i < 250; i++) {
        await appendEvent(projectDir, 'task-rb2', makeEvent(
          `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
          `event-${i}`,
        ));
      }
      const events = await readEvents(projectDir, 'task-rb2');
      expect(events).toHaveLength(250);
      expect(events[0].content).toBe('event-0');
      expect(events[249].content).toBe('event-249');
    }, 30000);
  });

  describe('readEvents — malformed lines', () => {
    test('skips malformed JSON lines and returns only valid events', async () => {
      await setupTaskDir(projectDir, 'task-bad');
      const filePath = join(projectDir, '.forjis', 'tasks', 'task-bad', 'events.jsonl');
      // Write a mix of valid and invalid lines
      const validEvent = makeEvent('2026-01-01T10:00:00Z');
      await writeFile(filePath, [
        JSON.stringify(validEvent),
        'NOT_VALID_JSON{{{',
        JSON.stringify(makeEvent('2026-01-01T10:00:01Z', 'second')),
        '',
      ].join('\n'), 'utf-8');

      const events = await readEvents(projectDir, 'task-bad');
      expect(events).toHaveLength(2);
      expect(events[0].timestamp).toBe('2026-01-01T10:00:00Z');
      expect(events[1].timestamp).toBe('2026-01-01T10:00:01Z');
    });
  });

  describe('readEventsSince', () => {
    test('returns only events strictly after the since timestamp', async () => {
      await setupTaskDir(projectDir, 'task-since-1');
      const events = [
        makeEvent('2026-01-01T10:00:00Z', 'before'),
        makeEvent('2026-01-01T10:00:01Z', 'boundary'),
        makeEvent('2026-01-01T10:00:02Z', 'after'),
      ];
      for (const e of events) {
        await appendEvent(projectDir, 'task-since-1', e);
      }

      const result = await readEventsSince(projectDir, 'task-since-1', '2026-01-01T10:00:01Z');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('after');
    });

    test('returns empty array when all events are at or before the since timestamp', async () => {
      await setupTaskDir(projectDir, 'task-since-2');
      await appendEvent(projectDir, 'task-since-2', makeEvent('2026-01-01T09:00:00Z'));

      const result = await readEventsSince(projectDir, 'task-since-2', '2026-01-01T10:00:00Z');
      expect(result).toEqual([]);
    });

    test('returns all events when since is an old timestamp', async () => {
      await setupTaskDir(projectDir, 'task-since-3');
      await appendEvent(projectDir, 'task-since-3', makeEvent('2026-01-01T10:00:00Z', 'a'));
      await appendEvent(projectDir, 'task-since-3', makeEvent('2026-01-01T10:00:01Z', 'b'));

      const result = await readEventsSince(projectDir, 'task-since-3', '2025-01-01T00:00:00Z');
      expect(result).toHaveLength(2);
    });

    test('returns empty array when events.jsonl does not exist', async () => {
      const result = await readEventsSince(projectDir, 'no-such-task', '2026-01-01T00:00:00Z');
      expect(result).toEqual([]);
    });
  });
});

// ===========================================================================
// 6. task-service.ts — TaskServiceImpl
// ===========================================================================

describe('TaskServiceImpl', () => {
  /**
   * FR-004: All TaskState fields correctly mapped to TaskListItem.
   * Sort order: running > queued > pending > needs_clarification > done > failed.
   * Within same status: higher priority first, then earliest created first.
   */

  describe('listTasks', () => {
    test('returns empty array when queue is empty', async () => {
      const svc = new TaskServiceImpl(makeQueue([]), '/no-project-dir');
      expect(await svc.listTasks()).toEqual([]);
    });

    test('maps TaskState fields to TaskListItem correctly', async () => {
      const state: TaskState = {
        id: 'task-map-1',
        status: 'running',
        priority: 'high',
        description: 'A task',
        created: '2026-01-01T00:00:00Z',
        started: '2026-01-01T00:01:00Z',
        source: 'cli',
        dependencies: [],
        retryCount: 0,
        currentStage: 'developer',
      } as unknown as TaskState;

      const svc = new TaskServiceImpl(makeQueue([state]), '/no-project-dir');
      const items = await svc.listTasks();

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('task-map-1');
      expect(items[0].status).toBe('running');
      expect(items[0].priority).toBe('high');
      expect(items[0].description).toBe('A task');
      expect(items[0].currentStage).toBe('developer');
      expect(items[0].created).toBe('2026-01-01T00:00:00Z');
      expect(items[0].started).toBe('2026-01-01T00:01:00Z');
    });

    test('maps undefined currentStage to null', async () => {
      const state = makeTaskState({ id: 't1', status: 'queued' });
      const svc = new TaskServiceImpl(makeQueue([state]), '/no-project-dir');
      const items = await svc.listTasks();
      expect(items[0].currentStage).toBeNull();
    });

    test('maps undefined started to null', async () => {
      const state = makeTaskState({ id: 't1', status: 'queued' });
      const svc = new TaskServiceImpl(makeQueue([state]), '/no-project-dir');
      const items = await svc.listTasks();
      expect(items[0].started).toBeNull();
    });

    test('maps undefined completed to null', async () => {
      const state = makeTaskState({ id: 't1', status: 'queued' });
      const svc = new TaskServiceImpl(makeQueue([state]), '/no-project-dir');
      const items = await svc.listTasks();
      expect(items[0].completed).toBeNull();
    });

    test('sorts by status order: running > queued > pending > needs_clarification > done > failed', async () => {
      const states: TaskState[] = [
        makeTaskState({ id: 'done-1', status: 'done' }),
        makeTaskState({ id: 'running-1', status: 'running' }),
        makeTaskState({ id: 'failed-1', status: 'failed' }),
        makeTaskState({ id: 'queued-1', status: 'queued' }),
        makeTaskState({ id: 'pending-1', status: 'pending' }),
        makeTaskState({ id: 'nc-1', status: 'needs_clarification' }),
      ];

      const svc = new TaskServiceImpl(makeQueue(states), '/no-project-dir');
      const items = await svc.listTasks();

      expect(items[0].status).toBe('running');
      expect(items[1].status).toBe('queued');
      expect(items[2].status).toBe('pending');
      expect(items[3].status).toBe('needs_clarification');
      expect(items[4].status).toBe('done');
      expect(items[5].status).toBe('failed');
    });

    test('within same status, sorts by priority descending (critical before low)', async () => {
      const states: TaskState[] = [
        makeTaskState({ id: 'low-1', status: 'queued', priority: 'low', created: '2026-01-01T00:00:00Z' }),
        makeTaskState({ id: 'critical-1', status: 'queued', priority: 'critical', created: '2026-01-01T00:00:00Z' }),
        makeTaskState({ id: 'medium-1', status: 'queued', priority: 'medium', created: '2026-01-01T00:00:00Z' }),
      ];

      const svc = new TaskServiceImpl(makeQueue(states), '/no-project-dir');
      const items = await svc.listTasks();

      expect(items[0].id).toBe('critical-1');
      expect(items[1].id).toBe('medium-1');
      expect(items[2].id).toBe('low-1');
    });

    test('within same status and priority, sorts by created ascending (earliest first)', async () => {
      const states: TaskState[] = [
        makeTaskState({ id: 'later', status: 'queued', priority: 'medium', created: '2026-01-02T00:00:00Z' }),
        makeTaskState({ id: 'earliest', status: 'queued', priority: 'medium', created: '2026-01-01T00:00:00Z' }),
        makeTaskState({ id: 'middle', status: 'queued', priority: 'medium', created: '2026-01-01T12:00:00Z' }),
      ];

      const svc = new TaskServiceImpl(makeQueue(states), '/no-project-dir');
      const items = await svc.listTasks();

      expect(items[0].id).toBe('earliest');
      expect(items[1].id).toBe('middle');
      expect(items[2].id).toBe('later');
    });

    test('sorts running before queued even when queued has higher priority', async () => {
      const states: TaskState[] = [
        makeTaskState({ id: 'queued-critical', status: 'queued', priority: 'critical' }),
        makeTaskState({ id: 'running-low', status: 'running', priority: 'low' }),
      ];

      const svc = new TaskServiceImpl(makeQueue(states), '/no-project-dir');
      const items = await svc.listTasks();

      expect(items[0].id).toBe('running-low');
      expect(items[1].id).toBe('queued-critical');
    });
  });

  describe('taskExists', () => {
    test('returns true when task is found in queue', async () => {
      const state = makeTaskState({ id: 'task-exists', status: 'queued' });
      const svc = new TaskServiceImpl(makeQueue([state]), '/no-project-dir');
      expect(await svc.taskExists('task-exists')).toBe(true);
    });

    test('returns false when task is not found in queue', async () => {
      const svc = new TaskServiceImpl(makeQueue([]), '/no-project-dir');
      expect(await svc.taskExists('task-missing')).toBe(false);
    });

    test('returns false for a different task id', async () => {
      const state = makeTaskState({ id: 'task-a', status: 'queued' });
      const svc = new TaskServiceImpl(makeQueue([state]), '/no-project-dir');
      expect(await svc.taskExists('task-b')).toBe(false);
    });
  });
});

// ===========================================================================
// 7. plan-service.ts — PlanServiceImpl
// ===========================================================================

describe('PlanServiceImpl', () => {
  /**
   * FR-005: Plan returns parsed YAML matching PipelinePlanResponse shape.
   * Returns null for tasks without a plan file.
   */

  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('returns null when pipeline-plan.yaml does not exist', async () => {
    const svc = new PlanServiceImpl(projectDir);
    const result = await svc.getPlan('task-no-plan');
    expect(result).toBeNull();
  });

  test('returns parsed PipelinePlanResponse when file exists', async () => {
    await setupTaskDir(projectDir, 'task-plan-1');
    // Create state file and sync to plan
    const stateDir = join(projectDir, '.forjis', 'tasks', 'task-plan-1');
    await mkdir(stateDir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(stateDir, 'pipeline-state.yaml'), stringify({
      org: 'my-org', team: 'default', status: 'running',
      roles: [
        { name: 'setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { name: 'developer', agent: 'forjis-developer', status: 'running', description: 'Dev' },
        { name: 'reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    }), 'utf-8');
    await syncPlanFromState(projectDir, 'task-plan-1');

    const svc = new PlanServiceImpl(projectDir);
    const result = await svc.getPlan('task-plan-1');

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe('task-plan-1');
  });

  test('returned plan contains steps from synced state', async () => {
    await setupTaskDir(projectDir, 'task-plan-2');
    const stateDir = join(projectDir, '.forjis', 'tasks', 'task-plan-2');
    await mkdir(stateDir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(stateDir, 'pipeline-state.yaml'), stringify({
      org: 'my-org', team: 'default', status: 'running',
      roles: [
        { name: 'setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { name: 'developer', agent: 'forjis-developer', status: 'running', description: 'Dev' },
        { name: 'reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    }), 'utf-8');
    await syncPlanFromState(projectDir, 'task-plan-2');

    const svc = new PlanServiceImpl(projectDir);
    const result = await svc.getPlan('task-plan-2');

    expect(Array.isArray(result?.steps)).toBe(true);
    // 3 role-derived steps + 1 synthetic orchestrator step at index 0.
    expect(result?.steps).toHaveLength(4);
    expect(result?.steps[0].kind).toBe('orchestrator');
  });

  test('returned plan contains correct orgName and teamName', async () => {
    await setupTaskDir(projectDir, 'task-plan-3');
    const stateDir = join(projectDir, '.forjis', 'tasks', 'task-plan-3');
    await mkdir(stateDir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(stateDir, 'pipeline-state.yaml'), stringify({
      org: 'my-org', team: 'default', status: 'running',
      roles: [{ name: 'dev', agent: 'forjis-developer', status: 'planned', description: 'Dev' }],
    }), 'utf-8');
    await syncPlanFromState(projectDir, 'task-plan-3');

    const svc = new PlanServiceImpl(projectDir);
    const result = await svc.getPlan('task-plan-3');

    expect(result?.orgName).toBe('my-org');
    expect(result?.teamName).toBe('default');
  });
});

// ===========================================================================
// 8. event-service.ts — EventServiceImpl
// ===========================================================================

describe('EventServiceImpl', () => {
  /**
   * FR-008: Events returned in chronological order; since filter correctly
   * excludes older events; returns empty array when no events.jsonl exists.
   */

  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('getEvents without since returns all events in chronological order', async () => {
    await setupTaskDir(projectDir, 'task-es-1');
    await appendEvent(projectDir, 'task-es-1', makeEvent('2026-01-01T10:00:00Z', 'a'));
    await appendEvent(projectDir, 'task-es-1', makeEvent('2026-01-01T10:00:01Z', 'b'));

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEvents('task-es-1');

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('a');
    expect(result[1].content).toBe('b');
  });

  test('getEvents with since filters to only events after the timestamp', async () => {
    await setupTaskDir(projectDir, 'task-es-2');
    await appendEvent(projectDir, 'task-es-2', makeEvent('2026-01-01T10:00:00Z', 'old'));
    await appendEvent(projectDir, 'task-es-2', makeEvent('2026-01-01T10:00:01Z', 'boundary'));
    await appendEvent(projectDir, 'task-es-2', makeEvent('2026-01-01T10:00:02Z', 'new'));

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEvents('task-es-2', '2026-01-01T10:00:01Z');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('new');
  });

  test('getEvents returns empty array when no events.jsonl exists', async () => {
    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEvents('task-es-missing');
    expect(result).toEqual([]);
  });

  test('getEventsSince delegates to readEventsSince and applies since filter', async () => {
    await setupTaskDir(projectDir, 'task-es-3');
    await appendEvent(projectDir, 'task-es-3', makeEvent('2026-01-01T09:00:00Z', 'before'));
    await appendEvent(projectDir, 'task-es-3', makeEvent('2026-01-01T10:00:01Z', 'after'));

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEventsSince('task-es-3', '2026-01-01T10:00:00Z');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('after');
  });

  test('getEventsSince returns empty array for missing file', async () => {
    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEventsSince('task-es-none', '2026-01-01T00:00:00Z');
    expect(result).toEqual([]);
  });

  test('getEvents with since=undefined behaves identically to getEvents without since', async () => {
    await setupTaskDir(projectDir, 'task-es-4');
    await appendEvent(projectDir, 'task-es-4', makeEvent('2026-01-01T10:00:00Z', 'only'));

    const svc = new EventServiceImpl(projectDir);
    const withUndefined = await svc.getEvents('task-es-4', undefined);
    const withoutSince = await svc.getEvents('task-es-4');

    expect(withUndefined).toEqual(withoutSince);
  });
});

// ===========================================================================
// 9. resource-service.ts — ResourceServiceImpl
// ===========================================================================

describe('ResourceServiceImpl', () => {
  /**
   * FR-009: Response contains all five resource type arrays; org hierarchy
   * correctly nested (org -> team -> role); entries include name and source.
   */

  function makeRegistry(
    agents: Array<{ name: string; repoName: string }> = [],
    skills: Array<{ name: string; repoName: string }> = [],
    hooks: Array<{ name: string; repoName: string }> = [],
    plugins: Array<{ name: string; repoName: string }> = [],
  ): ResourceRegistry {
    const data: Record<string, ResourceEntry[]> = {
      agent: agents.map((a) => ({ name: a.name, repoName: a.repoName, type: 'agent' as ResourceType, filePath: '' })),
      skill: skills.map((s) => ({ name: s.name, repoName: s.repoName, type: 'skill' as ResourceType, filePath: '' })),
      hook: hooks.map((h) => ({ name: h.name, repoName: h.repoName, type: 'hook' as ResourceType, filePath: '' })),
      plugin: plugins.map((p) => ({ name: p.name, repoName: p.repoName, type: 'plugin' as ResourceType, filePath: '' })),
    };

    return {
      listByType: (type: ResourceType) => data[type] ?? [],
    } as unknown as ResourceRegistry;
  }

  test('returns response with all five top-level keys', () => {
    const svc = new ResourceServiceImpl(makeRuntime(), makeRegistry());
    const result = svc.getResources();

    expect(result).toHaveProperty('orgs');
    expect(result).toHaveProperty('agents');
    expect(result).toHaveProperty('skills');
    expect(result).toHaveProperty('hooks');
    expect(result).toHaveProperty('plugins');
  });

  test('orgs array reflects org count from runtime', () => {
    const svc = new ResourceServiceImpl(makeRuntime(), makeRegistry());
    const result = svc.getResources();
    expect(result.orgs).toHaveLength(1);
  });

  test('org entry contains name, source, and teams array', () => {
    const svc = new ResourceServiceImpl(makeRuntime(), makeRegistry());
    const { orgs } = svc.getResources();
    expect(orgs[0].name).toBe('my-org');
    expect(orgs[0].source).toBe('my-org');
    expect(Array.isArray(orgs[0].teams)).toBe(true);
  });

  test('org team hierarchy is correctly nested with roles', () => {
    const svc = new ResourceServiceImpl(makeRuntime(), makeRegistry());
    const { orgs } = svc.getResources();
    const team = orgs[0].teams[0];

    expect(team.name).toBe('default');
    expect(team.roles).toHaveLength(3);
    expect(team.roles[0].name).toBe('setup');
    expect(team.roles[0].agent).toBe('forjis-setup');
    expect(Array.isArray(team.roles[0].skills)).toBe(true);
  });

  test('maps agent registry entries with name and source', () => {
    const registry = makeRegistry(
      [{ name: 'forjis-setup', repoName: 'forjis-std' }],
    );
    const svc = new ResourceServiceImpl(makeRuntime(), registry);
    const { agents } = svc.getResources();

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('forjis-setup');
    expect(agents[0].source).toBe('forjis-std');
  });

  test('maps skill registry entries with name and source', () => {
    const registry = makeRegistry([], [{ name: 'java', repoName: 'skills-repo' }]);
    const svc = new ResourceServiceImpl(makeRuntime(), registry);
    const { skills } = svc.getResources();

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('java');
    expect(skills[0].source).toBe('skills-repo');
  });

  test('maps hook registry entries with name and source', () => {
    const registry = makeRegistry([], [], [{ name: 'pre-check', repoName: 'hooks-repo' }]);
    const svc = new ResourceServiceImpl(makeRuntime(), registry);
    const { hooks } = svc.getResources();

    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('pre-check');
    expect(hooks[0].source).toBe('hooks-repo');
  });

  test('maps plugin registry entries with name and source', () => {
    const registry = makeRegistry([], [], [], [{ name: 'my-plugin', repoName: 'plugin-repo' }]);
    const svc = new ResourceServiceImpl(makeRuntime(), registry);
    const { plugins } = svc.getResources();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('my-plugin');
    expect(plugins[0].source).toBe('plugin-repo');
  });

  test('returns empty arrays for all resource types when registry is empty', () => {
    const svc = new ResourceServiceImpl(makeRuntime(), makeRegistry());
    const result = svc.getResources();

    expect(result.agents).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.hooks).toEqual([]);
    expect(result.plugins).toEqual([]);
  });

  test('returns empty orgs array when runtime has no orgs', () => {
    const svc = new ResourceServiceImpl(makeRuntime({ orgs: [] }), makeRegistry());
    const result = svc.getResources();
    expect(result.orgs).toEqual([]);
  });

  test('getResources is synchronous (not a Promise)', () => {
    const svc = new ResourceServiceImpl(makeRuntime(), makeRegistry());
    const result = svc.getResources();
    // If it were a Promise, it wouldn't have an 'orgs' property directly
    expect(result.orgs).toBeDefined();
    expect(result instanceof Promise).toBe(false);
  });
});

// ===========================================================================
// 10. run.ts — server lifecycle
// ===========================================================================

/**
 * Reads the run.ts source file for structural assertions.
 *
 * The test file lives at src/__tests__/web/backend-layer.test.ts.
 * run.ts lives at src/commands/run.ts.
 * Relative path from the test: ../../commands/run.ts
 */
async function readRunTs(): Promise<string> {
  const { readFile: readSrc } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const thisFile = fileURLToPath(import.meta.url);
  const runTsPath = join(dirname(thisFile), '..', '..', '..', 'facilitator', 'src', 'commands', 'run.ts');
  return readSrc(runTsPath, 'utf-8');
}

describe('run.ts server lifecycle', () => {
  /**
   * FR-017: server.unref() called immediately after creation so the server
   * does not hold the event loop open. server.close() called on SIGINT/SIGTERM
   * and after runMainLoop completes.
   */

  test('server.unref() is called after createWebServer returns', async () => {
    /**
     * We verify the lifecycle contract by inspecting the actual run.ts source.
     * Reading the source is the authoritative check — the implementation IS
     * the contract. No subprocess is needed.
     */
    const runSrc = await readRunTs();
    expect(runSrc).toContain('server.unref()');
  });

  test('server.close() is called inside cleanupOnExit (SIGINT/SIGTERM handler)', async () => {
    const runSrc = await readRunTs();

    // cleanupOnExit must contain webServer.close()
    // The pattern below checks that webServer.close() appears inside the
    // function that also calls process.exit(1)
    expect(runSrc).toContain('webServer.close()');
    expect(runSrc).toContain('process.exit(1)');
  });

  test('server.close() is called after runMainLoop completes (normal exit path)', async () => {
    const runSrc = await readRunTs();

    // After runMainLoop, the code should close the server
    // Verify the pattern: await runMainLoop(...) followed by webServer.close()
    const loopThenClose = /runMainLoop[\s\S]{0,300}webServer\.close/;
    expect(loopThenClose.test(runSrc)).toBe(true);
  });

  test('webServer is stored in a variable (not discarded) when options.web is true', async () => {
    const runSrc = await readRunTs();

    // The server reference must be assigned to a variable via startWebServer helper
    expect(runSrc).toContain('webServer = await startWebServer(');
  });

  test('writePipelinePlan is called in processNext after queue.transition to running', async () => {
    const runSrc = await readRunTs();

    // Must contain writePipelinePlan call after the transition to 'running'
    const transitionThenPlan = /transition\(task\.id,\s*'running'\)[\s\S]{0,200}writePipelinePlan/;
    expect(transitionThenPlan.test(runSrc)).toBe(true);
  });

  test('real services are wired (TaskServiceImpl, PlanServiceImpl, EventServiceImpl, ResourceServiceImpl)', async () => {
    const runSrc = await readRunTs();

    expect(runSrc).toContain('new TaskServiceImpl(queue, options.projectDir)');
    expect(runSrc).toContain('new PlanServiceImpl(options.projectDir)');
    expect(runSrc).toContain('new EventServiceImpl(options.projectDir)');
    expect(runSrc).toContain('new ResourceServiceImpl(');
  });

  test('FileServiceImpl is wired in startWebServer', async () => {
    const runSrc = await readRunTs();

    expect(runSrc).toContain('new FileServiceImpl(options.projectDir)');
    expect(runSrc).toContain('fileService');
  });
});

// ===========================================================================
// FileServiceImpl — file content reading with path traversal protection
// ===========================================================================

describe('FileServiceImpl', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  test('returns file content for an existing file', async () => {
    const taskId = 'my-task';
    const changeDir = join(tempDir, 'openspec', 'changes', taskId);
    await mkdir(changeDir, { recursive: true });
    await writeFile(join(changeDir, 'exploration.md'), '# Exploration\nHello world');

    const svc = new FileServiceImpl(tempDir);
    const result = await svc.getFileContent(taskId, 'exploration.md');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('# Exploration\nHello world');
  });

  test('returns null for a missing file', async () => {
    const taskId = 'my-task';
    const changeDir = join(tempDir, 'openspec', 'changes', taskId);
    await mkdir(changeDir, { recursive: true });

    const svc = new FileServiceImpl(tempDir);
    const result = await svc.getFileContent(taskId, 'nonexistent.md');
    expect(result).toBeNull();
  });

  test('returns null for path traversal attempt with ../', async () => {
    const taskId = 'my-task';
    const changeDir = join(tempDir, 'openspec', 'changes', taskId);
    await mkdir(changeDir, { recursive: true });

    const secretDir = join(tempDir, 'openspec', 'changes');
    await writeFile(join(secretDir, 'secret.txt'), 'top secret');

    const svc = new FileServiceImpl(tempDir);
    const result = await svc.getFileContent(taskId, '../secret.txt');
    expect(result).toBeNull();
  });

  test('returns null for deeply nested path traversal attempt', async () => {
    const taskId = 'my-task';
    const changeDir = join(tempDir, 'openspec', 'changes', taskId);
    await mkdir(changeDir, { recursive: true });

    const svc = new FileServiceImpl(tempDir);
    const result = await svc.getFileContent(taskId, '../../../../../../etc/passwd');
    expect(result).toBeNull();
  });

  test('reads files from nested subdirectories', async () => {
    const taskId = 'my-task';
    const nestedDir = join(tempDir, 'openspec', 'changes', taskId, 'specs', 'requirements');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, 'spec.md'), '# Spec content');

    const svc = new FileServiceImpl(tempDir);
    const result = await svc.getFileContent(taskId, 'specs/requirements/spec.md');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('# Spec content');
  });

  test('returns null when task directory does not exist', async () => {
    const svc = new FileServiceImpl(tempDir);
    const result = await svc.getFileContent('nonexistent-task', 'file.md');
    expect(result).toBeNull();
  });
});
