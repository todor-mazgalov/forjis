/**
 * Unit tests for TaskServiceImpl and computeProgress (redesign-021-fixes §15b).
 *
 * Validates that progress.steps is emitted correctly from computeProgress:
 *   - steps array contains one entry per non-orchestrator role, in plan order.
 *   - Each entry carries the correct role and status fields.
 *   - The orchestrator pseudo-step is excluded from the steps array.
 *   - An empty roleSteps list produces steps: [].
 *   - Missing plan file returns null (no progress).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';

import { writeYamlFile } from '../state.js';
import { TaskQueue } from '../task-queue.js';
import { TaskServiceImpl } from '../web-services/task-service.js';
import type { TaskState } from '../types.js';
import type { PipelinePlanResponse } from '@forjis/shared';

/** Creates a unique temporary directory for test isolation. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-task-svc-'));
}

/** Removes the temporary directory after test completion. */
async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Writes a task state file for a given task. */
async function writeTaskState(projectDir: string, taskId: string, state: TaskState): Promise<void> {
  const stateDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(stateDir, { recursive: true });
  await writeYamlFile(join(stateDir, 'state.yaml'), state);
}

/** Writes a pipeline-plan.yaml file for a given task. */
async function writePipelinePlan(projectDir: string, taskId: string, plan: PipelinePlanResponse): Promise<void> {
  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  await writeYamlFile(join(taskDir, 'pipeline-plan.yaml'), plan);
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

/** Builds a minimal PipelinePlanResponse for testing. */
function makePlan(taskId: string, steps: PipelinePlanResponse['steps']): PipelinePlanResponse {
  return {
    taskId,
    orgName: 'test-org',
    teamName: 'test-team',
    steps,
  };
}

describe('computeProgress — steps field', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('emits steps array with role and status per non-orchestrator step', async () => {
    const taskId = 'task-steps-basic';
    await writeTaskState(tmpDir, taskId, makeTaskState(taskId));

    const plan = makePlan(taskId, [
      { role: 'org:team:developer', agent: 'dev-agent', status: 'done', description: 'Developer' },
      { role: 'org:team:reviewer', agent: 'rev-agent', status: 'running', description: 'Reviewer' },
      { role: 'org:team:qa', agent: 'qa-agent', status: 'planned', description: 'QA' },
    ]);
    await writePipelinePlan(tmpDir, taskId, plan);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.progress).toBeDefined();
    expect(item!.progress!.steps).toEqual([
      { role: 'org:team:developer', status: 'done' },
      { role: 'org:team:reviewer', status: 'running' },
      { role: 'org:team:qa', status: 'planned' },
    ]);
  });

  it('excludes orchestrator pseudo-step from the steps array', async () => {
    const taskId = 'task-steps-orchestrator';
    await writeTaskState(tmpDir, taskId, makeTaskState(taskId));

    const plan = makePlan(taskId, [
      { role: 'org:team:orchestrator', agent: 'orch-agent', status: 'done', description: 'Orchestrator', kind: 'orchestrator' },
      { role: 'org:team:developer', agent: 'dev-agent', status: 'running', description: 'Developer' },
      { role: 'org:team:reviewer', agent: 'rev-agent', status: 'planned', description: 'Reviewer' },
    ]);
    await writePipelinePlan(tmpDir, taskId, plan);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item!.progress!.steps).toHaveLength(2);
    expect(item!.progress!.steps.map((s) => s.role)).toEqual([
      'org:team:developer',
      'org:team:reviewer',
    ]);
  });

  it('produces empty steps array when all steps are orchestrator kind', async () => {
    const taskId = 'task-steps-empty';
    await writeTaskState(tmpDir, taskId, makeTaskState(taskId));

    const plan = makePlan(taskId, [
      { role: 'org:team:orchestrator', agent: 'orch-agent', status: 'done', description: 'Orchestrator', kind: 'orchestrator' },
    ]);
    await writePipelinePlan(tmpDir, taskId, plan);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item!.progress).toBeDefined();
    expect(item!.progress!.steps).toEqual([]);
    expect(item!.progress!.total).toBe(0);
    expect(item!.progress!.done).toBe(0);
    expect(item!.progress!.current).toBeNull();
  });

  it('returns no progress when plan file is missing', async () => {
    const taskId = 'task-no-plan';
    await writeTaskState(tmpDir, taskId, makeTaskState(taskId));

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    expect(item).toBeDefined();
    expect(item!.progress).toBeUndefined();
  });

  it('preserves plan order in the steps array', async () => {
    const taskId = 'task-steps-order';
    await writeTaskState(tmpDir, taskId, makeTaskState(taskId));

    const plan = makePlan(taskId, [
      { role: 'org:team:architect', agent: 'arch-agent', status: 'done', description: 'Architect' },
      { role: 'org:team:developer', agent: 'dev-agent', status: 'done', description: 'Developer' },
      { role: 'org:team:reviewer', agent: 'rev-agent', status: 'running', description: 'Reviewer' },
      { role: 'org:team:qa', agent: 'qa-agent', status: 'planned', description: 'QA' },
      { role: 'org:team:skipped-role', agent: 'skip-agent', status: 'skipped', description: 'Skipped' },
    ]);
    await writePipelinePlan(tmpDir, taskId, plan);

    const queue = new TaskQueue(tmpDir, null);
    const service = new TaskServiceImpl(queue, tmpDir);
    const items = await service.listTasks();

    const item = items.find((i) => i.id === taskId);
    const roles = item!.progress!.steps.map((s) => s.role);
    expect(roles).toEqual([
      'org:team:architect',
      'org:team:developer',
      'org:team:reviewer',
      'org:team:qa',
      'org:team:skipped-role',
    ]);

    const statuses = item!.progress!.steps.map((s) => s.status);
    expect(statuses).toEqual(['done', 'done', 'running', 'planned', 'skipped']);
  });
});
