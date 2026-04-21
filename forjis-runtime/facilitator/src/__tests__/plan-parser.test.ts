/**
 * Unit tests for plan-writer.ts — `parsePipelinePlan` strict plan parser.
 *
 * Covers the three acceptance cases from the fix-roles-display TASK:
 *  1. A valid `{org, team, role}` triple resolves to the matching
 *     `RuntimeRole`.
 *  2. An unknown triple throws `PlanRoleNotFoundError`.
 *  3. A reserved character in any step field throws `RoleIdentityError`.
 *
 * The parser reads `pipeline-plan.yaml` from a per-test temp directory so
 * the file-format contract is exercised end-to-end without mocking the YAML
 * layer.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { RoleIdentityError } from '@forjis/shared';
import type { PipelineStep } from '@forjis/shared';
import type { RuntimeConfig } from '@forjis/resolver';

import {
  PlanRoleNotFoundError,
  parsePipelinePlan,
} from '../web-services/plan-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a per-test project directory. */
async function createProjectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-plan-parser-test-'));
}

/** Removes a test project directory. */
async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Builds a minimal RuntimeConfig with a single org/team/role. */
function makeConfig(): RuntimeConfig {
  return {
    orgs: [
      {
        name: 'acme',
        teams: [
          {
            name: 'dev',
            roles: [
              {
                name: 'architect',
                org: 'acme',
                team: 'dev',
                agent: 'dev-agent',
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

/** Writes a pipeline-plan.yaml with the given steps. */
async function writePlan(
  projectDir: string,
  taskId: string,
  steps: PipelineStep[],
): Promise<void> {
  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  const plan = {
    taskId,
    orgName: null,
    teamName: null,
    steps,
    status: 'ready',
  };
  await writeFile(join(taskDir, 'pipeline-plan.yaml'), stringifyYaml(plan), 'utf-8');
}

/** Builds a PipelineStep literal for tests. */
function step(overrides: Partial<PipelineStep>): PipelineStep {
  return {
    org: 'acme',
    team: 'dev',
    role: 'architect',
    agent: 'dev-agent',
    status: 'planned',
    description: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Success path — valid triple resolves
// ---------------------------------------------------------------------------

describe('parsePipelinePlan — valid plans', () => {
  let projectDir: string;
  const taskId = 'valid-plan';

  beforeEach(async () => {
    projectDir = await createProjectDir();
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it('resolves a valid triple to the matching RuntimeRole', async () => {
    await writePlan(projectDir, taskId, [step({})]);
    const config = makeConfig();

    const result = await parsePipelinePlan(projectDir, taskId, config);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].runtimeRole.name).toBe('architect');
    expect(result![0].runtimeRole.org).toBe('acme');
    expect(result![0].runtimeRole.team).toBe('dev');
  });

  it('skips the synthetic orchestrator step', async () => {
    await writePlan(projectDir, taskId, [
      {
        org: '',
        team: '',
        role: 'orchestrator',
        agent: '',
        status: 'done',
        description: 'Pipeline orchestrator',
        kind: 'orchestrator',
      },
      step({}),
    ]);

    const result = await parsePipelinePlan(projectDir, taskId, makeConfig());
    expect(result).toHaveLength(1);
    expect(result![0].step.role).toBe('architect');
  });

  it('returns null when no plan file exists', async () => {
    const result = await parsePipelinePlan(projectDir, 'missing-task', makeConfig());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PlanRoleNotFoundError — unknown triple
// ---------------------------------------------------------------------------

describe('parsePipelinePlan — unknown triple', () => {
  let projectDir: string;
  const taskId = 'unknown-triple';

  beforeEach(async () => {
    projectDir = await createProjectDir();
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it('throws PlanRoleNotFoundError when the team does not exist', async () => {
    await writePlan(projectDir, taskId, [step({ team: 'ghost-team' })]);
    await expect(
      parsePipelinePlan(projectDir, taskId, makeConfig()),
    ).rejects.toBeInstanceOf(PlanRoleNotFoundError);
  });

  it('throws PlanRoleNotFoundError when the role does not exist', async () => {
    await writePlan(projectDir, taskId, [step({ role: 'ghost-role' })]);
    await expect(
      parsePipelinePlan(projectDir, taskId, makeConfig()),
    ).rejects.toBeInstanceOf(PlanRoleNotFoundError);
  });

  it('carries the offending step index and identity on the error', async () => {
    await writePlan(projectDir, taskId, [step({}), step({ role: 'ghost-role' })]);
    try {
      await parsePipelinePlan(projectDir, taskId, makeConfig());
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRoleNotFoundError);
      const e = err as PlanRoleNotFoundError;
      expect(e.stepIndex).toBe(1);
      expect(e.identity.role).toBe('ghost-role');
    }
  });
});

// ---------------------------------------------------------------------------
// RoleIdentityError — reserved character in a field
// ---------------------------------------------------------------------------

describe('parsePipelinePlan — reserved-character rejection', () => {
  let projectDir: string;
  const taskId = 'reserved-char';

  beforeEach(async () => {
    projectDir = await createProjectDir();
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it('throws RoleIdentityError when the role field contains ":"', async () => {
    await writePlan(projectDir, taskId, [step({ role: 'plugin:architect' })]);
    await expect(
      parsePipelinePlan(projectDir, taskId, makeConfig()),
    ).rejects.toBeInstanceOf(RoleIdentityError);
  });

  it('throws RoleIdentityError when the role field contains "@"', async () => {
    await writePlan(projectDir, taskId, [step({ role: 'architect@dev' })]);
    await expect(
      parsePipelinePlan(projectDir, taskId, makeConfig()),
    ).rejects.toBeInstanceOf(RoleIdentityError);
  });

  it('throws RoleIdentityError when any field is empty', async () => {
    await writePlan(projectDir, taskId, [step({ team: '' })]);
    await expect(
      parsePipelinePlan(projectDir, taskId, makeConfig()),
    ).rejects.toBeInstanceOf(RoleIdentityError);
  });
});
