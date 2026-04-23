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
  DevConfig,
  HealthCheckConfig,
  InspectorConfig,
  MetricDef,
  OrgDef,
  OutcomeConfig,
  OutcomeGroupDef,
  OutcomeRule,
  PersonasConfig,
  PluginRef,
  RoleDef,
  RoleHooks,
  RoleTriple,
  TaskRuleIncludeRef,
  TasksConfig,
  TeamDef,
  TokenBudgetConfig,
  VisualEntry,
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
  const inspector = validateInspector(raw['inspector'], errors);
  const dev = validateDev(raw['dev'], errors);

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
    inspector,
    dev,
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
    if (role['visuals'] !== undefined) {
      const visuals = validateVisuals(role['visuals'], `${prefix}.roles[${j}]`, errors);
      if (visuals !== undefined) {
        roleDef.visuals = visuals;
      }
    }

    result.push(roleDef);
  }

  return result;
}

/**
 * Allowed lowercase schemes on a `VisualEntry.location`. Compared case
 * sensitively — `FILE://` is rejected on purpose.
 */
const VISUAL_SCHEMES = ['http', 'https', 'file', 'dir'] as const;

/**
 * Regex matching the `tool` spec format on a `VisualEntry`.
 *
 * `<name>@<path>` where `<name>` is `[a-zA-Z0-9_-]+` and `<path>` is a
 * non-empty string (captured as group 1 for potential future reuse).
 */
const TOOL_PATTERN = /^[a-zA-Z0-9_-]+@(.+)$/;

/**
 * Validates and parses the optional `visuals` list on a role.
 *
 * Returns `undefined` when the key is absent. When present and of an
 * invalid outer shape, pushes an error and returns `undefined`. Empty
 * arrays are accepted and returned verbatim so callers can distinguish
 * "absent" from "empty" if needed (both behave identically downstream).
 *
 * Per-entry errors are accumulated in `errors` with an index-path prefix;
 * malformed entries are dropped from the returned list so the accumulator
 * sees every issue at once without throwing early.
 *
 * @param raw - Raw YAML value found under the role's `visuals` key.
 * @param rolePrefix - Index-path prefix of the parent role (e.g.
 *   `orgs[0].roles[2]`) used to disambiguate error messages.
 * @param errors - Mutable error accumulator shared across the whole
 *   `parseBuildFile` pass.
 * @returns The parsed array, or `undefined` when the outer shape is
 *   invalid.
 */
function validateVisuals(
  raw: unknown,
  rolePrefix: string,
  errors: string[]
): VisualEntry[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(`${rolePrefix}.visuals: must be an array`);
    return undefined;
  }

  const result: VisualEntry[] = [];
  for (let k = 0; k < raw.length; k++) {
    const entry = validateVisualEntry(
      raw[k],
      `${rolePrefix}.visuals[${k}]`,
      errors
    );
    if (entry !== null) {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Shape-validates a single `VisualEntry`.
 *
 * Checks that `location` is a non-empty string with a scheme in
 * {@link VISUAL_SCHEMES}; that `command`, `tool`, and `credentials` are
 * strings when present; that `tool` matches {@link TOOL_PATTERN}; and
 * that `credentials` / `tool` install paths do not contain a raw `..`
 * segment (NFR-08). Realpath containment of `credentials` is deferred
 * to the resolver's post-compose pass because `projectDir` is not in
 * scope of this module.
 *
 * @param entry - Raw YAML value for one entry.
 * @param prefix - Index-path prefix naming the entry (e.g.
 *   `orgs[0].roles[2].visuals[1]`).
 * @param errors - Mutable error accumulator.
 * @returns The validated entry, or `null` when any shape error was
 *   recorded.
 */
function validateVisualEntry(
  entry: unknown,
  prefix: string,
  errors: string[]
): VisualEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${prefix}: must be an object`);
    return null;
  }

  const raw = entry as Record<string, unknown>;
  let valid = true;

  const location = validateVisualLocation(raw['location'], prefix, errors);
  if (location === null) {
    valid = false;
  }

  const command = validateOptionalString(
    raw['command'],
    `${prefix}.command`,
    errors
  );
  if (command === undefined && raw['command'] !== undefined) {
    valid = false;
  }

  const tool = validateVisualTool(raw['tool'], prefix, errors);
  if (tool === undefined && raw['tool'] !== undefined) {
    valid = false;
  }

  const credentials = validateVisualCredentials(
    raw['credentials'],
    prefix,
    errors
  );
  if (credentials === undefined && raw['credentials'] !== undefined) {
    valid = false;
  }

  if (!valid || location === null) {
    return null;
  }

  const result: VisualEntry = { location };
  if (command !== undefined) result.command = command;
  if (tool !== undefined) result.tool = tool;
  if (credentials !== undefined) result.credentials = credentials;
  return result;
}

/**
 * Validates the required `location` field on a `VisualEntry`.
 *
 * @param raw - Raw value.
 * @param prefix - Error-path prefix of the parent entry.
 * @param errors - Mutable error accumulator.
 * @returns The validated location string, or `null` when invalid.
 */
function validateVisualLocation(
  raw: unknown,
  prefix: string,
  errors: string[]
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push(`${prefix}.location: required non-empty string`);
    return null;
  }
  const sepIdx = raw.indexOf('://');
  if (sepIdx === -1) {
    errors.push(
      `${prefix}.location: invalid scheme — expected one of ${VISUAL_SCHEMES.join(', ')}`
    );
    return null;
  }
  const scheme = raw.slice(0, sepIdx);
  if (!(VISUAL_SCHEMES as readonly string[]).includes(scheme)) {
    errors.push(
      `${prefix}.location: invalid scheme "${scheme}" — expected one of ${VISUAL_SCHEMES.join(', ')}`
    );
    return null;
  }
  return raw;
}

/**
 * Validates an optional string field without additional constraints.
 *
 * Returns `undefined` when the field is absent. Emits an error and
 * returns `undefined` when present but not a string.
 */
function validateOptionalString(
  raw: unknown,
  prefix: string,
  errors: string[]
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`${prefix}: must be a string`);
    return undefined;
  }
  return raw;
}

/**
 * Validates the optional `tool` field on a `VisualEntry`.
 *
 * Requires `<name>@<path>` format per {@link TOOL_PATTERN}. The install
 * path segment must not contain raw `..` segments (NFR-08 shape check).
 *
 * @param raw - Raw value.
 * @param prefix - Error-path prefix of the parent entry.
 * @param errors - Mutable error accumulator.
 * @returns The validated tool spec verbatim, or `undefined` when absent
 *   or invalid.
 */
function validateVisualTool(
  raw: unknown,
  prefix: string,
  errors: string[]
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`${prefix}.tool: must be a string`);
    return undefined;
  }
  const match = TOOL_PATTERN.exec(raw);
  if (!match) {
    errors.push(
      `${prefix}.tool: malformed — expected "<name>@<path>" with a non-empty path`
    );
    return undefined;
  }
  if (containsDotDotSegment(match[1])) {
    errors.push(
      `${prefix}.tool: install path must not contain ".." segments`
    );
    return undefined;
  }
  return raw;
}

/**
 * Validates the optional `credentials` field on a `VisualEntry`.
 *
 * Only shape-level checks happen here (string type, raw `..` rejection).
 * Realpath containment is enforced by the post-compose pass in
 * `plugin-compositor.ts::validateVisualsPaths` where `projectDir` is
 * available.
 *
 * @param raw - Raw value.
 * @param prefix - Error-path prefix of the parent entry.
 * @param errors - Mutable error accumulator.
 * @returns The validated path verbatim, or `undefined` when absent or
 *   invalid.
 */
function validateVisualCredentials(
  raw: unknown,
  prefix: string,
  errors: string[]
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push(`${prefix}.credentials: must be a non-empty string`);
    return undefined;
  }
  if (containsDotDotSegment(raw)) {
    errors.push(
      `${prefix}.credentials: must not contain ".." segments (escapes projectDir)`
    );
    return undefined;
  }
  return raw;
}

/**
 * True when a path contains a raw `..` segment.
 *
 * Normalises backslashes to forward slashes first so Windows-style paths
 * are caught consistently with POSIX-style paths. A segment matches when
 * it equals the literal `..` — `.../foo/../bar`, `foo/..`, `../foo`, and
 * `..` all return `true`; `..foo` and `foo..` do not.
 *
 * @param value - Path string to scan.
 * @returns `true` when any segment equals `..`, otherwise `false`.
 */
function containsDotDotSegment(value: string): boolean {
  const normalised = value.replace(/\\/g, '/');
  return normalised.split('/').some((segment) => segment === '..');
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

  if (raw['rules'] !== undefined) {
    const rules = validateTaskRules(raw['rules'], errors);
    if (rules !== null) {
      config.rules = rules;
    }
  }

  return config;
}

/** Regex for rule references `<plugin>:<rule-name>` — no wildcard alternation. */
const RULE_INCLUDE_PATTERN = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/** Regex for shape-validating role triples `<org>:<team>:<role>`. */
const ROLE_TRIPLE_PATTERN = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/**
 * Validates the optional `tasks.rules` block and its `include:` array.
 *
 * Each entry carries `rule: "<plugin>:<rule-name>"` plus exactly one of
 * `skip:` or `run:` (both or neither is invalid). Every triple in
 * `skip` / `run` is shape-validated against `ROLE_TRIPLE_PATTERN` at
 * parse time; triple existence against the composed orgs tree is
 * verified later by `resolveTaskRuleIncludes`.
 *
 * @param raw - Raw value found under `tasks.rules` in the YAML tree.
 * @param errors - Mutable accumulator for user-visible validation errors.
 * @returns The parsed block, or null when parsing failed.
 */
function validateTaskRules(
  raw: unknown,
  errors: string[]
): { include: TaskRuleIncludeRef[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('tasks.rules: must be an object with an "include" array');
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!('include' in obj)) {
    errors.push('tasks.rules: requires an "include" array');
    return null;
  }
  if (!Array.isArray(obj['include'])) {
    errors.push('tasks.rules.include: must be an array');
    return null;
  }

  const include: TaskRuleIncludeRef[] = [];
  for (let i = 0; i < obj['include'].length; i++) {
    const parsed = validateTaskRuleInclude(obj['include'][i], i, errors);
    if (parsed) {
      include.push(parsed);
    }
  }
  return { include };
}

/**
 * Validates a single `tasks.rules.include[i]` entry.
 *
 * Returns a well-formed `TaskRuleIncludeRef` or null when any error was
 * accumulated for this entry.
 */
function validateTaskRuleInclude(
  rawEntry: unknown,
  index: number,
  errors: string[]
): TaskRuleIncludeRef | null {
  const prefix = `tasks.rules.include[${index}]`;
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    errors.push(`${prefix}: must be an object`);
    return null;
  }
  const entry = rawEntry as Record<string, unknown>;

  const reference = parseRuleReferenceField(entry, prefix, errors);
  const triples = validateSkipRunExclusive(entry, prefix, errors);
  if (!reference || !triples) {
    return null;
  }

  const result: TaskRuleIncludeRef = {
    pluginName: reference.pluginName,
    ruleName: reference.ruleName,
  };
  if (triples.kind === 'skip') {
    result.skip = triples.values;
  } else {
    result.run = triples.values;
  }
  return result;
}

/**
 * Parses the `rule:` field of a single include entry and splits it into
 * `{ pluginName, ruleName }`. Returns null on shape violation.
 */
function parseRuleReferenceField(
  entry: Record<string, unknown>,
  prefix: string,
  errors: string[]
): { pluginName: string; ruleName: string } | null {
  const rule = entry['rule'];
  if (typeof rule !== 'string' || !rule) {
    errors.push(`${prefix}: "rule" must be a non-empty string`);
    return null;
  }
  if (!RULE_INCLUDE_PATTERN.test(rule)) {
    if (rule.includes('*')) {
      errors.push(`${prefix}.rule: invalid reference "${rule}" — wildcards are not supported for rule references`);
    } else {
      errors.push(`${prefix}.rule: invalid reference "${rule}" — expected "<plugin>:<rule-name>"`);
    }
    return null;
  }
  const colonIdx = rule.indexOf(':');
  return { pluginName: rule.substring(0, colonIdx), ruleName: rule.substring(colonIdx + 1) };
}

/**
 * Enforces `skip` XOR `run` on one include entry and validates every
 * triple's shape. Returns the kind and values, or null on any error.
 */
function validateSkipRunExclusive(
  entry: Record<string, unknown>,
  prefix: string,
  errors: string[]
): { kind: 'skip' | 'run'; values: RoleTriple[] } | null {
  const hasSkip = 'skip' in entry;
  const hasRun = 'run' in entry;

  if (hasSkip && hasRun) {
    errors.push(
      `${prefix}: "skip" and "run" are mutually exclusive — specify exactly one`
    );
    return null;
  }
  if (!hasSkip && !hasRun) {
    errors.push(
      `${prefix}: requires exactly one of "skip" or "run" (use "skip: []" to skip no roles)`
    );
    return null;
  }

  const kind: 'skip' | 'run' = hasSkip ? 'skip' : 'run';
  const rawList = entry[kind];
  if (!Array.isArray(rawList)) {
    errors.push(`${prefix}.${kind}: must be an array of role triples`);
    return null;
  }

  const values: RoleTriple[] = [];
  let anyInvalid = false;
  for (let i = 0; i < rawList.length; i++) {
    const triple = rawList[i];
    if (typeof triple !== 'string' || !ROLE_TRIPLE_PATTERN.test(triple)) {
      errors.push(
        `${prefix}.${kind}[${i}]: "${String(triple)}" is not a valid role triple "<org>:<team>:<role>"`
      );
      anyInvalid = true;
      continue;
    }
    values.push(triple);
  }
  if (anyInvalid) return null;
  return { kind, values };
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

/** Recognized keys within the inspector block. */
const INSPECTOR_KEYS = new Set(['clarifier']);

/**
 * Validates the optional inspector block in the build file.
 *
 * Returns `null` when omitted. When present, accepts a single optional
 * `clarifier` string field; rejects unknown keys and non-string values.
 */
function validateInspector(
  inspector: unknown,
  errors: string[]
): InspectorConfig | null {
  if (inspector === undefined || inspector === null) {
    return null;
  }

  if (typeof inspector !== 'object' || Array.isArray(inspector)) {
    errors.push('"inspector" must be an object');
    return null;
  }

  const raw = inspector as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!INSPECTOR_KEYS.has(key)) {
      errors.push(`inspector: unrecognized key "${key}"`);
    }
  }

  if (raw['clarifier'] === undefined) {
    return {};
  }

  if (typeof raw['clarifier'] !== 'string') {
    errors.push('inspector.clarifier: must be a string');
    return null;
  }

  return { clarifier: raw['clarifier'] };
}

/** Recognized keys within the dev block. */
const DEV_KEYS = new Set(['command', 'cwd', 'port', 'host']);

/** Minimum TCP port accepted for `dev.port`. */
const DEV_PORT_MIN = 1024;

/** Maximum TCP port accepted for `dev.port`. */
const DEV_PORT_MAX = 65535;

/**
 * Validates the optional top-level `dev` block in the build file.
 *
 * Returns `null` when omitted. When present, requires a non-empty
 * `command` string and accepts optional `cwd`, `port`, and `host` fields.
 * Rejects unknown keys. Port must be an integer in the range
 * {@link DEV_PORT_MIN}–{@link DEV_PORT_MAX}. Errors are appended to the
 * shared aggregator so `parseBuildFile` surfaces every issue at once.
 *
 * @param dev - Raw value read from the YAML tree.
 * @param errors - Mutable array the validator appends messages to.
 * @returns The validated {@link DevConfig}, or `null` when the block is
 *   omitted / invalid in a way that prevents partial construction.
 */
function validateDev(dev: unknown, errors: string[]): DevConfig | null {
  if (dev === undefined || dev === null) return null;
  if (typeof dev !== 'object' || Array.isArray(dev)) {
    errors.push('"dev" must be an object');
    return null;
  }

  const raw = dev as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!DEV_KEYS.has(key)) {
      errors.push(`dev: unrecognized key "${key}"`);
    }
  }

  if (typeof raw['command'] !== 'string' || raw['command'].length === 0) {
    errors.push('dev.command: required non-empty string');
    return null;
  }

  const config: DevConfig = { command: raw['command'] };

  if (raw['cwd'] !== undefined) {
    if (typeof raw['cwd'] !== 'string') {
      errors.push('dev.cwd: must be a string');
    } else {
      config.cwd = raw['cwd'];
    }
  }

  if (raw['port'] !== undefined) {
    const val = Number(raw['port']);
    if (!Number.isInteger(val) || val < DEV_PORT_MIN || val > DEV_PORT_MAX) {
      errors.push(
        `dev.port: must be an integer between ${DEV_PORT_MIN} and ${DEV_PORT_MAX}`
      );
    } else {
      config.port = val;
    }
  }

  if (raw['host'] !== undefined) {
    if (typeof raw['host'] !== 'string') {
      errors.push('dev.host: must be a string');
    } else {
      config.host = raw['host'];
    }
  }

  return config;
}
