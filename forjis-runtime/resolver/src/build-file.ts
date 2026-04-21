/**
 * Build file parser for @forjis/resolver.
 *
 * Loads and validates `build.forjis` YAML files against the schema,
 * producing typed BuildConfig objects. Collects all validation errors
 * before throwing, so users see every issue at once.
 *
 * Extended with FR-026 (outcome groups) and FR-027 (role outcomes).
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { BuildFileNotFoundError, BuildFileValidationError } from './errors.js';
import type {
  BuildConfig,
  BuildConstraintsConfig,
  ConstraintIncludeRef,
  HealthCheckConfig,
  MetricDef,
  OrgDef,
  OutcomeConfig,
  OutcomeGroupDef,
  OutcomeRule,
  PersonasConfig,
  PluginRef,
  RoleDef,
  RoleHooks,
  TasksConfig,
  TeamDef,
  TokenBudgetConfig,
} from './types.js';

/**
 * Loads a build file from disk and returns its raw YAML content.
 *
 * @param filePath - Absolute or relative path to the build file.
 * @returns The raw file content as a string.
 * @throws {BuildFileNotFoundError} If the file does not exist.
 */
export async function loadBuildFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    throw new BuildFileNotFoundError(filePath);
  }
}

/**
 * Parses and validates a build file YAML string into a typed BuildConfig.
 *
 * All validation errors are collected and reported together. Defaults are
 * applied for optional fields that are omitted.
 *
 * @param content - The raw YAML string to parse.
 * @returns A fully validated and normalized BuildConfig.
 * @throws {BuildFileValidationError} If the content fails validation.
 */
export function parseBuildFile(content: string): BuildConfig {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BuildFileValidationError([`YAML parse error: ${message}`]);
  }

  if (!doc || typeof doc !== 'object') {
    throw new BuildFileValidationError(['Build file must be a YAML object']);
  }

  const raw = doc as Record<string, unknown>;
  const errors: string[] = [];

  validateVersion(raw, errors);
  const engine = validateEngine(raw['engine'], errors);
  const repositories = validateRepositories(raw['repositories'], errors);
  const plugins = validatePlugins(raw['plugins'], errors);
  const orgs = validateOrgs(raw['orgs'], errors);
  const tasks = validateTasks(raw['tasks'], errors);
  const outcome = validateOutcome(raw['outcome'], errors);
  const tokenBudget = validateTokenBudget(raw['token_budget'], errors);
  const constraints = validateConstraints(raw['constraints'], errors);
  const personas = validatePersonas(raw['personas'], errors);
  const healthCheck = validateHealthCheck(raw['health_check'], errors);

  if (errors.length > 0) {
    throw new BuildFileValidationError(errors);
  }

  return {
    version: 1,
    engine,
    repositories,
    plugins,
    orgs,
    tasks,
    outcome,
    tokenBudget,
    constraints,
    personas,
    healthCheck,
  };
}

/**
 * Parses a duration string like "30s", "5m", "1h" into milliseconds.
 *
 * @param input - Duration string with a numeric value and unit suffix.
 * @returns The duration in milliseconds.
 * @throws {BuildFileValidationError} If the format is invalid.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(input);
  if (!match) {
    throw new BuildFileValidationError([
      `Invalid duration "${input}": expected format like "30s", "5m", or "1h"`,
    ]);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
  return value * multipliers[unit];
}

/**
 * Formats milliseconds back to a human-readable duration string.
 *
 * @param ms - Duration in milliseconds.
 * @returns A duration string like "30s", "5m", or "1h".
 */
export function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  return `${ms / 1000}s`;
}

// -- Internal validators ----------------------------------------------------

/**
 * Validates that version is present and equals 1.
 */
function validateVersion(raw: Record<string, unknown>, errors: string[]): void {
  if (!('version' in raw)) {
    errors.push('"version" is required');
    return;
  }
  if (raw['version'] !== 1) {
    errors.push(`Unsupported version "${raw['version']}": only version 1 is supported`);
  }
}

/**
 * Validates the optional engine field.
 *
 * Accepts any string value. The actual engine name is validated at runtime
 * by loadEngine(), not at parse time.
 */
function validateEngine(engine: unknown, errors: string[]): string | undefined {
  if (engine === undefined || engine === null) {
    return undefined;
  }
  if (typeof engine !== 'string') {
    errors.push('"engine" must be a string');
    return undefined;
  }
  return engine;
}

/**
 * Validates the repositories array. Each entry must be a git or dir config.
 */
function validateRepositories(
  repos: unknown,
  errors: string[]
): BuildConfig['repositories'] {
  if (repos === undefined || repos === null) {
    return [];
  }

  if (!Array.isArray(repos)) {
    errors.push('"repositories" must be an array');
    return [];
  }

  const result: BuildConfig['repositories'] = [];

  for (let i = 0; i < repos.length; i++) {
    const entry = repos[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      errors.push(`repositories[${i}]: must be an object`);
      continue;
    }

    const type = entry['type'];
    if (type === 'git') {
      if (typeof entry['url'] !== 'string' || !entry['url']) {
        errors.push(`repositories[${i}]: git repository requires a "url" string`);
      }
      if (typeof entry['ref'] !== 'string' || !entry['ref']) {
        errors.push(`repositories[${i}]: git repository requires a "ref" string`);
      }
      result.push({ type: 'git', url: String(entry['url'] ?? ''), ref: String(entry['ref'] ?? '') });
    } else if (type === 'dir') {
      if (typeof entry['path'] !== 'string' || !entry['path']) {
        errors.push(`repositories[${i}]: dir repository requires a "path" string`);
      }
      result.push({ type: 'dir', path: String(entry['path'] ?? '') });
    } else {
      errors.push(`repositories[${i}]: unknown type "${type}" (expected "git" or "dir")`);
    }
  }

  return result;
}

/**
 * Validates the optional plugins array.
 */
function validatePlugins(plugins: unknown, errors: string[]): PluginRef[] {
  if (plugins === undefined || plugins === null) {
    return [];
  }

  if (!Array.isArray(plugins)) {
    errors.push('"plugins" must be an array');
    return [];
  }

  const result: PluginRef[] = [];

  for (let i = 0; i < plugins.length; i++) {
    const entry = plugins[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      errors.push(`plugins[${i}]: must be an object`);
      continue;
    }
    if (typeof entry['name'] !== 'string' || !entry['name']) {
      errors.push(`plugins[${i}]: requires a "name" string`);
      continue;
    }
    result.push({ name: entry['name'] });
  }

  return result;
}

/**
 * Validates the optional orgs array, including extends format and role structure.
 */
function validateOrgs(orgs: unknown, errors: string[]): OrgDef[] {
  if (orgs === undefined || orgs === null) {
    return [];
  }

  if (!Array.isArray(orgs)) {
    errors.push('"orgs" must be an array');
    return [];
  }

  const result: OrgDef[] = [];

  for (let i = 0; i < orgs.length; i++) {
    const entry = orgs[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      errors.push(`orgs[${i}]: must be an object`);
      continue;
    }

    if (typeof entry['name'] !== 'string' || !entry['name']) {
      errors.push(`orgs[${i}]: requires a "name" string`);
      continue;
    }

    const org: OrgDef = { name: entry['name'], roles: [] };

    if (entry['extends'] !== undefined) {
      if (typeof entry['extends'] !== 'string') {
        errors.push(`orgs[${i}]: "extends" must be a string in "plugin:orgName" format`);
      } else {
        org.extends = entry['extends'];
      }
    }

    const hasRoles = entry['roles'] !== undefined;
    const hasTeams = entry['teams'] !== undefined;

    if (hasTeams && hasRoles) {
      errors.push(`orgs[${i}]: "teams" and "roles" are mutually exclusive`);
    }

    if (hasRoles && !hasTeams) {
      org.roles = validateRoles(entry['roles'], `orgs[${i}]`, errors);
    }

    if (hasTeams && !hasRoles) {
      org.teams = validateTeams(entry['teams'], `orgs[${i}]`, errors);
    }

    result.push(org);
  }

  return result;
}

/**
 * Validates a teams array within an org definition.
 *
 * Each team must have a `name` string, an optional `extends` string,
 * and an optional `roles` array delegated to validateRoles().
 */
function validateTeams(
  teams: unknown,
  prefix: string,
  errors: string[]
): TeamDef[] {
  if (!Array.isArray(teams)) {
    errors.push(`${prefix}.teams: must be an array`);
    return [];
  }

  const result: TeamDef[] = [];

  for (let j = 0; j < teams.length; j++) {
    const team = teams[j] as Record<string, unknown>;
    if (!team || typeof team !== 'object') {
      errors.push(`${prefix}.teams[${j}]: must be an object`);
      continue;
    }

    if (typeof team['name'] !== 'string' || !team['name']) {
      errors.push(`${prefix}.teams[${j}]: requires a "name" string`);
      continue;
    }

    const teamDef: TeamDef = { name: team['name'], roles: [] };

    if (team['extends'] !== undefined) {
      if (typeof team['extends'] !== 'string') {
        errors.push(`${prefix}.teams[${j}]: "extends" must be a string`);
      } else {
        teamDef.extends = team['extends'];
      }
    }

    if (team['roles'] !== undefined) {
      teamDef.roles = validateRoles(team['roles'], `${prefix}.teams[${j}]`, errors);
    }

    result.push(teamDef);
  }

  return result;
}

/**
 * Validates a roles array within an org definition.
 *
 * Extended with FR-027 to parse an optional `outcomes` array on each role.
 */
function validateRoles(
  roles: unknown,
  prefix: string,
  errors: string[]
): RoleDef[] {
  if (!Array.isArray(roles)) {
    errors.push(`${prefix}.roles: must be an array`);
    return [];
  }

  const result: RoleDef[] = [];

  for (let j = 0; j < roles.length; j++) {
    const role = roles[j] as Record<string, unknown>;
    if (!role || typeof role !== 'object') {
      errors.push(`${prefix}.roles[${j}]: must be an object`);
      continue;
    }

    if (typeof role['name'] !== 'string' || !role['name']) {
      errors.push(`${prefix}.roles[${j}]: requires a "name" string`);
      continue;
    }

    const roleDef: RoleDef = { name: role['name'] };

    if (role['agent'] !== undefined) {
      roleDef.agent = String(role['agent']);
    }
    if (role['extends'] !== undefined) {
      roleDef.extends = String(role['extends']);
    }
    if (role['skills'] !== undefined) {
      if (Array.isArray(role['skills'])) {
        roleDef.skills = role['skills'].map(String);
      } else {
        errors.push(`${prefix}.roles[${j}].skills: must be an array`);
      }
    }
    if (role['hooks'] !== undefined) {
      roleDef.hooks = parseRoleHooks(role['hooks'], `${prefix}.roles[${j}]`, errors);
    }
    if (role['outcomes'] !== undefined) {
      if (Array.isArray(role['outcomes'])) {
        roleDef.outcomes = role['outcomes'].map(String);
      } else {
        errors.push(`${prefix}.roles[${j}].outcomes: must be an array of strings`);
      }
    }

    result.push(roleDef);
  }

  return result;
}

/**
 * Parses hook configuration for a role, normalizing missing arrays to empty.
 */
function parseRoleHooks(
  hooks: unknown,
  prefix: string,
  errors: string[]
): RoleHooks {
  const result: RoleHooks = { pre: [], validation: [], post: [] };

  if (!hooks || typeof hooks !== 'object') {
    errors.push(`${prefix}.hooks: must be an object`);
    return result;
  }

  const raw = hooks as Record<string, unknown>;

  for (const key of ['pre', 'validation', 'post'] as const) {
    if (raw[key] !== undefined) {
      if (Array.isArray(raw[key])) {
        result[key] = (raw[key] as unknown[]).map(String);
      } else {
        errors.push(`${prefix}.hooks.${key}: must be an array`);
      }
    }
  }

  return result;
}

/**
 * Validates the optional tasks block, including duration parsing.
 */
function validateTasks(tasks: unknown, errors: string[]): TasksConfig | null {
  if (tasks === undefined || tasks === null) {
    return null;
  }

  if (typeof tasks !== 'object') {
    errors.push('"tasks" must be an object');
    return null;
  }

  const raw = tasks as Record<string, unknown>;
  const config: TasksConfig = {
    pollIntervalMs: 300_000,
    autoDependencies: false,
  };

  if (raw['source'] !== undefined) {
    if (raw['source'] !== 'dir') {
      errors.push('tasks.source: only "dir" is supported');
    } else {
      config.source = 'dir';
    }
  }

  if (raw['path'] !== undefined) {
    config.path = String(raw['path']);
  } else if (config.source === 'dir') {
    errors.push('tasks.path: required when source is "dir"');
  }

  if (raw['poll_interval'] !== undefined) {
    try {
      config.pollIntervalMs = parseDuration(String(raw['poll_interval']));
    } catch {
      errors.push(`tasks.poll_interval: invalid duration "${raw['poll_interval']}"`);
    }
  }

  if (raw['max_concurrent'] !== undefined) {
    const val = Number(raw['max_concurrent']);
    if (!Number.isInteger(val) || val < 1) {
      errors.push('tasks.max_concurrent: must be a positive integer');
    } else {
      config.maxConcurrent = val;
    }
  }

  if (raw['auto_dependencies'] !== undefined) {
    config.autoDependencies = Boolean(raw['auto_dependencies']);
  }

  return config;
}

/**
 * Validates the optional outcome block, including rule expressions.
 *
 * Extended with FR-026 to support named outcome groups.
 */
function validateOutcome(outcome: unknown, errors: string[]): OutcomeConfig | null {
  if (outcome === undefined || outcome === null) {
    return null;
  }

  if (typeof outcome !== 'object') {
    errors.push('"outcome" must be an object');
    return null;
  }

  const raw = outcome as Record<string, unknown>;
  const config: OutcomeConfig = {
    enabled: true,
    rules: [],
    defaultAction: 'halt',
    defaultMaxRetries: 1,
  };

  if (raw['enabled'] !== undefined) {
    config.enabled = Boolean(raw['enabled']);
  }

  if (raw['rules'] !== undefined) {
    if (!Array.isArray(raw['rules'])) {
      errors.push('outcome.rules: must be an array');
    } else {
      for (let i = 0; i < raw['rules'].length; i++) {
        const ruleErrors = validateOutcomeRule(raw['rules'][i], i);
        if (ruleErrors.length > 0) {
          errors.push(...ruleErrors);
        } else {
          config.rules.push(parseOutcomeRule(raw['rules'][i] as Record<string, unknown>));
        }
      }
    }
  }

  if (raw['default_action'] !== undefined) {
    if (raw['default_action'] !== 'halt' && raw['default_action'] !== 'retry') {
      errors.push('outcome.default_action: must be "halt" or "retry"');
    } else {
      config.defaultAction = raw['default_action'];
    }
  }

  if (raw['default_max_retries'] !== undefined) {
    const val = Number(raw['default_max_retries']);
    if (!Number.isInteger(val) || val < 0) {
      errors.push('outcome.default_max_retries: must be a non-negative integer');
    } else {
      config.defaultMaxRetries = val;
    }
  }

  if (raw['groups'] !== undefined) {
    config.groups = validateOutcomeGroups(raw['groups'], errors);
  }

  return config;
}

/**
 * Validates an array of named outcome groups (FR-026).
 *
 * Each group has a name, a metrics map, and a rules array.
 */
function validateOutcomeGroups(
  groups: unknown,
  errors: string[]
): OutcomeGroupDef[] {
  if (!Array.isArray(groups)) {
    errors.push('outcome.groups: must be an array');
    return [];
  }

  const result: OutcomeGroupDef[] = [];

  for (let i = 0; i < groups.length; i++) {
    const entry = groups[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      errors.push(`outcome.groups[${i}]: must be an object`);
      continue;
    }

    if (typeof entry['name'] !== 'string' || !entry['name']) {
      errors.push(`outcome.groups[${i}]: requires a "name" string`);
      continue;
    }

    const metrics = parseGroupMetrics(entry['metrics'], `outcome.groups[${i}]`, errors);
    const rules = parseGroupRules(entry['rules'], `outcome.groups[${i}]`, errors);

    result.push({ name: entry['name'], metrics, rules });
  }

  return result;
}

/**
 * Parses the metrics map within an outcome group.
 */
function parseGroupMetrics(
  raw: unknown,
  prefix: string,
  errors: string[]
): Record<string, MetricDef> {
  const result: Record<string, MetricDef> = {};

  if (raw === undefined || raw === null) {
    return result;
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}.metrics: must be an object`);
    return result;
  }

  const obj = raw as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    const m = value as Record<string, unknown>;

    if (typeof m['description'] !== 'string') {
      errors.push(`${prefix}.metrics.${key}: "description" required`);
      continue;
    }
    if (!Array.isArray(m['criteria'])) {
      errors.push(`${prefix}.metrics.${key}: "criteria" must be an array`);
      continue;
    }
    if (typeof m['scale'] !== 'string') {
      errors.push(`${prefix}.metrics.${key}: "scale" required`);
      continue;
    }

    result[key] = {
      description: m['description'],
      criteria: m['criteria'].map(String),
      scale: m['scale'],
    };
  }

  return result;
}

/**
 * Parses the rules array within an outcome group.
 */
function parseGroupRules(
  raw: unknown,
  prefix: string,
  errors: string[]
): OutcomeRule[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    errors.push(`${prefix}.rules: must be an array`);
    return [];
  }

  const result: OutcomeRule[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ruleErrors = validateOutcomeRule(raw[i], i, `${prefix}.rules`);
    if (ruleErrors.length > 0) {
      errors.push(...ruleErrors);
    } else {
      result.push(parseOutcomeRule(raw[i] as Record<string, unknown>));
    }
  }

  return result;
}

/**
 * Validates a single outcome rule entry for correct structure.
 *
 * @param rule - The raw rule object.
 * @param index - The array index for error messages.
 * @param prefix - Optional prefix for error messages (defaults to "outcome").
 * @returns An array of error messages (empty if valid).
 */
function validateOutcomeRule(rule: unknown, index: number, prefix = 'outcome'): string[] {
  const errors: string[] = [];
  const errorPrefix = `${prefix}.rules[${index}]`;

  if (!rule || typeof rule !== 'object') {
    errors.push(`${errorPrefix}: must be an object`);
    return errors;
  }

  const raw = rule as Record<string, unknown>;
  const hasFail = 'fail' in raw;
  const hasWarning = 'warning' in raw;

  if (hasFail && hasWarning) {
    errors.push(`${errorPrefix}: "fail" and "warning" are mutually exclusive`);
  } else if (!hasFail && !hasWarning) {
    errors.push(`${errorPrefix}: must have either "fail" or "warning" expression`);
  }

  if (hasFail && typeof raw['fail'] !== 'string') {
    errors.push(`${errorPrefix}.fail: must be a string expression`);
  }

  if (hasWarning && typeof raw['warning'] !== 'string') {
    errors.push(`${errorPrefix}.warning: must be a string expression`);
  }

  if (raw['action'] !== undefined) {
    if (raw['action'] !== 'halt' && raw['action'] !== 'retry') {
      errors.push(`${errorPrefix}.action: must be "halt" or "retry"`);
    }
  }

  if (raw['max_retries'] !== undefined) {
    const val = Number(raw['max_retries']);
    if (!Number.isInteger(val) || val < 0) {
      errors.push(`${errorPrefix}.max_retries: must be a non-negative integer`);
    }
  }

  return errors;
}

/**
 * Parses a validated raw rule object into an OutcomeRule.
 */
function parseOutcomeRule(raw: Record<string, unknown>): OutcomeRule {
  const hasFail = 'fail' in raw;
  const rule: OutcomeRule = {
    type: hasFail ? 'fail' : 'warning',
    expression: String(hasFail ? raw['fail'] : raw['warning']),
  };

  if (raw['action'] !== undefined) {
    rule.action = raw['action'] as 'halt' | 'retry';
  }

  if (raw['max_retries'] !== undefined) {
    rule.maxRetries = Number(raw['max_retries']);
  }

  return rule;
}

/**
 * Validates the optional token_budget block.
 *
 * Requires `max_tokens` as a positive integer. `reset_window` is optional
 * and defaults to "1h" (3600000 ms).
 */
function validateTokenBudget(
  tokenBudget: unknown,
  errors: string[]
): TokenBudgetConfig | null {
  if (tokenBudget === undefined || tokenBudget === null) {
    return null;
  }

  if (typeof tokenBudget !== 'object') {
    errors.push('"token_budget" must be an object');
    return null;
  }

  const raw = tokenBudget as Record<string, unknown>;

  if (raw['max_tokens'] === undefined) {
    errors.push('token_budget.max_tokens: is required');
    return null;
  }

  const maxTokens = Number(raw['max_tokens']);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    errors.push('token_budget.max_tokens: must be a positive integer');
    return null;
  }

  let resetWindowMs = 3_600_000;
  if (raw['reset_window'] !== undefined) {
    try {
      resetWindowMs = parseDuration(String(raw['reset_window']));
    } catch {
      errors.push(`token_budget.reset_window: invalid duration "${raw['reset_window']}"`);
    }
  }

  return { maxTokens, resetWindowMs };
}

/** Regex pattern for valid include entry syntax. */
const INCLUDE_PATTERN = /^([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+|\*)$/;

/**
 * Validates the optional constraints block in the build file.
 */
function validateConstraints(
  constraints: unknown,
  errors: string[]
): BuildConstraintsConfig | null {
  if (constraints === undefined || constraints === null) {
    return null;
  }

  if (typeof constraints !== 'object') {
    errors.push('"constraints" must be an object');
    return null;
  }

  const raw = constraints as Record<string, unknown>;
  const include = validateConstraintsInclude(raw['include'], errors);
  const mandatory = validateConstraintsString(raw['mandatory'], 'constraints.mandatory', errors);
  const optional = validateConstraintsString(raw['optional'], 'constraints.optional', errors);
  const pillars = validateConstraintsPillars(raw['pillars'], errors);

  return { include, mandatory, optional, pillars };
}

/**
 * Validates the include array within a constraints block.
 */
function validateConstraintsInclude(
  include: unknown,
  errors: string[]
): ConstraintIncludeRef[] {
  if (include === undefined || include === null) {
    return [];
  }

  if (!Array.isArray(include)) {
    errors.push('constraints.include: must be an array');
    return [];
  }

  const result: ConstraintIncludeRef[] = [];

  for (let i = 0; i < include.length; i++) {
    const entry = String(include[i]);
    const match = INCLUDE_PATTERN.exec(entry);

    if (!match) {
      errors.push(
        `constraints.include[${i}]: invalid syntax "${entry}" — expected "<plugin-name>:<group-name>" or "<plugin-name>:*"`
      );
      continue;
    }

    result.push({ pluginName: match[1], groupName: match[2] });
  }

  return result;
}

/**
 * Validates that a constraints sub-field is a string.
 */
function validateConstraintsString(
  value: unknown,
  fieldName: string,
  errors: string[]
): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    errors.push(`${fieldName}: must be a string`);
    return '';
  }

  return value;
}

/**
 * Validates the optional pillars array within a constraints block.
 *
 * Follows the same pattern as validateConstraintsInclude(): handles
 * undefined/null (returns []), non-array (pushes error, returns []),
 * and validates each entry is a non-empty string.
 *
 * @param pillars - Raw pillars value from the parsed YAML.
 * @param errors - Mutable array to collect validation error messages.
 * @returns An array of validated pillar file path strings.
 */
function validateConstraintsPillars(
  pillars: unknown,
  errors: string[]
): string[] {
  if (pillars === undefined || pillars === null) {
    return [];
  }

  if (!Array.isArray(pillars)) {
    errors.push('constraints.pillars: must be an array');
    return [];
  }

  for (let i = 0; i < pillars.length; i++) {
    if (typeof pillars[i] !== 'string') {
      errors.push(`constraints.pillars[${i}]: must be a string`);
    } else if (pillars[i] === '') {
      errors.push(`constraints.pillars[${i}]: must be a non-empty string`);
    }
  }

  return pillars.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== ''
  );
}

/**
 * Validates the optional personas block in the build file.
 */
function validatePersonas(
  personas: unknown,
  errors: string[]
): PersonasConfig | null {
  if (personas === undefined || personas === null) {
    return null;
  }

  if (typeof personas !== 'object') {
    errors.push('"personas" must be an object');
    return null;
  }

  const raw = personas as Record<string, unknown>;

  if (raw['dir'] === undefined || raw['dir'] === null) {
    errors.push('personas.dir: required');
    return null;
  }

  if (typeof raw['dir'] !== 'string') {
    errors.push('personas.dir: must be a string');
    return null;
  }

  return { dir: raw['dir'] };
}

/** Default health check interval in seconds. */
const DEFAULT_HEALTH_CHECK_INTERVAL = 300;

/** Default maximum retries per role. */
const DEFAULT_HEALTH_CHECK_MAX_RETRIES = 3;

/** Recognized keys within the health_check block. */
const HEALTH_CHECK_KEYS = new Set(['interval', 'max_retries']);

/**
 * Validates the optional health_check block in the build file.
 */
function validateHealthCheck(
  healthCheck: unknown,
  errors: string[]
): HealthCheckConfig | null {
  if (healthCheck === undefined || healthCheck === null) {
    return null;
  }

  if (typeof healthCheck !== 'object') {
    errors.push('"health_check" must be an object');
    return null;
  }

  const raw = healthCheck as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!HEALTH_CHECK_KEYS.has(key)) {
      errors.push(`health_check: unrecognized key "${key}"`);
    }
  }

  let interval = DEFAULT_HEALTH_CHECK_INTERVAL;
  if (raw['interval'] !== undefined) {
    const val = Number(raw['interval']);
    if (!Number.isInteger(val) || val <= 0) {
      errors.push('health_check.interval: must be a positive integer');
    } else {
      interval = val;
    }
  }

  let maxRetries = DEFAULT_HEALTH_CHECK_MAX_RETRIES;
  if (raw['max_retries'] !== undefined) {
    const val = Number(raw['max_retries']);
    if (!Number.isInteger(val) || val <= 0) {
      errors.push('health_check.max_retries: must be a positive integer');
    } else {
      maxRetries = val;
    }
  }

  return { interval, maxRetries };
}
