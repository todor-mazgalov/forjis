/**
 * Unit tests for plan-writer.ts — cross-team role support in pipeline-state.
 *
 * Regression coverage: when the orchestrator pulls a role from a team other
 * than the pipeline's primary team (Step 3c in org-mode), the per-role
 * `team` override in pipeline-state.yaml must round-trip through
 * syncPlanFromState into pipeline-plan.yaml, so parsePipelinePlan can
 * locate the role in the resolved config.
 *
 * Before the fix, the plan writer flattened every role under the top-level
 * team, causing PlanRoleNotFoundError for the cross-team role.
 */

import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

import {
  parsePipelinePlan,
  syncPlanFromState,
} from '../web-services/plan-writer.js';
import type { PipelinePlanResponse } from '@forjis/shared';
import type { RuntimeConfig } from '@forjis/resolver';

async function createProjectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-cross-team-test-'));
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function writePipelineState(
  projectDir: string,
  taskId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const stateDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'pipeline-state.yaml'),
    stringifyYaml(state),
    'utf-8',
  );
}

async function readPipelinePlan(
  projectDir: string,
  taskId: string,
): Promise<PipelinePlanResponse> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const raw = await readFile(planPath, 'utf-8');
  return parseYaml(raw) as PipelinePlanResponse;
}

/** Config with two teams: Backend (primary) and Research (source of cross-team Explorer). */
function makeCrossTeamConfig(): RuntimeConfig {
  return {
    orgs: [
      {
        name: 'forjis',
        teams: [
          {
            name: 'Research',
            roles: [
              {
                name: 'Explorer',
                plugin: 'software-dev',
                org: 'forjis',
                team: 'Research',
                agent: 'forjis-explorer',
                skills: [],
                hooks: { pre: [], validation: [], post: [] },
              },
            ],
          },
          {
            name: 'Backend',
            roles: [
              {
                name: 'APIDev',
                plugin: 'software-dev',
                org: 'forjis',
                team: 'Backend',
                agent: 'forjis-api-developer',
                skills: [],
                hooks: { pre: [], validation: [], post: [] },
              },
            ],
          },
        ],
      },
    ],
    metrics: new Map(),
    outcomeRules: [],
    outcomeEnabled: true,
    defaultAction: 'halt',
    defaultMaxRetries: 1,
    pipeline: null,
    allowedTools: [],
    tokenBudget: null,
    resolvedConstraints: { mandatory: '', optional: '', pillars: [] },
    healthCheck: { interval: 60, maxRetries: 3 },
  };
}

describe('syncPlanFromState — cross-team role support', () => {
  let projectDir: string;
  const taskId = 'cross-team-task';

  beforeEach(async () => {
    projectDir = await createProjectDir();
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it('copies per-role `team` override to the plan step (Research-owned role under Backend pipeline)', async () => {
    await writePipelineState(projectDir, taskId, {
      org: 'forjis',
      team: 'Backend',
      status: 'running',
      roles: [
        {
          name: 'Explorer',
          team: 'Research',
          agent: 'forjis-explorer',
          status: 'planned',
          description: 'Cross-team explorer',
          weight: 75,
        },
        {
          name: 'APIDev',
          agent: 'forjis-api-developer',
          status: 'planned',
          description: 'API developer',
          weight: 95,
        },
      ],
    });

    const synced = await syncPlanFromState(projectDir, taskId);
    expect(synced).toBe(true);

    const plan = await readPipelinePlan(projectDir, taskId);
    const roleSteps = plan.steps.filter((s) => s.kind !== 'orchestrator');

    expect(roleSteps).toHaveLength(2);
    expect(roleSteps[0].role).toBe('Explorer');
    expect(roleSteps[0].team).toBe('Research');
    expect(roleSteps[0].org).toBe('forjis');
    expect(roleSteps[1].role).toBe('APIDev');
    expect(roleSteps[1].team).toBe('Backend');
    expect(roleSteps[1].org).toBe('forjis');
  });

  it('round-trips a cross-team plan through parsePipelinePlan without PlanRoleNotFoundError', async () => {
    await writePipelineState(projectDir, taskId, {
      org: 'forjis',
      team: 'Backend',
      status: 'running',
      roles: [
        {
          name: 'Explorer',
          team: 'Research',
          agent: 'forjis-explorer',
          status: 'planned',
          description: 'Cross-team explorer',
          weight: 75,
        },
        {
          name: 'APIDev',
          agent: 'forjis-api-developer',
          status: 'planned',
          description: 'API developer',
          weight: 95,
        },
      ],
    });

    await syncPlanFromState(projectDir, taskId);

    const resolved = await parsePipelinePlan(projectDir, taskId, makeCrossTeamConfig());
    expect(resolved).not.toBeNull();
    expect(resolved).toHaveLength(2);
    expect(resolved![0].runtimeRole.team).toBe('Research');
    expect(resolved![0].runtimeRole.name).toBe('Explorer');
    expect(resolved![0].runtimeRole.plugin).toBe('software-dev');
    expect(resolved![1].runtimeRole.team).toBe('Backend');
    expect(resolved![1].runtimeRole.name).toBe('APIDev');
    expect(resolved![1].runtimeRole.plugin).toBe('software-dev');
  });

  it('carries the plugin field from pipeline-state into the plan step when present', async () => {
    await writePipelineState(projectDir, taskId, {
      org: 'forjis',
      team: 'Backend',
      status: 'running',
      roles: [
        {
          name: 'Architect',
          plugin: 'software-dev',
          agent: 'forjis-backend-architect',
          status: 'planned',
          description: 'Backend architect',
          weight: 80,
        },
        {
          name: 'ProjectLocalRole',
          agent: 'forjis-custom',
          status: 'planned',
          description: 'No plugin origin',
          weight: 50,
        },
      ],
    });

    await syncPlanFromState(projectDir, taskId);
    const plan = await readPipelinePlan(projectDir, taskId);

    const architect = plan.steps.find((s) => s.role === 'Architect')!;
    expect(architect.plugin).toBe('software-dev');

    const custom = plan.steps.find((s) => s.role === 'ProjectLocalRole')!;
    expect(custom.plugin).toBeUndefined();
  });

  it('falls back to state.team when a role omits the per-role override (same-team case unaffected)', async () => {
    await writePipelineState(projectDir, taskId, {
      org: 'forjis',
      team: 'Backend',
      status: 'running',
      roles: [
        {
          name: 'APIDev',
          agent: 'forjis-api-developer',
          status: 'planned',
          description: 'API developer',
          weight: 95,
        },
      ],
    });

    await syncPlanFromState(projectDir, taskId);
    const plan = await readPipelinePlan(projectDir, taskId);
    const apiDev = plan.steps.find((s) => s.role === 'APIDev')!;
    expect(apiDev.team).toBe('Backend');
    expect(apiDev.org).toBe('forjis');
  });
});
