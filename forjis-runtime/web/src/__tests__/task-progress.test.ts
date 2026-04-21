/**
 * Backend-layer unit tests for TaskServiceImpl.listTasks()'s `progress`
 * augmentation (Phase E of redesign-013-api-contract-extensions,
 * updated redesign-021-fixes §15 for `steps` field).
 *
 * Validates that:
 *   - Running tasks with a 5-step plan return progress { total, done, current }.
 *   - The synthetic orchestrator pseudo-step is excluded from the count.
 *   - Done/queued/pending tasks return progress absent.
 *   - Running tasks whose plan file is missing return progress absent
 *     (graceful degradation).
 *
 * Tests use `expect.objectContaining` for progress assertions because the
 * `steps` array field was added in redesign-021-fixes — existing callers must
 * still see the original `total`/`done`/`current` fields unchanged.
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskServiceImpl } from '@forjis/facilitator';
import type { TaskQueue, TaskState } from '@forjis/facilitator';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-task-progress-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function makeQueue(states: TaskState[]): TaskQueue {
  return {
    listAll: async () => states,
    getState: async (id: string) => states.find((s) => s.id === id) ?? null,
  } as unknown as TaskQueue;
}

function makeState(overrides: Partial<TaskState> & { id: string; status: TaskState['status'] }): TaskState {
  return {
    priority: 'medium',
    description: 'progress fixture',
    created: '2026-04-19T10:00:00Z',
    source: 'cli',
    dependencies: [],
    retryCount: 0,
    ...overrides,
  } as TaskState;
}

async function writePlan(projectDir: string, taskId: string, plan: unknown): Promise<void> {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(dir, { recursive: true });
  const { stringify } = await import('yaml');
  await writeFile(join(dir, 'pipeline-plan.yaml'), stringify(plan), 'utf-8');
}

describe('TaskServiceImpl progress augmentation', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('running task with 5-step plan returns total/done/current', async () => {
    const taskId = 'task-progress-1';
    await writePlan(projectDir, taskId, {
      taskId,
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { kind: 'orchestrator', role: 'orchestrator', agent: '', status: 'running', description: 'orch', deps: [] },
        { role: 'Setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { role: 'Explorer', agent: 'forjis-explorer', status: 'running', description: 'Explore' },
        { role: 'Architect', agent: 'forjis-architect', status: 'planned', description: 'Design' },
        { role: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Build' },
        { role: 'Reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    });

    const queue = makeQueue([makeState({ id: taskId, status: 'running' })]);
    const svc = new TaskServiceImpl(queue, projectDir);
    const items = await svc.listTasks();

    expect(items).toHaveLength(1);
    expect(items[0].progress).toEqual(expect.objectContaining({
      total: 5,
      done: 1,
      current: 'Explorer',
    }));
  });

  test('orchestrator pseudo-step is excluded from total', async () => {
    const taskId = 'task-progress-2';
    // Plan that has only orchestrator + 1 running role.
    await writePlan(projectDir, taskId, {
      taskId,
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { kind: 'orchestrator', role: 'orchestrator', agent: '', status: 'running', description: 'orch', deps: [] },
        { role: 'Developer', agent: 'forjis-developer', status: 'running', description: 'Build' },
      ],
    });

    const queue = makeQueue([makeState({ id: taskId, status: 'running' })]);
    const svc = new TaskServiceImpl(queue, projectDir);
    const items = await svc.listTasks();

    expect(items[0].progress).toEqual(expect.objectContaining({
      total: 1,
      done: 0,
      current: 'Developer',
    }));
  });

  test('done task does not get a progress field', async () => {
    const taskId = 'task-progress-done';
    await writePlan(projectDir, taskId, {
      taskId,
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { kind: 'orchestrator', role: 'orchestrator', agent: '', status: 'done', description: 'orch', deps: [] },
        { role: 'Developer', agent: 'forjis-developer', status: 'done', description: 'Build' },
      ],
    });

    const queue = makeQueue([makeState({ id: taskId, status: 'done', completed: '2026-04-19T11:00:00Z' })]);
    const svc = new TaskServiceImpl(queue, projectDir);
    const items = await svc.listTasks();

    expect(items[0].progress).toBeUndefined();
  });

  test('running task with no plan file returns progress absent', async () => {
    const taskId = 'task-progress-no-plan';
    const queue = makeQueue([makeState({ id: taskId, status: 'running' })]);
    const svc = new TaskServiceImpl(queue, projectDir);
    const items = await svc.listTasks();

    expect(items[0].progress).toBeUndefined();
  });

  test('current falls back to first non-done/skipped step when nothing is running', async () => {
    const taskId = 'task-progress-fallback';
    await writePlan(projectDir, taskId, {
      taskId,
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { kind: 'orchestrator', role: 'orchestrator', agent: '', status: 'running', description: 'orch', deps: [] },
        { role: 'Setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { role: 'Explorer', agent: 'forjis-explorer', status: 'planned', description: 'Explore' },
      ],
    });

    const queue = makeQueue([makeState({ id: taskId, status: 'running' })]);
    const svc = new TaskServiceImpl(queue, projectDir);
    const items = await svc.listTasks();

    expect(items[0].progress).toEqual(expect.objectContaining({
      total: 2,
      done: 1,
      current: 'Explorer',
    }));
  });

  test('current is null when all roles are done or skipped', async () => {
    const taskId = 'task-progress-all-done';
    await writePlan(projectDir, taskId, {
      taskId,
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { kind: 'orchestrator', role: 'orchestrator', agent: '', status: 'done', description: 'orch', deps: [] },
        { role: 'Developer', agent: 'forjis-developer', status: 'done', description: 'Build' },
        { role: 'Reviewer', agent: 'forjis-reviewer', status: 'skipped', description: 'Review' },
      ],
    });

    const queue = makeQueue([makeState({ id: taskId, status: 'running' })]);
    const svc = new TaskServiceImpl(queue, projectDir);
    const items = await svc.listTasks();

    expect(items[0].progress).toEqual(expect.objectContaining({
      total: 2,
      done: 2,
      current: null,
    }));
  });
});
