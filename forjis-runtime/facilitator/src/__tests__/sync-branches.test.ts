/**
 * Unit tests for syncBranchesFromState() in plan-writer.ts.
 *
 * Validates that branch data flows correctly from pipeline-state.yaml
 * to queue state.yaml, including no-op behavior when data is unchanged
 * or missing.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';

import { readYamlFile, writeYamlFile } from '../state.js';
import { syncBranchesFromState } from '../web-services/plan-writer.js';
import { TaskQueue } from '../task-queue.js';
import type { TaskState } from '../types.js';

/** Creates a unique temporary directory for test isolation. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-sync-branches-'));
}

/** Removes the temporary directory after test completion. */
async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Creates a minimal task state file in the queue directory. */
async function writeTaskState(projectDir: string, taskId: string, state: TaskState): Promise<void> {
  const stateDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(stateDir, { recursive: true });
  await writeYamlFile(join(stateDir, 'state.yaml'), state);
}

/** Creates a pipeline-state.yaml file in the task directory. */
async function writePipelineState(
  projectDir: string,
  taskId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  await writeYamlFile(join(taskDir, 'pipeline-state.yaml'), data);
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

describe('syncBranchesFromState', () => {
  let tmpDir: string;
  const taskId = 'test-task-001';

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('reads branches from pipeline-state.yaml and writes to state.yaml', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = makeTaskState(taskId);
    await writeTaskState(tmpDir, taskId, state);
    await writePipelineState(tmpDir, taskId, {
      org: 'TestOrg',
      team: 'Dev',
      status: 'running',
      branches: ['main', 'forjis/test-task-001'],
      roles: [],
    });

    const result = await syncBranchesFromState(tmpDir, taskId, queue);

    expect(result).toBe(true);
    const updated = await readYamlFile<TaskState>(
      join(tmpDir, '.forjis', 'tasks', taskId, 'state.yaml'),
    );
    expect(updated?.branches).toEqual(['main', 'forjis/test-task-001']);
  });

  it('returns false when pipeline-state.yaml has no branches field', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = makeTaskState(taskId);
    await writeTaskState(tmpDir, taskId, state);
    await writePipelineState(tmpDir, taskId, {
      org: 'TestOrg',
      team: 'Dev',
      status: 'running',
      roles: [],
    });

    const result = await syncBranchesFromState(tmpDir, taskId, queue);

    expect(result).toBe(false);
  });

  it('returns false when pipeline-state.yaml does not exist', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = makeTaskState(taskId);
    await writeTaskState(tmpDir, taskId, state);

    const result = await syncBranchesFromState(tmpDir, taskId, queue);

    expect(result).toBe(false);
  });

  it('does not write when branches are unchanged', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const branches = ['main', 'forjis/test-task-001'];
    const state = makeTaskState(taskId, { branches });
    await writeTaskState(tmpDir, taskId, state);
    await writePipelineState(tmpDir, taskId, {
      org: 'TestOrg',
      team: 'Dev',
      status: 'running',
      branches,
      roles: [],
    });

    const result = await syncBranchesFromState(tmpDir, taskId, queue);

    expect(result).toBe(false);
  });

  it('returns false when task state does not exist in queue', async () => {
    const queue = new TaskQueue(tmpDir, null);
    await writePipelineState(tmpDir, taskId, {
      org: 'TestOrg',
      team: 'Dev',
      status: 'running',
      branches: ['main', 'forjis/test-task-001'],
      roles: [],
    });

    const result = await syncBranchesFromState(tmpDir, taskId, queue);

    expect(result).toBe(false);
  });

  it('handles multi-hop branch chains', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = makeTaskState(taskId);
    await writeTaskState(tmpDir, taskId, state);
    await writePipelineState(tmpDir, taskId, {
      org: 'TestOrg',
      team: 'Dev',
      status: 'running',
      branches: ['main', 'forjis/task-1', 'forjis/task-1/hotfix'],
      roles: [],
    });

    const result = await syncBranchesFromState(tmpDir, taskId, queue);

    expect(result).toBe(true);
    const updated = await readYamlFile<TaskState>(
      join(tmpDir, '.forjis', 'tasks', taskId, 'state.yaml'),
    );
    expect(updated?.branches).toEqual(['main', 'forjis/task-1', 'forjis/task-1/hotfix']);
  });
});
