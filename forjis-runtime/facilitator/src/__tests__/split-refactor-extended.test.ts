/**
 * Extended tests for the split refactoring (task: split).
 *
 * Covers business logic after facilitator thinning:
 *   - FR-007: run.ts has no assessment orchestration functions
 *   - FR-008: CLI transitions task solely from engine exit code
 *   - FR-011: writeAssessmentStep removed from plan-writer.ts
 *   - FR-015: type fields are correctly typed
 *
 * Note: Tests for engine.prepare(), outcome-config.yaml writing, and
 * orgs.forjis.yaml generation have been migrated to @forjis/resolver.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// -- FR-007: run.ts contains no assessment orchestration functions --

describe('FR-007: run.ts contains no assessment orchestration functions', () => {
  let runSource: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    runSource = await readFile(join(srcDir, 'commands', 'run.ts'), 'utf-8');
  });

  it('does not define a runAssessment function', () => {
    expect(runSource).not.toContain('function runAssessment');
    expect(runSource).not.toMatch(/runAssessment\s*\(/);
  });

  it('does not define an emitAssessmentEvent function', () => {
    expect(runSource).not.toContain('function emitAssessmentEvent');
    expect(runSource).not.toMatch(/emitAssessmentEvent\s*\(/);
  });

  it('does not call writeAssessmentStep', () => {
    expect(runSource).not.toContain('writeAssessmentStep');
  });

  it('does not import evaluateRules or resolveFailureAction from outcome-assessor', () => {
    expect(runSource).not.toContain('evaluateRules');
    expect(runSource).not.toContain('resolveFailureAction');
  });
});

// -- FR-008: Task status determined solely from engine exit code --

describe('FR-008: run.ts transitions tasks based only on engine exit code', () => {
  let runSource: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    runSource = await readFile(join(srcDir, 'commands', 'run.ts'), 'utf-8');
  });

  it('transitions to done on successful engine invoke without any assessment check', () => {
    expect(runSource).toContain("queue.transition(task.id, 'done')");
    expect(runSource).not.toContain("verdict");
    expect(runSource).not.toContain("assessTask");
  });

  it('transitions to failed via catch block on engine error', () => {
    expect(runSource).toContain("queue.transition(task.id, 'failed')");
  });
});

// -- FR-011: writeAssessmentStep does not exist in plan-writer.ts --

describe('FR-011: writeAssessmentStep removed from plan-writer.ts', () => {
  let planWriterSource: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    planWriterSource = await readFile(join(srcDir, 'web-services', 'plan-writer.ts'), 'utf-8');
  });

  it('plan-writer.ts does not export writeAssessmentStep', () => {
    expect(planWriterSource).not.toContain('export function writeAssessmentStep');
    expect(planWriterSource).not.toContain('export async function writeAssessmentStep');
  });

  it('plan-writer.ts does not define writeAssessmentStep internally', () => {
    expect(planWriterSource).not.toContain('function writeAssessmentStep');
  });
});

// -- Facilitator thinning: run.ts uses resolver instead of local modules --

describe('Facilitator thinning: run.ts delegates to resolver', () => {
  let runSource: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    runSource = await readFile(join(srcDir, 'commands', 'run.ts'), 'utf-8');
  });

  it('run.ts imports resolve from @forjis/resolver', () => {
    expect(runSource).toContain("from '@forjis/resolver'");
  });

  it('run.ts does not import from local build-file module', () => {
    expect(runSource).not.toContain("from '../build-file.js'");
  });

  it('run.ts does not import from local plugin-compositor module', () => {
    expect(runSource).not.toContain("from '../plugin-compositor.js'");
  });

  it('run.ts does not import from local repo module', () => {
    expect(runSource).not.toContain("from '../repo/index.js'");
  });

  it('run.ts does not call engine.prepare()', () => {
    expect(runSource).not.toContain('engine.prepare(');
  });
});

// -- Facilitator thinning: assess.ts delegates to orchestrator --

describe('Facilitator thinning: assess.ts delegates to orchestrator', () => {
  let assessSource: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    assessSource = await readFile(join(srcDir, 'commands', 'assess.ts'), 'utf-8');
  });

  it('assess.ts imports resolve from @forjis/resolver', () => {
    expect(assessSource).toContain("from '@forjis/resolver'");
  });

  it('assess.ts does not call engine.prepare()', () => {
    expect(assessSource).not.toContain('engine.prepare(');
  });

  it('assess.ts passes mode assess to engine.invoke()', () => {
    expect(assessSource).toContain("mode: 'assess'");
  });
});
