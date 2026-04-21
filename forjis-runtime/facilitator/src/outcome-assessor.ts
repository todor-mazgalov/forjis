/**
 * Outcome assessment utilities for @forjis/cli.
 *
 * Provides pure utility functions for evaluating outcome rules against
 * metric scores and resolving failure actions. The actual scoring is
 * performed by the assessor agent within the orchestrator pipeline;
 * these utilities are used by the orchestrator for verdict handling.
 */

import { evaluateExpression } from './expression-eval.js';
import type {
  MetricDef,
  OutcomeRule,
  Verdict,
} from './types.js';

/** Built-in metric names that are always available. */
const BUILTIN_METRICS = ['completeness', 'speculation', 'hallucination'];

/**
 * Evaluates all outcome rules against a set of metric scores.
 *
 * Determines the verdict based on which rules trigger: FAIL takes
 * precedence over WARNING, which takes precedence over PASS.
 *
 * @param scores - Map of metric names to their numeric scores.
 * @param rules - The outcome rules to evaluate.
 * @param metrics - Custom metric definitions for known-metric validation.
 * @returns The verdict along with triggered warning and failure messages.
 */
export function evaluateRules(
  scores: Record<string, number>,
  rules: OutcomeRule[],
  metrics: Map<string, MetricDef>
): { verdict: Verdict; warnings: string[]; failures: string[] } {
  const knownMetrics = buildKnownMetricsSet(metrics);
  const warnings: string[] = [];
  const failures: string[] = [];

  for (const rule of rules) {
    const triggered = evaluateExpression(rule.expression, scores, knownMetrics);

    if (triggered && rule.type === 'fail') {
      failures.push(`FAIL: ${rule.expression}`);
    } else if (triggered && rule.type === 'warning') {
      warnings.push(`WARNING: ${rule.expression}`);
    }
  }

  let verdict: Verdict = 'PASS';
  if (failures.length > 0) {
    verdict = 'FAIL';
  } else if (warnings.length > 0) {
    verdict = 'WARNING';
  }

  return { verdict, warnings, failures };
}

/**
 * Determines the failure action for a failed assessment.
 *
 * If any triggered rule specifies "halt", the action is halt.
 * Otherwise the action is retry with the minimum max_retries
 * across all triggered rules.
 *
 * @param triggeredRules - The fail rules that triggered.
 * @param config - Object providing default action and max retries.
 * @returns The resolved action and maximum retry count.
 */
export function resolveFailureAction(
  triggeredRules: OutcomeRule[],
  config: { defaultAction: 'halt' | 'retry'; defaultMaxRetries: number }
): { action: 'halt' | 'retry'; maxRetries: number } {
  let hasHalt = false;
  let minRetries = Infinity;

  for (const rule of triggeredRules) {
    const action = rule.action ?? config.defaultAction;
    const retries = rule.maxRetries ?? config.defaultMaxRetries;

    if (action === 'halt') {
      hasHalt = true;
    }

    minRetries = Math.min(minRetries, retries);
  }

  if (hasHalt) {
    return { action: 'halt', maxRetries: 0 };
  }

  return {
    action: 'retry',
    maxRetries: minRetries === Infinity ? config.defaultMaxRetries : minRetries,
  };
}

// -- Internal helpers -------------------------------------------------------

/** Builds the set of all known metric names (built-in + custom). */
function buildKnownMetricsSet(metrics: Map<string, MetricDef>): Set<string> {
  const known = new Set(BUILTIN_METRICS);
  for (const key of metrics.keys()) {
    known.add(key);
  }
  return known;
}
