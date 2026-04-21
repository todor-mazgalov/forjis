/**
 * Integration tests for the split refactoring (task: split).
 *
 * Validates the separation of concerns between CLI, orchestrator, and plugins:
 *   - outcome-assessor.ts exports only utility functions (FR-015)
 *   - evaluateRules produces correct verdicts (FR-015)
 *   - resolveFailureAction returns correct actions (FR-015)
 *   - describeRole handles assessor stage (FR-012)
 *   - Plugin YAML parses with assessor role in correct position (FR-001)
 *   - Plugin YAML parses with roles field on metrics (FR-014)
 *   - No CLI command module imports assessTask or buildScoringPrompt (NFR-003)
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateRules, resolveFailureAction } from '../outcome-assessor.js';
import { describeRole } from '../web-services/plan-writer.js';
import { parsePlugin } from '@forjis/resolver';
import type { OutcomeRule } from '../types.js';

const emptyMetrics = new Map();

// ---------------------------------------------------------------------------
// FR-015: outcome-assessor.ts exports only evaluateRules and resolveFailureAction
// ---------------------------------------------------------------------------

describe('FR-015: outcome-assessor module exports', () => {
  it('does not export assessTask', async () => {
    const mod = await import('../outcome-assessor.js');
    expect((mod as Record<string, unknown>)['assessTask']).toBeUndefined();
  });

  it('does not export buildScoringPrompt', async () => {
    const mod = await import('../outcome-assessor.js');
    expect((mod as Record<string, unknown>)['buildScoringPrompt']).toBeUndefined();
  });

  it('exports evaluateRules as a function', async () => {
    const mod = await import('../outcome-assessor.js');
    expect(typeof mod.evaluateRules).toBe('function');
  });

  it('exports resolveFailureAction as a function', async () => {
    const mod = await import('../outcome-assessor.js');
    expect(typeof mod.resolveFailureAction).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// FR-015: evaluateRules produces correct verdicts
// ---------------------------------------------------------------------------

describe('evaluateRules — verdict scenarios', () => {
  it('returns PASS when all scores satisfy rules', () => {
    const scores = { completeness: 95, speculation: 5 };
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'completeness < 70' },
      { type: 'warning', expression: 'speculation > 30' },
    ];
    const result = evaluateRules(scores, rules, emptyMetrics);
    expect(result.verdict).toBe('PASS');
  });

  it('returns FAIL when a fail rule triggers', () => {
    const scores = { completeness: 50 };
    const rules: OutcomeRule[] = [{ type: 'fail', expression: 'completeness < 70' }];
    const result = evaluateRules(scores, rules, emptyMetrics);
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('returns WARNING when only a warning rule triggers', () => {
    const scores = { completeness: 80, speculation: 40 };
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'completeness < 70' },
      { type: 'warning', expression: 'speculation > 30' },
    ];
    const result = evaluateRules(scores, rules, emptyMetrics);
    expect(result.verdict).toBe('WARNING');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FR-015: resolveFailureAction
// ---------------------------------------------------------------------------

describe('resolveFailureAction — action scenarios', () => {
  it('returns halt when any rule has halt action', () => {
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50', action: 'halt' },
    ];
    const result = resolveFailureAction(rules, { defaultAction: 'retry', defaultMaxRetries: 3 });
    expect(result.action).toBe('halt');
    expect(result.maxRetries).toBe(0);
  });

  it('returns retry with minimum maxRetries when all rules are retry', () => {
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50', action: 'retry', maxRetries: 2 },
      { type: 'fail', expression: 'y < 50', action: 'retry', maxRetries: 5 },
    ];
    const result = resolveFailureAction(rules, { defaultAction: 'halt', defaultMaxRetries: 1 });
    expect(result.action).toBe('retry');
    expect(result.maxRetries).toBe(2);
  });

  it('uses defaultAction when rule has no explicit action', () => {
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50' },
    ];
    const result = resolveFailureAction(rules, { defaultAction: 'retry', defaultMaxRetries: 1 });
    expect(result.action).toBe('retry');
  });
});

// ---------------------------------------------------------------------------
// FR-012: describeRole handles assessor
// ---------------------------------------------------------------------------

describe('FR-012: describeRole handles assessor', () => {
  it('returns description for "Assessor" role name', () => {
    const desc = describeRole('Assessor');
    expect(desc).toBe('Outcome assessment and scoring');
  });

  it('returns description for "assessor-custom" role name', () => {
    const desc = describeRole('assessor-custom');
    expect(desc).toBe('Outcome assessment and scoring');
  });

  it('returns description for role containing "assessor" in any position', () => {
    const desc = describeRole('custom-assessor-role');
    expect(desc).toBe('Outcome assessment and scoring');
  });
});

// ---------------------------------------------------------------------------
// FR-001, FR-014: Plugin YAML with assessor role and metric roles
// ---------------------------------------------------------------------------

describe('FR-001: Plugin parses with assessor role', () => {
  let pluginContent: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = dirname(dirname(dirname(dirname(dirname(thisFile)))));
    const pluginPath = join(projectRoot, 'forjis-plugins', 'plugins', 'software-dev.forjis.yaml');
    pluginContent = await readFile(pluginPath, 'utf-8');
  });

  it('parses without errors', () => {
    expect(() => parsePlugin(pluginContent)).not.toThrow();
  });

  it('has Assessor role in core team after Reviewer', () => {
    const plugin = parsePlugin(pluginContent);
    const standardOrg = plugin.orgs.find(o => o.name === 'standard');
    expect(standardOrg).toBeDefined();

    const coreTeam = standardOrg!.teams.find(t => t.name === 'core');
    expect(coreTeam).toBeDefined();

    const assessor = coreTeam!.roles.find(r => r.name === 'Assessor');
    expect(assessor).toBeDefined();
    expect(assessor!.agent).toBe('forjis-assessor');
    expect(assessor!.stage).toBe('assessor');
    expect(assessor!.expertise).toBeTruthy();

    const reviewerIdx = coreTeam!.roles.findIndex(r => r.name === 'Reviewer');
    const assessorIdx = coreTeam!.roles.findIndex(r => r.name === 'Assessor');
    expect(assessorIdx).toBeGreaterThan(reviewerIdx);
  });

  it('has Assessor role in fullstack team after last reviewer', () => {
    const plugin = parsePlugin(pluginContent);
    const standardOrg = plugin.orgs.find(o => o.name === 'standard');
    const fullstackTeam = standardOrg!.teams.find(t => t.name === 'fullstack');
    expect(fullstackTeam).toBeDefined();

    const assessor = fullstackTeam!.roles.find(r => r.name === 'Assessor');
    expect(assessor).toBeDefined();
    expect(assessor!.agent).toBe('forjis-assessor');
    expect(assessor!.stage).toBe('assessor');

    const lastReviewerIdx = Math.max(
      ...fullstackTeam!.roles
        .map((r, i) => r.name.toLowerCase().includes('reviewer') ? i : -1)
        .filter(i => i >= 0)
    );
    const assessorIdx = fullstackTeam!.roles.findIndex(r => r.name === 'Assessor');
    expect(assessorIdx).toBeGreaterThan(lastReviewerIdx);
  });
});

describe('FR-014: Plugin metrics have roles field', () => {
  let pluginContent: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = dirname(dirname(dirname(dirname(dirname(thisFile)))));
    const pluginPath = join(projectRoot, 'forjis-plugins', 'plugins', 'software-dev.forjis.yaml');
    pluginContent = await readFile(pluginPath, 'utf-8');
  });

  it('security_score metric has roles array', () => {
    const plugin = parsePlugin(pluginContent);
    const metric = plugin.metrics.get('security_score');
    expect(metric).toBeDefined();
    expect(metric!.roles).toBeDefined();
    expect(Array.isArray(metric!.roles)).toBe(true);
    expect(metric!.roles!.length).toBeGreaterThan(0);
    expect(metric!.roles).toContain('Developer');
  });

  it('test_coverage metric has roles array', () => {
    const plugin = parsePlugin(pluginContent);
    const metric = plugin.metrics.get('test_coverage');
    expect(metric).toBeDefined();
    expect(metric!.roles).toBeDefined();
    expect(Array.isArray(metric!.roles)).toBe(true);
    expect(metric!.roles).toContain('Reviewer');
  });
});

// ---------------------------------------------------------------------------
// NFR-003: No assessment logic in CLI commands or bin
// ---------------------------------------------------------------------------

describe('NFR-003: No assessment imports in CLI layer', () => {
  it('run.ts does not import assessTask or buildScoringPrompt', async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    const runPath = join(srcDir, 'commands', 'run.ts');
    const source = await readFile(runPath, 'utf-8');
    expect(source).not.toContain('assessTask');
    expect(source).not.toContain('buildScoringPrompt');
    expect(source).not.toContain('AssessorConfig');
  });

  it('assess.ts does not import assessTask or buildScoringPrompt', async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(thisFile));
    const assessPath = join(srcDir, 'commands', 'assess.ts');
    const source = await readFile(assessPath, 'utf-8');
    expect(source).not.toContain('assessTask');
    expect(source).not.toContain('buildScoringPrompt');
    expect(source).not.toContain('AssessorConfig');
  });

  it('forjis.ts does not import assessTask or buildScoringPrompt', async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const runtimeRoot = dirname(dirname(dirname(dirname(thisFile))));
    const entryPath = join(runtimeRoot, 'cli', 'src', 'bin', 'forjis.ts');
    const source = await readFile(entryPath, 'utf-8');
    expect(source).not.toContain('assessTask');
    expect(source).not.toContain('buildScoringPrompt');
  });
});
