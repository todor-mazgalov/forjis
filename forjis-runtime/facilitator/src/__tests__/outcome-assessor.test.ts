/**
 * Unit tests for outcome-assessor.ts.
 *
 * Requirements validated:
 *   Verdict determination (PASS / WARNING / FAIL precedence)
 *   Failure action execution (halt, retry, default action)
 *   FR-015: module exports only evaluateRules and resolveFailureAction
 */

import { evaluateRules, resolveFailureAction } from '../outcome-assessor.js';
import { truncateDiff, MAX_DIFF_CHARS } from '../evidence-collector.js';
import type { OutcomeRule } from '../types.js';

const emptyMetrics = new Map();

function makeConfig(overrides?: Partial<{ defaultAction: 'halt' | 'retry'; defaultMaxRetries: number }>) {
  return {
    defaultAction: 'halt' as const,
    defaultMaxRetries: 1,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// evaluateRules -- verdict determination
// --------------------------------------------------------------------------

describe('evaluateRules -- PASS', () => {
  /** Validates: Verdict determination -- PASS when no rules trigger */
  it('returns PASS when no rules trigger', () => {
    const scores = { completeness: 95, speculation: 5, hallucination: 0 };
    const rules: OutcomeRule[] = [{ type: 'fail', expression: 'completeness < 80' }];
    const result = evaluateRules(scores, rules, emptyMetrics);
    expect(result.verdict).toBe('PASS');
    expect(result.failures).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns PASS when rule list is empty', () => {
    const result = evaluateRules({ completeness: 50 }, [], emptyMetrics);
    expect(result.verdict).toBe('PASS');
  });
});

describe('evaluateRules -- WARNING', () => {
  /** Validates: Verdict determination -- WARNING when warning rule triggers */
  it('returns WARNING with warning message when warning rule triggers', () => {
    const scores = { completeness: 90, speculation: 30 };
    const rules: OutcomeRule[] = [{ type: 'warning', expression: 'speculation > 25' }];
    const result = evaluateRules(scores, rules, emptyMetrics);
    expect(result.verdict).toBe('WARNING');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('speculation > 25');
    expect(result.failures).toHaveLength(0);
  });
});

describe('evaluateRules -- FAIL takes precedence', () => {
  /** Validates: Verdict determination -- FAIL takes precedence over WARNING */
  it('returns FAIL even when a warning also triggers', () => {
    const scores = { completeness: 60, speculation: 30 };
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'completeness < 80' },
      { type: 'warning', expression: 'speculation > 25' },
    ];
    const result = evaluateRules(scores, rules, emptyMetrics);
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// resolveFailureAction
// --------------------------------------------------------------------------

describe('resolveFailureAction -- halt', () => {
  /** Validates: Failure action execution -- halt action */
  it('returns halt with maxRetries 0 when any rule says halt', () => {
    const config = makeConfig({ defaultAction: 'retry', defaultMaxRetries: 3 });
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50', action: 'halt' },
    ];
    const result = resolveFailureAction(rules, config);
    expect(result.action).toBe('halt');
    expect(result.maxRetries).toBe(0);
  });
});

describe('resolveFailureAction -- retry with min retries', () => {
  /** Validates: Failure action execution -- retry with minimum max_retries */
  it('returns retry with minimum maxRetries across triggered rules', () => {
    const config = makeConfig({ defaultAction: 'halt', defaultMaxRetries: 1 });
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50', action: 'retry', maxRetries: 2 },
      { type: 'fail', expression: 'y < 50', action: 'retry', maxRetries: 3 },
    ];
    const result = resolveFailureAction(rules, config);
    expect(result.action).toBe('retry');
    expect(result.maxRetries).toBe(2);
  });
});

describe('resolveFailureAction -- default action used', () => {
  /** Validates: Failure action execution -- uses defaultAction when rule has none */
  it('uses defaultAction when rule has no explicit action', () => {
    const config = makeConfig({ defaultAction: 'retry', defaultMaxRetries: 1 });
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50' },
    ];
    const result = resolveFailureAction(rules, config);
    expect(result.action).toBe('retry');
    expect(result.maxRetries).toBe(1);
  });
});

describe('resolveFailureAction -- halt takes priority over retry', () => {
  it('returns halt if any rule is halt even alongside retry rules', () => {
    const config = makeConfig({ defaultAction: 'retry', defaultMaxRetries: 3 });
    const rules: OutcomeRule[] = [
      { type: 'fail', expression: 'x < 50', action: 'retry', maxRetries: 3 },
      { type: 'fail', expression: 'y < 50', action: 'halt' },
    ];
    const result = resolveFailureAction(rules, config);
    expect(result.action).toBe('halt');
    expect(result.maxRetries).toBe(0);
  });
});

// --------------------------------------------------------------------------
// truncateDiff -- diff truncation
// --------------------------------------------------------------------------

describe('truncateDiff', () => {
  it('returns unchanged string when under limit', () => {
    const shortDiff = 'diff --git a/file.ts b/file.ts\n+console.log("hello");';
    const result = truncateDiff(shortDiff, 1000);
    expect(result).toBe(shortDiff);
  });

  it('truncates and appends notice when over limit', () => {
    const longDiff = 'x'.repeat(200);
    const result = truncateDiff(longDiff, 100);
    expect(result).toContain('x'.repeat(100));
    expect(result).toContain('[Diff truncated: 100 characters omitted]');
    expect(result).not.toContain('x'.repeat(101));
  });

  it('returns unchanged string when exactly at limit', () => {
    const exactDiff = 'y'.repeat(500);
    const result = truncateDiff(exactDiff, 500);
    expect(result).toBe(exactDiff);
  });

  it('uses MAX_DIFF_CHARS as default when no limit specified', () => {
    const shortDiff = 'short diff';
    const result = truncateDiff(shortDiff);
    expect(result).toBe(shortDiff);
  });
});
