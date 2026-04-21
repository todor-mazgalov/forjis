/**
 * Backend-layer regression test for the org-mode pipeline-state.yaml ordering
 * contract (Phase C of redesign-013-api-contract-extensions).
 *
 * The orchestrator (an LLM) is responsible for writing roles in pipeline-stage
 * order, RUN and SKIP interleaved at their natural positions. The plan-writer
 * MUST preserve that order verbatim and MUST NOT drop any role. This test
 * uses a hand-authored pipeline-state.yaml with a SKIP entry in the middle
 * of natural stage order, runs syncPlanFromState, and asserts the plan
 * preserves both the count and the order.
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { syncPlanFromState, readYamlFile } from '@forjis/facilitator';
import type { PipelinePlanResponse } from '../types.js';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-plan-order-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe('plan-writer preserves pipeline-state.yaml order', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('preserves natural stage order with SKIP entries interleaved', async () => {
    const taskId = 't-order-1';
    const dir = join(projectDir, '.forjis', 'tasks', taskId);
    await mkdir(dir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(dir, 'pipeline-state.yaml'), stringify({
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'Setup', agent: 'forjis-setup', status: 'done', description: 'Setup' },
        { name: 'Explorer', agent: 'forjis-explorer', status: 'planned', description: 'Explore' },
        { name: 'Analyst', agent: 'forjis-analyst', status: 'skipped', description: 'Analyze' },
        { name: 'Architect', agent: 'forjis-architect', status: 'planned', description: 'Design' },
        { name: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Build' },
        { name: 'Reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    }), 'utf-8');

    expect(await syncPlanFromState(projectDir, taskId)).toBe(true);

    const plan = await readYamlFile<PipelinePlanResponse>(
      join(dir, 'pipeline-plan.yaml'),
    );
    if (!plan) throw new Error('Plan was not written');

    // 6 roles + 1 synthetic orchestrator step.
    expect(plan.steps).toHaveLength(7);

    // Verify orchestrator at index 0.
    expect(plan.steps[0].kind).toBe('orchestrator');

    // Verify role-derived steps preserve fixture order verbatim.
    const expectedOrder = ['Setup', 'Explorer', 'Analyst', 'Architect', 'Developer', 'Reviewer'];
    for (let i = 0; i < expectedOrder.length; i++) {
      expect(plan.steps[i + 1].role).toBe(expectedOrder[i]);
    }

    // Verify the SKIP entry occupies its natural middle position with status: skipped.
    const analyst = plan.steps[3];
    expect(analyst.role).toBe('Analyst');
    expect(analyst.status).toBe('skipped');
  });

  test('does not omit a single skipped role', async () => {
    const taskId = 't-order-2';
    const dir = join(projectDir, '.forjis', 'tasks', taskId);
    await mkdir(dir, { recursive: true });
    const { stringify } = await import('yaml');
    await writeFile(join(dir, 'pipeline-state.yaml'), stringify({
      org: 'my-org',
      team: 'default',
      status: 'running',
      roles: [
        { name: 'Explorer', agent: 'forjis-explorer', status: 'skipped', description: 'Explore' },
        { name: 'Analyst', agent: 'forjis-analyst', status: 'skipped', description: 'Analyze' },
        { name: 'Architect', agent: 'forjis-architect', status: 'skipped', description: 'Design' },
        { name: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Build' },
      ],
    }), 'utf-8');

    await syncPlanFromState(projectDir, taskId);

    const plan = await readYamlFile<PipelinePlanResponse>(
      join(dir, 'pipeline-plan.yaml'),
    );
    if (!plan) throw new Error('Plan was not written');

    expect(plan.steps).toHaveLength(5);
    const roleNames = plan.steps.slice(1).map((s) => s.role);
    expect(roleNames).toEqual(['Explorer', 'Analyst', 'Architect', 'Developer']);
  });
});
