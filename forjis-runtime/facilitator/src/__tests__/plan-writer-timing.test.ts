/**
 * Unit tests for plan-writer.ts — role timing tracking during state sync.
 *
 * Validates that syncPlanFromState() correctly detects status transitions
 * and records startedAt / completedAt timestamps on PipelineStep entries.
 *
 * Requirements covered:
 *   FR-004 — Role time display (timing fields on PipelineStep)
 *   TF-002 — Plan writer tracks role timing during state sync
 *
 * Test strategy: Since computeStepTimings is an unexported internal function,
 * its behavior is exercised through syncPlanFromState() using temporary
 * directories that hold real YAML files. All I/O is confined to OS temp dirs
 * and cleaned up after each test.
 */

import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

import { syncPlanFromState } from '../web-services/plan-writer.js';
import type { PipelinePlanResponse } from '@forjis/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createProjectDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'forjis-plan-writer-test-'));
  return base;
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Write a pipeline-state.yaml with the given roles. */
async function writePipelineState(
  projectDir: string,
  taskId: string,
  roles: Array<{
    name: string;
    agent: string;
    status: 'planned' | 'running' | 'done' | 'skipped' | 'failed';
    description?: string;
    weight?: number;
    justification?: string;
  }>,
): Promise<void> {
  const stateDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(stateDir, { recursive: true });
  const state = {
    org: 'test-org',
    team: 'test-team',
    status: 'running',
    roles: roles.map((r) => ({ description: 'Test role', ...r })),
  };
  const yaml = stringifyYaml(state);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(stateDir, 'pipeline-state.yaml'), yaml, 'utf-8');
}

/** Ensure the queue directory exists for plan writes. */
async function ensureQueueDir(projectDir: string, taskId: string): Promise<void> {
  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
}

/** Read the written pipeline-plan.yaml as a parsed object. */
async function readPipelinePlan(projectDir: string, taskId: string): Promise<PipelinePlanResponse> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const raw = await readFile(planPath, 'utf-8');
  return parseYaml(raw) as PipelinePlanResponse;
}

// ---------------------------------------------------------------------------
// TF-002-1: First sync — role in `planned` status
// ---------------------------------------------------------------------------

describe('syncPlanFromState — first sync with planned role', () => {
  let projectDir: string;
  const taskId = 'task-001';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-1: planned role has no startedAt or completedAt */
    'planned role does not get startedAt or completedAt on first sync',
    async () => {
      await writePipelineState(projectDir, taskId, [
        { name: 'developer', agent: 'claude', status: 'planned' },
      ]);

      const synced = await syncPlanFromState(projectDir, taskId);
      expect(synced).toBe(true);

      const plan = await readPipelinePlan(projectDir, taskId);
      const step = plan.steps.find((s) => s.role === 'developer');
      expect(step).toBeDefined();
      expect(step!.startedAt).toBeUndefined();
      expect(step!.completedAt).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// TF-002-2: First sync — role in `running` status
// ---------------------------------------------------------------------------

describe('syncPlanFromState — first sync with running role', () => {
  let projectDir: string;
  const taskId = 'task-002';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-2: running role gets startedAt but not completedAt on first sync */
    'running role gets startedAt on first sync with no prior plan',
    async () => {
      await writePipelineState(projectDir, taskId, [
        { name: 'analyst', agent: 'claude', status: 'running' },
      ]);

      const before = new Date().toISOString();
      const synced = await syncPlanFromState(projectDir, taskId);
      const after = new Date().toISOString();

      expect(synced).toBe(true);
      const plan = await readPipelinePlan(projectDir, taskId);
      const step = plan.steps.find((s) => s.role === 'analyst');
      expect(step).toBeDefined();
      expect(step!.startedAt).toBeDefined();
      expect(step!.completedAt).toBeUndefined();

      // startedAt should be between before and after
      expect(step!.startedAt! >= before).toBe(true);
      expect(step!.startedAt! <= after).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// TF-002-3: First sync — role in `done` status
// ---------------------------------------------------------------------------

describe('syncPlanFromState — first sync with done role', () => {
  let projectDir: string;
  const taskId = 'task-003';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-3: done role gets both startedAt and completedAt on first sync */
    'done role gets both startedAt and completedAt on first sync with no prior plan',
    async () => {
      await writePipelineState(projectDir, taskId, [
        { name: 'reviewer', agent: 'claude', status: 'done' },
      ]);

      const before = new Date().toISOString();
      await syncPlanFromState(projectDir, taskId);
      const after = new Date().toISOString();

      const plan = await readPipelinePlan(projectDir, taskId);
      const step = plan.steps.find((s) => s.role === 'reviewer');
      expect(step!.startedAt).toBeDefined();
      expect(step!.completedAt).toBeDefined();
      expect(step!.startedAt! >= before).toBe(true);
      expect(step!.completedAt! <= after).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// TF-002-4: Transition planned → running sets startedAt
// ---------------------------------------------------------------------------

describe('syncPlanFromState — planned to running transition', () => {
  let projectDir: string;
  const taskId = 'task-004';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-4: transitioning from planned to running sets startedAt */
    'sets startedAt when role transitions from planned to running',
    async () => {
      // First sync: planned
      await writePipelineState(projectDir, taskId, [
        { name: 'architect', agent: 'claude', status: 'planned' },
      ]);
      await syncPlanFromState(projectDir, taskId);

      const planAfterPlanned = await readPipelinePlan(projectDir, taskId);
      const stepPlanned = planAfterPlanned.steps.find((s) => s.role === 'architect');
      expect(stepPlanned!.startedAt).toBeUndefined();

      // Second sync: running
      await writePipelineState(projectDir, taskId, [
        { name: 'architect', agent: 'claude', status: 'running' },
      ]);
      const before = new Date().toISOString();
      await syncPlanFromState(projectDir, taskId);
      const after = new Date().toISOString();

      const planAfterRunning = await readPipelinePlan(projectDir, taskId);
      const stepRunning = planAfterRunning.steps.find((s) => s.role === 'architect');
      expect(stepRunning!.startedAt).toBeDefined();
      expect(stepRunning!.startedAt! >= before).toBe(true);
      expect(stepRunning!.startedAt! <= after).toBe(true);
      expect(stepRunning!.completedAt).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// TF-002-5: Transition running → done sets completedAt and preserves startedAt
// ---------------------------------------------------------------------------

describe('syncPlanFromState — running to done transition', () => {
  let projectDir: string;
  const taskId = 'task-005';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-5: transitioning from running to done sets completedAt and preserves startedAt */
    'sets completedAt when role transitions from running to done and preserves startedAt',
    async () => {
      // First sync: running
      await writePipelineState(projectDir, taskId, [
        { name: 'developer', agent: 'claude', status: 'running' },
      ]);
      await syncPlanFromState(projectDir, taskId);

      const planAfterRunning = await readPipelinePlan(projectDir, taskId);
      const stepRunning = planAfterRunning.steps.find((s) => s.role === 'developer');
      const recordedStartedAt = stepRunning!.startedAt;
      expect(recordedStartedAt).toBeDefined();

      // Small delay to ensure completedAt > startedAt in timestamps
      await new Promise((r) => setTimeout(r, 5));

      // Second sync: done
      await writePipelineState(projectDir, taskId, [
        { name: 'developer', agent: 'claude', status: 'done' },
      ]);
      await syncPlanFromState(projectDir, taskId);

      const planAfterDone = await readPipelinePlan(projectDir, taskId);
      const stepDone = planAfterDone.steps.find((s) => s.role === 'developer');
      expect(stepDone!.startedAt).toBe(recordedStartedAt);
      expect(stepDone!.completedAt).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// TF-002-6: Timestamp preservation — running another sync preserves timestamps
// ---------------------------------------------------------------------------

describe('syncPlanFromState — timestamp preservation', () => {
  let projectDir: string;
  const taskId = 'task-006';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-6: once timestamps are set, subsequent syncs do not overwrite them */
    'preserves startedAt and completedAt across multiple syncs',
    async () => {
      // First sync: running (sets startedAt)
      await writePipelineState(projectDir, taskId, [
        { name: 'setup', agent: 'claude', status: 'running' },
      ]);
      await syncPlanFromState(projectDir, taskId);

      // Second sync: done (sets completedAt)
      await writePipelineState(projectDir, taskId, [
        { name: 'setup', agent: 'claude', status: 'done' },
      ]);
      await syncPlanFromState(projectDir, taskId);

      const planAfterDone = await readPipelinePlan(projectDir, taskId);
      const stepDone = planAfterDone.steps.find((s) => s.role === 'setup');
      const savedStartedAt = stepDone!.startedAt;
      const savedCompletedAt = stepDone!.completedAt;
      expect(savedStartedAt).toBeDefined();
      expect(savedCompletedAt).toBeDefined();

      // Third sync: still done (should not overwrite timestamps)
      await writePipelineState(projectDir, taskId, [
        { name: 'setup', agent: 'claude', status: 'done' },
      ]);
      await syncPlanFromState(projectDir, taskId);

      const planAfterThirdSync = await readPipelinePlan(projectDir, taskId);
      const stepThird = planAfterThirdSync.steps.find((s) => s.role === 'setup');
      expect(stepThird!.startedAt).toBe(savedStartedAt);
      expect(stepThird!.completedAt).toBe(savedCompletedAt);
    },
  );
});

// ---------------------------------------------------------------------------
// TF-002-7: failed status maps to done and still gets timing fields
// ---------------------------------------------------------------------------

describe('syncPlanFromState — failed status mapping', () => {
  let projectDir: string;
  const taskId = 'task-007';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** TF-002-7: failed status maps to done in the plan and still receives timing fields */
    'failed role status maps to done in plan and receives startedAt and completedAt',
    async () => {
      await writePipelineState(projectDir, taskId, [
        { name: 'assessor', agent: 'claude', status: 'failed' },
      ]);

      await syncPlanFromState(projectDir, taskId);

      const plan = await readPipelinePlan(projectDir, taskId);
      const step = plan.steps.find((s) => s.role === 'assessor');
      expect(step).toBeDefined();
      // failed → done normalization
      expect(step!.status).toBe('done');
      // timing fields are still set (approximate, both now)
      expect(step!.startedAt).toBeDefined();
      expect(step!.completedAt).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Additional: syncPlanFromState returns false when no state file exists
// ---------------------------------------------------------------------------

describe('syncPlanFromState — no state file', () => {
  let projectDir: string;
  const taskId = 'task-no-state';

  beforeEach(async () => {
    projectDir = await createProjectDir();
    await ensureQueueDir(projectDir, taskId);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it(
    /** Returns false when pipeline-state.yaml does not exist */
    'returns false when pipeline-state.yaml does not exist',
    async () => {
      const result = await syncPlanFromState(projectDir, taskId);
      expect(result).toBe(false);
    },
  );
});
