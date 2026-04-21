/**
 * Unit tests for TaskServiceImpl.listTasks() branch mapping.
 *
 * Validates that the branches field flows correctly from TaskState
 * through to TaskListItem, including undefined handling.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';

import { writeYamlFile } from '../state.js';
import { TaskQueue } from '../task-queue.js';
import { TaskServiceImpl } from '../web-services/task-service.js';
import type { TaskState } from '../types.js';

/** Creates a unique temporary directory for test isolation. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-task-service-'));
}

/** Removes the temporary directory after test completion. */
async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Creates a task state file in the queue directory. */
async function writeTaskState(projectDir: string, taskId: string, state: TaskState): Promise<void> {
  const stateDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(stateDir, { recursive: true });
  await writeYamlFile(join(stateDir, 'state.yaml'), state);
}

/** Builds a minimal TaskState for testing. */
function makeTaskState(taskId: string, overrides?: Partial<TaskState>): TaskState {
  return {
    id: taskId,
    status: 'running',
    priority: 'medium',
    created: new Date().toISOString(),
    source: 'cli' as const,
    dependencies: [],
    description: 'test task',
    retryCount: 0,
    ...overrides,
  };
}

describe('TaskServiceImpl.listTasks() branches mapping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('includes branches in output when set in TaskState', async () => {
    const taskId = 'task-with-branches';
    const branches = ['main', 'forjis/task-with-branches'];
    const state = makeTaskState(taskId, { branches });
    await writeTaskState(tmpDir, taskId, state);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.branches).toEqual(branches);
  });

  it('returns undefined branches when not set in TaskState', async () => {
    const taskId = 'task-no-branches';
    const state = makeTaskState(taskId);
    await writeTaskState(tmpDir, taskId, state);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.branches).toBeUndefined();
  });

  it('handles multi-hop branch chains in output', async () => {
    const taskId = 'task-multi-branch';
    const branches = ['main', 'forjis/task-1', 'forjis/task-1/hotfix'];
    const state = makeTaskState(taskId, { branches });
    await writeTaskState(tmpDir, taskId, state);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.branches).toEqual(branches);
  });
});
