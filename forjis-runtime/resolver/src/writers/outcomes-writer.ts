/**
 * Outcomes config file writer.
 *
 * Generates `.forjis/config/outcomes.yaml` using the named outcome group
 * format with per-group metrics and rules (FR-026).
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type {
  MetricDef,
  OutcomeGroupDef,
  OutcomeRule,
  PluginDef,
  WriterContext,
  WriteResult,
} from '../types.js';

/** Cache key used for the outcomes config file. */
const CACHE_KEY = 'config:outcomes';

/** Output filename. */
const FILE_NAME = 'outcomes.yaml';

/**
 * Generates .forjis/config/outcomes.yaml.
 *
 * Uses the named outcome group format with per-group metrics and rules.
 * Falls back to a single "default" group when outcome groups are not defined.
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeOutcomesConfig(ctx: WriterContext): Promise<WriteResult> {
  const outcomesData = buildOutcomesData(ctx);
  const content = stringifyYaml(outcomesData, { indent: 2 });
  const hash = computeHash(content);

  if (!isChanged(CACHE_KEY, hash, ctx.previousCache)) {
    return { file: FILE_NAME, written: false };
  }

  await ensureDir(ctx.configDir);
  await atomicWriteFile(join(ctx.configDir, FILE_NAME), content);

  ctx.cacheEntries[CACHE_KEY] = {
    sourceHash: hash,
    targetPaths: [FILE_NAME],
    generatedAt: new Date().toISOString(),
  };

  return { file: FILE_NAME, written: true };
}

/**
 * Builds the outcomes data structure for YAML serialization.
 *
 * Implements three-source merge (D5):
 * 1. Build-file groups (highest priority)
 * 2. Plugin groups referenced by roles (auto-included, skipped if build-file has same name)
 * 3. Default group fallback (only when no groups from sources 1 or 2)
 */
function buildOutcomesData(ctx: WriterContext): Record<string, unknown> {
  const buildOutcome = ctx.buildConfig.outcome;
  const buildGroups = buildOutcome?.groups ?? [];

  const mergedGroups: OutcomeGroupDef[] = [...buildGroups];
  const coveredNames = new Set(buildGroups.map(g => g.name));

  const roleRefs = collectRoleOutcomeRefs(ctx);
  for (const refName of roleRefs) {
    if (coveredNames.has(refName)) {
      continue;
    }
    const pluginGroup = findPluginGroup(refName, ctx.plugins);
    if (pluginGroup) {
      mergedGroups.push(pluginGroup);
      coveredNames.add(refName);
    }
  }

  if (mergedGroups.length > 0) {
    return {
      defaultAction: ctx.config.defaultAction,
      defaultMaxRetries: ctx.config.defaultMaxRetries,
      outcomes: mergedGroups.map(g => ({
        name: g.name,
        metrics: serializeMetricsRecord(g.metrics),
        rules: g.rules.map(serializeRule),
      })),
    };
  }

  const metricsObj = metricsMapToObject(ctx.config.metrics);

  return {
    defaultAction: ctx.config.defaultAction,
    defaultMaxRetries: ctx.config.defaultMaxRetries,
    outcomes: [
      {
        name: 'default',
        metrics: metricsObj,
        rules: ctx.config.outcomeRules.map(serializeRule),
      },
    ],
  };
}

/**
 * Collects all outcome group references from resolved roles.
 *
 * Iterates through all orgs, teams, and roles in the runtime config,
 * gathering each role's outcome references into a deduplicated set.
 */
function collectRoleOutcomeRefs(ctx: WriterContext): Set<string> {
  const refs = new Set<string>();
  for (const org of ctx.config.orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        if (role.outcomes) {
          for (const outcome of role.outcomes) {
            refs.add(outcome);
          }
        }
      }
    }
  }
  return refs;
}

/**
 * Searches plugin outcome groups for a group matching the given name.
 *
 * Returns the first matching group found across all plugins, or null
 * if no plugin defines a group with that name.
 */
function findPluginGroup(name: string, plugins: PluginDef[]): OutcomeGroupDef | null {
  for (const plugin of plugins) {
    if (plugin.outcome?.groups) {
      const group = plugin.outcome.groups.find(g => g.name === name);
      if (group) {
        return group;
      }
    }
  }
  return null;
}

/**
 * Serializes an outcome rule for YAML output.
 */
function serializeRule(rule: OutcomeRule): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: rule.type,
    expression: rule.expression,
  };
  if (rule.action) {
    result['action'] = rule.action;
  }
  if (rule.maxRetries !== undefined) {
    result['max_retries'] = rule.maxRetries;
  }
  return result;
}

/**
 * Serializes a metric definition for YAML output.
 * Converts the criteria array to a multiline string format as per spec.
 */
function serializeMetric(metric: MetricDef): Record<string, unknown> {
  const result: Record<string, unknown> = {
    description: metric.description,
    criteria: Array.isArray(metric.criteria)
      ? metric.criteria.map(c => `- ${c}`).join('\n')
      : metric.criteria,
    scale: metric.scale,
  };
  return result;
}

/**
 * Converts a Map of metrics to a plain object for YAML serialization.
 */
function metricsMapToObject(metrics: Map<string, MetricDef>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of metrics) {
    result[key] = serializeMetric(value);
  }
  return result;
}

/**
 * Converts a record of metrics to serialized format for YAML output.
 */
function serializeMetricsRecord(metrics: Record<string, MetricDef>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(metrics)) {
    result[key] = serializeMetric(value);
  }
  return result;
}
