/**
 * Backend-layer unit tests for plan-writer's linear `deps` chain and synthetic
 * orchestrator step (Phase C of redesign-013-api-contract-extensions).
 *
 * Validates that:
 *   - The plan starts with a synthetic orchestrator step (`kind: 'orchestrator'`,
 *     `deps: []`).
 *   - Every role-derived step gets a `deps` array.
 *   - The first role-derived step depends on the orchestrator.
 *   - Subsequent role-derived steps form a linear chain
 *     (`steps[i].deps === [steps[i-1].role]`).
 *   - Skipped roles preserve their natural stage position in the chain.
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { syncPlanFromState, readYamlFile } from '@forjis/facilitator';
import type { PipelinePlanResponse } from '../types.js';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-plan-deps-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function writePipelineState(
  projectDir: string,
  taskId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(dir, { recursive: true });
  const { stringify } = await import('yaml');
  await writeFile(join(dir, 'pipeline-state.yaml'), stringify(state), 'utf-8');
}

async function readPlan(projectDir: string, taskId: string): Promise<PipelinePlanResponse> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const plan = await readYamlFile<PipelinePlanResponse>(planPath);
  if (!plan) throw new Error(`No plan written at ${planPath}`);
  return plan;
}

describe('plan-writer linear deps chain + synthetic orchestrator step', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('prepends synthetic orchestrator step and chains roles linearly', async () => {
    await writePipelineState(projectDir, 't-deps-1', {
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'Explorer', agent: 'forjis-explorer', status: 'planned', description: 'Explore' },
        { name: 'Analyst', agent: 'forjis-analyst', status: 'skipped', description: 'Analyze' },
        { name: 'Architect', agent: 'forjis-architect', status: 'planned', description: 'Design' },
        { name: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Build' },
      ],
    });

    expect(await syncPlanFromState(projectDir, 't-deps-1')).toBe(true);

    const plan = await readPlan(projectDir, 't-deps-1');
    expect(plan.steps).toHaveLength(5);

    expect(plan.steps[0].kind).toBe('orchestrator');
    expect(plan.steps[0].role).toBe('orchestrator');
    expect(plan.steps[0].deps).toEqual([]);

    expect(plan.steps[1].role).toBe('Explorer');
    expect(plan.steps[1].deps).toEqual(['orchestrator']);

    expect(plan.steps[2].role).toBe('Analyst');
    expect(plan.steps[2].status).toBe('skipped');
    expect(plan.steps[2].deps).toEqual(['Explorer']);

    expect(plan.steps[3].role).toBe('Architect');
    expect(plan.steps[3].deps).toEqual(['Analyst']);

    expect(plan.steps[4].role).toBe('Developer');
    expect(plan.steps[4].deps).toEqual(['Architect']);
  });

  test('orchestrator step status mirrors pipeline-state status (running)', async () => {
    await writePipelineState(projectDir, 't-deps-2', {
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'Setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
      ],
    });

    await syncPlanFromState(projectDir, 't-deps-2');
    const plan = await readPlan(projectDir, 't-deps-2');

    expect(plan.steps[0].kind).toBe('orchestrator');
    expect(plan.steps[0].status).toBe('running');
  });

  test('orchestrator step status collapses failed to done', async () => {
    await writePipelineState(projectDir, 't-deps-3', {
      org: 'my-org',
      team: 'default',
      status: 'failed',
      roles: [
        { name: 'Setup', agent: 'forjis-setup', status: 'failed', description: 'Setup' },
      ],
    });

    await syncPlanFromState(projectDir, 't-deps-3');
    const plan = await readPlan(projectDir, 't-deps-3');

    expect(plan.steps[0].kind).toBe('orchestrator');
    expect(plan.steps[0].status).toBe('done');
  });

  test('orchestrator step pulls timing from queue state.yaml when present', async () => {
    const taskDir = join(projectDir, '.forjis', 'tasks', 't-deps-4');
    await mkdir(taskDir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(taskDir, 'state.yaml'), stringify({
      id: 't-deps-4',
      status: 'running',
      priority: 'medium',
      created: '2026-04-19T10:00:00Z',
      started: '2026-04-19T10:00:01Z',
      source: 'cli',
      dependencies: [],
      description: 'test',
      retryCount: 0,
    }), 'utf-8');
    await writeFile(join(taskDir, 'pipeline-state.yaml'), stringify({
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'Explorer', agent: 'forjis-explorer', status: 'running', description: 'Explore' },
      ],
    }), 'utf-8');

    await syncPlanFromState(projectDir, 't-deps-4');
    const plan = await readPlan(projectDir, 't-deps-4');

    expect(plan.steps[0].startedAt).toBe('2026-04-19T10:00:01Z');
  });

  test('returns false and writes nothing when no pipeline-state.yaml exists', async () => {
    const result = await syncPlanFromState(projectDir, 't-deps-missing');
    expect(result).toBe(false);
  });
});
