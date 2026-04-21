/**
 * Unit tests for the web-view bug fixes.
 *
 * Tests the reliable pipeline state mechanism:
 *   - writePipelinePlan: creates evaluating plan with no steps
 *   - syncPlanFromState: reads orchestrator's pipeline-state.yaml and syncs
 *   - describeRole: role id → human-readable stage description
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import {
  writePipelinePlan,
  syncPlanFromState,
  describeRole,
} from '@forjis/facilitator';

// ===========================================================================
// Helpers
// ===========================================================================

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-webview-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function setupQueueDir(projectDir: string, taskId: string): Promise<void> {
  await mkdir(join(projectDir, '.forjis', 'tasks', taskId), { recursive: true });
}

async function writePipelineState(
  projectDir: string,
  taskId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pipeline-state.yaml'), stringifyYaml(state), 'utf-8');
}

// ===========================================================================
// writePipelinePlan — initial evaluating state
// ===========================================================================

describe('writePipelinePlan', () => {
  let projectDir: string;

  beforeEach(async () => { projectDir = await createTempDir(); });
  afterEach(async () => { await removeTempDir(projectDir); });

  test('creates plan with evaluating status and empty steps', async () => {
    await setupQueueDir(projectDir, 'task-1');
    await writePipelinePlan(projectDir, 'task-1');

    const raw = await readFile(
      join(projectDir, '.forjis', 'tasks', 'task-1', 'pipeline-plan.yaml'),
      'utf-8',
    );
    expect(raw).toContain('status: evaluating');
    expect(raw).toContain('steps: []');
    expect(raw).toContain('taskId: task-1');
  });
});

// ===========================================================================
// syncPlanFromState — reads orchestrator's pipeline-state.yaml
// ===========================================================================

describe('syncPlanFromState', () => {
  let projectDir: string;

  beforeEach(async () => { projectDir = await createTempDir(); });
  afterEach(async () => { await removeTempDir(projectDir); });

  test('returns false when pipeline-state.yaml does not exist', async () => {
    await setupQueueDir(projectDir, 'task-1');
    const synced = await syncPlanFromState(projectDir, 'task-1');
    expect(synced).toBe(false);
  });

  test('syncs roles from pipeline-state.yaml to pipeline-plan.yaml', async () => {
    await setupQueueDir(projectDir, 'task-2');
    await writePipelineState(projectDir, 'task-2', {
      org: 'standard',
      team: 'core',
      status: 'running',
      roles: [
        { name: 'Explorer', agent: 'forjis-explorer', status: 'done', description: 'Codebase exploration' },
        { name: 'Analyst', agent: 'forjis-analyst', status: 'skipped', description: 'Requirements analysis' },
        { name: 'Developer', agent: 'forjis-fullstack-developer', status: 'running', description: 'Implementation' },
        { name: 'Reviewer', agent: 'forjis-fullstack-reviewer', status: 'planned', description: 'Code review' },
      ],
    });

    const synced = await syncPlanFromState(projectDir, 'task-2');
    expect(synced).toBe(true);

    const raw = await readFile(
      join(projectDir, '.forjis', 'tasks', 'task-2', 'pipeline-plan.yaml'),
      'utf-8',
    );
    expect(raw).toContain('status: ready');
    expect(raw).toContain('orgName: standard');
    expect(raw).toContain('teamName: core');
    expect(raw).toContain('Explorer');
    expect(raw).toContain('Analyst');
  });

  test('preserves role statuses from orchestrator state', async () => {
    await setupQueueDir(projectDir, 'task-3');
    await writePipelineState(projectDir, 'task-3', {
      org: 'test',
      team: 'dev',
      status: 'running',
      roles: [
        { name: 'Explorer', agent: 'forjis-explorer', status: 'done', description: 'Explore' },
        { name: 'Developer', agent: 'forjis-developer', status: 'running', description: 'Develop' },
        { name: 'Reviewer', agent: 'forjis-reviewer', status: 'planned', description: 'Review' },
      ],
    });

    await syncPlanFromState(projectDir, 'task-3');

    const raw = await readFile(
      join(projectDir, '.forjis', 'tasks', 'task-3', 'pipeline-plan.yaml'),
      'utf-8',
    );
    // Check each status is preserved
    expect(raw).toMatch(/Explorer[\s\S]*?status: done/);
    expect(raw).toMatch(/Developer[\s\S]*?status: running/);
    expect(raw).toMatch(/Reviewer[\s\S]*?status: planned/);
  });

  test('transition: evaluating → ready when state appears', async () => {
    await setupQueueDir(projectDir, 'task-4');

    // Start with evaluating
    await writePipelinePlan(projectDir, 'task-4');
    let raw = await readFile(
      join(projectDir, '.forjis', 'tasks', 'task-4', 'pipeline-plan.yaml'),
      'utf-8',
    );
    expect(raw).toContain('status: evaluating');
    expect(raw).toContain('steps: []');

    // Orchestrator writes state
    await writePipelineState(projectDir, 'task-4', {
      org: 'myorg',
      team: 'myteam',
      status: 'running',
      roles: [
        { name: 'Developer', agent: 'forjis-developer', status: 'running', description: 'Dev' },
      ],
    });

    await syncPlanFromState(projectDir, 'task-4');
    raw = await readFile(
      join(projectDir, '.forjis', 'tasks', 'task-4', 'pipeline-plan.yaml'),
      'utf-8',
    );
    expect(raw).toContain('status: ready');
    expect(raw).toContain('Developer');
    expect(raw).not.toContain('steps: []');
  });

  test('includes skipped roles in the plan', async () => {
    await setupQueueDir(projectDir, 'task-5');
    await writePipelineState(projectDir, 'task-5', {
      org: 'org',
      team: 'team',
      status: 'running',
      roles: [
        { name: 'Explorer', agent: 'forjis-explorer', status: 'done', description: 'Explore' },
        { name: 'Analyst', agent: 'forjis-analyst', status: 'skipped', description: 'Analysis' },
        { name: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Dev' },
      ],
    });

    await syncPlanFromState(projectDir, 'task-5');

    const raw = await readFile(
      join(projectDir, '.forjis', 'tasks', 'task-5', 'pipeline-plan.yaml'),
      'utf-8',
    );
    // Skipped roles ARE included (shown with skipped status)
    expect(raw).toContain('Analyst');
    expect(raw).toMatch(/Analyst[\s\S]*?status: skipped/);
  });
});

// ===========================================================================
// describeRole
// ===========================================================================

describe('describeRole', () => {
  test.each([
    ['Explorer', 'Codebase exploration'],
    ['Analyst', 'Requirements analysis'],
    ['Architect', 'Solution design'],
    ['Developer', 'Implementation'],
    ['Reviewer', 'Code review'],
    ['setup', 'Project setup'],
    ['finish', 'Task completion'],
    ['CustomRole', 'Pipeline stage'],
  ])('%s contains expected text', (role, expectedSubstring) => {
    expect(describeRole(role)).toContain(expectedSubstring);
  });
});

