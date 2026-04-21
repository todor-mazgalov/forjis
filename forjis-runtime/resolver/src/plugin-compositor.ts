/**
 * Plugin compositor for @forjis/resolver.
 *
 * Loads plugins from resolved repositories, validates their structure,
 * merges organization and role definitions, applies user extensions and
 * overrides, and produces a unified RuntimeConfig for engine delegation.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ResourceRegistry } from './repo/index.js';

import { RoleIdentityError, validateRoleIdentityShape } from '@forjis/shared';
import { ResolverError, PluginDependencyError, PluginNotFoundError, PluginValidationError } from './errors.js';
import type {
  BuildConfig,
  BuildConstraintsConfig,
  ConstraintGroup,
  ConstraintIncludeRef,
  MetricDef,
  OrgDef,
  OutcomeGroupDef,
  OutcomeRule,
  PillarEntry,
  PluginDef,
  PluginOrgDef,
  PluginOutcomeConfig,
  PluginPipeline,
  PluginRoleDef,
  PluginRequires,
  PluginTeamDef,
  RoleDef,
  ResolvedConstraints,
  RoleHooks,
  RuntimeConfig,
  RuntimeOrg,
  RuntimeRole,
  RuntimeTeam,
  TeamDef,
} from './types.js';

/** Result of loadPlugins: parsed plugin definitions alongside their raw file content. */
export interface LoadedPlugins {
  plugins: PluginDef[];
  /** Map from plugin name to raw YAML content string. */
  rawContents: Map<string, string>;
}

/**
 * Loads all plugins referenced in the build config from the resource registry.
 *
 * For each plugin reference, resolves the plugin file from the registry,
 * reads it, parses it, and verifies its resource dependencies.
 *
 * @param buildConfig - The parsed build configuration.
 * @param registry - The resource registry built from resolved repositories.
 * @returns Parsed and validated plugin definitions together with raw file contents.
 * @throws {PluginNotFoundError} If a referenced plugin is not in the registry.
 * @throws {PluginDependencyError} If a plugin requires unavailable resources.
 */
export async function loadPlugins(
  buildConfig: BuildConfig,
  registry: ResourceRegistry
): Promise<LoadedPlugins> {
  const plugins: PluginDef[] = [];
  const rawContents = new Map<string, string>();

  for (const ref of buildConfig.plugins) {
    let entry;
    try {
      entry = registry.resolve('plugin', ref.name);
    } catch {
      throw new PluginNotFoundError(ref.name);
    }

    const content = await readFile(entry.filePath, 'utf-8');
    const plugin = parsePlugin(content);
    console.log(`[plugin]: loaded "${plugin.name}" v${plugin.version} — ${plugin.orgs.length} orgs, ${plugin.requires.agents.length} agents, ${plugin.requires.skills.length} skills, ${plugin.requires.hooks.length} hooks required`);
    verifyPluginDependencies(plugin, registry);
    console.log(`[plugin]: "${plugin.name}" dependencies verified`);
    plugins.push(plugin);
    rawContents.set(plugin.name, content);
  }

  return { plugins, rawContents };
}

/**
 * Parses and validates a plugin YAML file content into a PluginDef.
 *
 * Validates required fields and normalizes optional fields with defaults.
 *
 * @param content - The raw YAML string of the plugin file.
 * @returns A validated and normalized PluginDef.
 * @throws {PluginValidationError} If the plugin fails validation.
 */
export function parsePlugin(content: string): PluginDef {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PluginValidationError('unknown', `YAML parse error: ${msg}`);
  }

  if (!doc || typeof doc !== 'object') {
    throw new PluginValidationError('unknown', 'Plugin must be a YAML object');
  }

  const raw = doc as Record<string, unknown>;

  if (typeof raw['name'] !== 'string' || !raw['name']) {
    throw new PluginValidationError('unknown', '"name" is required');
  }

  const name = raw['name'];

  if (typeof raw['version'] !== 'string' || !raw['version']) {
    throw new PluginValidationError(name, '"version" is required');
  }

  const requires = parseRequires(raw['requires'], name);
  const orgs = parsePluginOrgs(raw['orgs'], name);
  const pipeline = parsePluginPipeline(raw['pipeline'], name);
  const outcome = parsePluginOutcome(raw['outcome'], name);
  const metrics = parsePluginMetrics(raw['metrics'], name);
  const constraints = parsePluginConstraints(raw['constraints'], name);

  return {
    name,
    version: raw['version'],
    description: raw['description'] != null ? String(raw['description']) : undefined,
    requires,
    orgs,
    pipeline,
    outcome,
    metrics,
    constraints,
  };
}

/**
 * Validates that all resources required by a plugin are available.
 *
 * @param plugin - The plugin definition to check.
 * @param registry - The resource registry to check against.
 * @throws {PluginDependencyError} If any required resources are missing.
 */
export function verifyPluginDependencies(
  plugin: PluginDef,
  registry: ResourceRegistry
): void {
  const missing: string[] = [];

  for (const agent of plugin.requires.agents) {
    try {
      registry.resolve('agent', agent);
    } catch {
      missing.push(`agent:${agent}`);
    }
  }

  for (const skill of plugin.requires.skills) {
    try {
      registry.resolve('skill', skill);
    } catch {
      missing.push(`skill:${skill}`);
    }
  }

  for (const hook of plugin.requires.hooks) {
    try {
      registry.resolve('hook', hook);
    } catch {
      missing.push(`hook:${hook}`);
    }
  }

  if (missing.length > 0) {
    throw new PluginDependencyError(plugin.name, missing);
  }
}

/**
 * Composes all plugins and user config into a unified RuntimeConfig.
 *
 * Merges metrics, organizations, roles, and outcome rules from all plugins,
 * then applies user-defined extensions and overrides from the build config.
 *
 * @param buildConfig - The parsed build configuration.
 * @param plugins - The array of loaded plugin definitions.
 * @param registry - The resource registry for resolving references.
 * @param loadedPillars - Optional pre-loaded pillar documents from resolve().
 * @returns A fully composed runtime configuration.
 */
export function composeRuntime(
  buildConfig: BuildConfig,
  plugins: PluginDef[],
  registry: ResourceRegistry,
  loadedPillars?: PillarEntry[]
): RuntimeConfig {
  const metrics = mergeMetrics(plugins);
  const pluginOrgs = mergePluginOrgs(plugins);
  const userOrgs = applyUserOrgs(buildConfig.orgs, pluginOrgs, plugins);
  const allOrgs = finaliseRuntimeOrgs(userOrgs);
  const outcomeRules = mergeOutcomeRules(plugins, buildConfig);
  const pipeline = plugins.find(p => p.pipeline !== null)?.pipeline ?? null;

  const outcomeEnabled = buildConfig.outcome?.enabled !== false;
  const defaultAction = buildConfig.outcome?.defaultAction
    ?? plugins.find(p => p.outcome)?.outcome?.defaultAction
    ?? 'halt';
  const defaultMaxRetries = buildConfig.outcome?.defaultMaxRetries
    ?? plugins.find(p => p.outcome)?.outcome?.defaultMaxRetries
    ?? 1;

  const allowedTools = mergeAllowedTools(plugins);
  const resolvedConstraints = resolveConstraints(buildConfig.constraints, plugins, loadedPillars);

  return {
    orgs: allOrgs,
    metrics,
    outcomeRules,
    outcomeEnabled,
    defaultAction,
    defaultMaxRetries,
    pipeline,
    allowedTools,
    tokenBudget: buildConfig.tokenBudget ?? null,
    resolvedConstraints,
    healthCheck: buildConfig.healthCheck ?? { interval: 300, maxRetries: 3 },
  };
}

// -- Internal helpers -------------------------------------------------------

/**
 * Finalises a composed `RuntimeOrg[]` by validating names and materialising
 * `org` / `team` onto every role.
 *
 * Walks the tree once and, for each role, sets `role.org` and `role.team`
 * from the parent containers. Validates each source name with
 * `validateRoleIdentityShape`, passing the scoped plugin-prefix (if any) is
 * stripped from the role name for the shape check so internal synthetic
 * `plugin:RoleName` values don't trip the reserved-character guard — the
 * guard is only meaningful against the source-config name the user (or
 * plugin author) actually wrote.
 *
 * @param orgs - The composed RuntimeOrg array with placeholder org/team.
 * @returns The same array with populated org/team and validated names.
 * @throws {ResolverError} When any source name fails shape validation.
 */
function finaliseRuntimeOrgs(orgs: RuntimeOrg[]): RuntimeOrg[] {
  for (const org of orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        role.org = org.name;
        role.team = team.name;

        // Validate against the bare, user-authored role name — the scoped
        // `plugin:` prefix is internal and may legitimately contain a colon.
        const bareRole = unscopedName(role.name);
        try {
          validateRoleIdentityShape({ org: org.name, team: team.name, role: bareRole });
        } catch (err) {
          if (err instanceof RoleIdentityError) {
            throw new ResolverError(
              `Invalid name in resolved config at org="${org.name}" team="${team.name}" role="${role.name}": ${err.message}`,
            );
          }
          throw err;
        }
      }
    }
  }
  return orgs;
}

/** Parses the requires block from a plugin, defaulting arrays to []. */
function parseRequires(raw: unknown, pluginName: string): PluginRequires {
  if (raw === undefined || raw === null) {
    return { agents: [], skills: [], hooks: [] };
  }

  if (typeof raw !== 'object') {
    throw new PluginValidationError(pluginName, '"requires" must be an object');
  }

  const obj = raw as Record<string, unknown>;
  return {
    agents: Array.isArray(obj['agents']) ? obj['agents'].map(String) : [],
    skills: Array.isArray(obj['skills']) ? obj['skills'].map(String) : [],
    hooks: Array.isArray(obj['hooks']) ? obj['hooks'].map(String) : [],
  };
}

/** Parses the orgs array from a plugin. */
function parsePluginOrgs(raw: unknown, pluginName: string): PluginOrgDef[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new PluginValidationError(pluginName, '"orgs" must be an array');
  }

  return raw.map((orgRaw, i) => {
    const org = orgRaw as Record<string, unknown>;
    if (typeof org['name'] !== 'string') {
      throw new PluginValidationError(pluginName, `orgs[${i}]: "name" is required`);
    }

    const teams = parsePluginTeams(org['teams'], pluginName, i);
    return { name: org['name'], teams };
  });
}

/** Parses the teams array within a plugin org. */
function parsePluginTeams(
  raw: unknown,
  pluginName: string,
  orgIndex: number
): PluginTeamDef[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((teamRaw, j) => {
    const team = teamRaw as Record<string, unknown>;
    if (typeof team['name'] !== 'string') {
      throw new PluginValidationError(pluginName, `orgs[${orgIndex}].teams[${j}]: "name" required`);
    }

    const roles = parsePluginRoles(team['roles'], pluginName, orgIndex, j);
    return { name: team['name'], roles };
  });
}

/** Parses the roles array within a plugin team. */
function parsePluginRoles(
  raw: unknown,
  pluginName: string,
  orgIndex: number,
  teamIndex: number
): PluginRoleDef[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((roleRaw, k) => {
    const role = roleRaw as Record<string, unknown>;
    const prefix = `orgs[${orgIndex}].teams[${teamIndex}].roles[${k}]`;

    if (typeof role['name'] !== 'string') {
      throw new PluginValidationError(pluginName, `${prefix}: "name" required`);
    }
    if (typeof role['agent'] !== 'string') {
      throw new PluginValidationError(pluginName, `${prefix}: "agent" required`);
    }

    const hooks: RoleHooks = { pre: [], validation: [], post: [] };
    if (role['hooks'] && typeof role['hooks'] === 'object') {
      const h = role['hooks'] as Record<string, unknown>;
      if (Array.isArray(h['pre'])) hooks.pre = h['pre'].map(String);
      if (Array.isArray(h['validation'])) hooks.validation = h['validation'].map(String);
      if (Array.isArray(h['post'])) hooks.post = h['post'].map(String);
    }

    const stage = typeof role['stage'] === 'string' ? role['stage'] : undefined;
    const expertise = typeof role['expertise'] === 'string' ? role['expertise'] : undefined;
    const outcomes = Array.isArray(role['outcomes']) ? role['outcomes'].map(String) : undefined;

    return {
      name: role['name'],
      agent: role['agent'],
      skills: Array.isArray(role['skills']) ? role['skills'].map(String) : [],
      hooks,
      stage,
      expertise,
      ...(outcomes ? { outcomes } : {}),
    };
  });
}

/** Parses the pipeline block from a plugin. */
function parsePluginPipeline(raw: unknown, pluginName: string): PluginPipeline | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'object') {
    throw new PluginValidationError(pluginName, '"pipeline" must be an object');
  }

  const obj = raw as Record<string, unknown>;
  return {
    mode: (obj['mode'] as PluginPipeline['mode']) ?? 'org',
    finish: (obj['finish'] as PluginPipeline['finish']) ?? 'manual',
    maxParallel: Number(obj['max_parallel'] ?? 4),
    allowedTools: Array.isArray(obj['allowed_tools']) ? obj['allowed_tools'].map(String) : [],
  };
}

/** Parses the outcome block from a plugin. */
function parsePluginOutcome(raw: unknown, pluginName: string): PluginOutcomeConfig | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'object') {
    throw new PluginValidationError(pluginName, '"outcome" must be an object');
  }

  const obj = raw as Record<string, unknown>;
  const rules: OutcomeRule[] = [];

  if (Array.isArray(obj['rules'])) {
    for (const ruleRaw of obj['rules']) {
      const r = ruleRaw as Record<string, unknown>;
      const hasFail = 'fail' in r;
      rules.push({
        type: hasFail ? 'fail' : 'warning',
        expression: String(hasFail ? r['fail'] : r['warning']),
        action: r['action'] as OutcomeRule['action'],
        maxRetries: r['max_retries'] != null ? Number(r['max_retries']) : undefined,
      });
    }
  }

  const groups = parsePluginOutcomeGroups(obj['groups'], pluginName);

  return {
    rules,
    defaultAction: (obj['default_action'] as 'halt' | 'retry') ?? 'halt',
    defaultMaxRetries: Number(obj['default_max_retries'] ?? 1),
    ...(groups ? { groups } : {}),
  };
}

/**
 * Parses outcome groups from a plugin's outcome block.
 *
 * Each group has a name, a metrics record, and a rules array.
 * Returns undefined when the groups field is absent.
 */
function parsePluginOutcomeGroups(
  raw: unknown,
  pluginName: string
): OutcomeGroupDef[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (!Array.isArray(raw)) {
    throw new PluginValidationError(pluginName, '"outcome.groups" must be an array');
  }

  const result: OutcomeGroupDef[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      throw new PluginValidationError(pluginName, `outcome.groups[${i}]: must be an object`);
    }

    if (typeof entry['name'] !== 'string' || !entry['name']) {
      throw new PluginValidationError(pluginName, `outcome.groups[${i}]: "name" is required`);
    }

    const metrics = parseOutcomeGroupMetrics(entry['metrics'], pluginName, i);
    const rules = parseOutcomeGroupRules(entry['rules'], pluginName, i);

    result.push({ name: entry['name'], metrics, rules });
  }

  return result;
}

/**
 * Parses the metrics record within a plugin outcome group.
 */
function parseOutcomeGroupMetrics(
  raw: unknown,
  pluginName: string,
  groupIndex: number
): Record<string, MetricDef> {
  const result: Record<string, MetricDef> = {};

  if (raw === undefined || raw === null) {
    return result;
  }

  if (typeof raw !== 'object') {
    throw new PluginValidationError(
      pluginName,
      `outcome.groups[${groupIndex}].metrics: must be an object`
    );
  }

  const obj = raw as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    const m = value as Record<string, unknown>;
    const prefix = `outcome.groups[${groupIndex}].metrics.${key}`;

    if (typeof m['description'] !== 'string') {
      throw new PluginValidationError(pluginName, `${prefix}: "description" required`);
    }
    if (!Array.isArray(m['criteria'])) {
      throw new PluginValidationError(pluginName, `${prefix}: "criteria" must be an array`);
    }
    if (typeof m['scale'] !== 'string') {
      throw new PluginValidationError(pluginName, `${prefix}: "scale" required`);
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
 * Parses the rules array within a plugin outcome group.
 */
function parseOutcomeGroupRules(
  raw: unknown,
  pluginName: string,
  groupIndex: number
): OutcomeRule[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new PluginValidationError(
      pluginName,
      `outcome.groups[${groupIndex}].rules: must be an array`
    );
  }

  const rules: OutcomeRule[] = [];

  for (const ruleRaw of raw) {
    const r = ruleRaw as Record<string, unknown>;
    const hasFail = 'fail' in r;
    rules.push({
      type: hasFail ? 'fail' : 'warning',
      expression: String(hasFail ? r['fail'] : r['warning']),
      action: r['action'] as OutcomeRule['action'],
      maxRetries: r['max_retries'] != null ? Number(r['max_retries']) : undefined,
    });
  }

  return rules;
}

/** Parses custom metrics from a plugin. */
function parsePluginMetrics(raw: unknown, pluginName: string): Map<string, MetricDef> {
  const metrics = new Map<string, MetricDef>();

  if (raw === undefined || raw === null) {
    return metrics;
  }

  if (typeof raw !== 'object') {
    throw new PluginValidationError(pluginName, '"metrics" must be an object');
  }

  const obj = raw as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    const m = value as Record<string, unknown>;

    if (typeof m['description'] !== 'string') {
      throw new PluginValidationError(pluginName, `metrics.${key}: "description" required`);
    }
    if (!Array.isArray(m['criteria'])) {
      throw new PluginValidationError(pluginName, `metrics.${key}: "criteria" must be an array`);
    }
    if (typeof m['scale'] !== 'string') {
      throw new PluginValidationError(pluginName, `metrics.${key}: "scale" required`);
    }

    const roles = Array.isArray(m['roles']) ? m['roles'].map(String) : undefined;

    metrics.set(key, {
      description: m['description'],
      criteria: m['criteria'].map(String),
      scale: m['scale'],
      roles,
    });
  }

  return metrics;
}

/** Merges metrics from all plugins. Later plugins overwrite earlier on collision. */
function mergeMetrics(plugins: PluginDef[]): Map<string, MetricDef> {
  const merged = new Map<string, MetricDef>();
  for (const plugin of plugins) {
    for (const [key, value] of plugin.metrics) {
      merged.set(key, value);
    }
  }
  return merged;
}

/** Converts plugin orgs into RuntimeOrg structures with scoped role names. */
function mergePluginOrgs(plugins: PluginDef[]): RuntimeOrg[] {
  const result: RuntimeOrg[] = [];

  for (const plugin of plugins) {
    for (const org of plugin.orgs) {
      const teams: RuntimeTeam[] = org.teams.map(team => ({
        name: team.name,
        roles: team.roles.map(role => ({
          name: `${plugin.name}:${role.name}`,
          // `org` and `team` are populated by finaliseRuntimeOrgs() once
          // composition is complete; keeping placeholders here lets every
          // intermediate copy/override helper stay unchanged.
          org: '',
          team: '',
          agent: role.agent,
          skills: [...role.skills],
          hooks: { ...role.hooks },
          ...(role.stage ? { stage: role.stage } : {}),
          ...(role.expertise ? { expertise: role.expertise } : {}),
          ...(role.outcomes ? { outcomes: [...role.outcomes] } : {}),
        })),
      }));

      result.push({ name: org.name, teams });
    }
  }

  return result;
}

/**
 * Applies user-defined orgs, handling extends and role overrides.
 *
 * Orgs with `extends` copy the base plugin org and overlay user roles.
 * Roles with `extends` find the matching plugin role and override specified fields.
 */
function applyUserOrgs(
  userOrgs: OrgDef[],
  pluginOrgs: RuntimeOrg[],
  plugins: PluginDef[]
): RuntimeOrg[] {
  const result: RuntimeOrg[] = [];

  for (const userOrg of userOrgs) {
    if (userOrg.extends) {
      const baseOrg = findPluginOrg(userOrg.extends, pluginOrgs);
      if (!baseOrg) {
        throw new ResolverError(`Org "${userOrg.name}" extends "${userOrg.extends}" which was not found`);
      }

      const extended = deepCopyOrg(baseOrg);
      extended.name = userOrg.name;
      applyUserRoles(extended, userOrg.roles, plugins);
      result.push(extended);
    } else if (userOrg.teams && userOrg.teams.length > 0) {
      const teams = buildUserTeams(userOrg.teams, pluginOrgs, plugins, userOrg.name);
      result.push({ name: userOrg.name, teams });
    } else {
      const teams: RuntimeTeam[] = [];
      if (userOrg.roles.length > 0) {
        const roles = userOrg.roles.map(r =>
          buildUserRole(r, plugins, `${userOrg.name}:default:${r.name}`)
        );
        teams.push({ name: 'default', roles });
      }
      result.push({ name: userOrg.name, teams });
    }
  }

  return result;
}

/**
 * Builds RuntimeTeam[] from user-defined TeamDef[].
 *
 * For teams without extends, roles are built directly. For teams with extends,
 * the referenced plugin team is deep-copied and user roles are overlaid.
 */
function buildUserTeams(
  userTeams: TeamDef[],
  pluginOrgs: RuntimeOrg[],
  plugins: PluginDef[],
  orgName: string
): RuntimeTeam[] {
  return userTeams.map(userTeam => {
    if (userTeam.extends) {
      return buildExtendedTeam(userTeam, pluginOrgs, plugins, orgName);
    }
    const roles = userTeam.roles.map(r =>
      buildUserRole(r, plugins, `${orgName}:${userTeam.name}:${r.name}`)
    );
    return { name: userTeam.name, roles };
  });
}

/**
 * Builds a RuntimeTeam from a user team that extends a plugin team.
 *
 * Deep-copies the plugin team, renames it, and applies user role overrides.
 */
function buildExtendedTeam(
  userTeam: TeamDef,
  pluginOrgs: RuntimeOrg[],
  plugins: PluginDef[],
  orgName: string
): RuntimeTeam {
  const baseTeam = findPluginTeam(userTeam.extends!, pluginOrgs);
  if (!baseTeam) {
    throw new ResolverError(
      `Team "${userTeam.name}" in org "${orgName}" extends "${userTeam.extends}" which was not found`
    );
  }
  const copied = deepCopyTeam(baseTeam);
  copied.name = userTeam.name;
  applyUserTeamRoles(copied, userTeam.roles, plugins);
  return copied;
}

/**
 * Finds a plugin team by reference string.
 *
 * Supports two formats:
 * - 3-part `plugin:orgName:teamName`
 * - 2-part `orgName:teamName`
 */
function findPluginTeam(
  extendsRef: string,
  pluginOrgs: RuntimeOrg[]
): RuntimeTeam | null {
  const parts = extendsRef.split(':');

  if (parts.length === 3) {
    const orgName = parts[1];
    const teamName = parts[2];
    const org = pluginOrgs.find(o => o.name === orgName);
    return org?.teams.find(t => t.name === teamName) ?? null;
  }

  if (parts.length === 2) {
    const orgName = parts[0];
    const teamName = parts[1];
    const org = pluginOrgs.find(o => o.name === orgName);
    return org?.teams.find(t => t.name === teamName) ?? null;
  }

  return null;
}

/** Deep copies a RuntimeTeam to avoid mutating the original. */
function deepCopyTeam(team: RuntimeTeam): RuntimeTeam {
  return {
    name: team.name,
    roles: team.roles.map(role => ({
      name: role.name,
      org: role.org,
      team: role.team,
      agent: role.agent,
      skills: [...role.skills],
      hooks: {
        pre: [...role.hooks.pre],
        validation: [...role.hooks.validation],
        post: [...role.hooks.post],
      },
      ...(role.stage ? { stage: role.stage } : {}),
      ...(role.expertise ? { expertise: role.expertise } : {}),
      ...(role.outcomes ? { outcomes: [...role.outcomes] } : {}),
    })),
  };
}

/**
 * Applies user role overrides to a deep-copied team.
 *
 * Matches user roles by unscoped name or explicit extends, then overlays
 * user-specified fields onto the base role.
 */
function applyUserTeamRoles(
  team: RuntimeTeam,
  userRoles: RoleDef[],
  plugins: PluginDef[]
): void {
  for (const userRole of userRoles) {
    if (userRole.extends) {
      const idx = team.roles.findIndex(r => r.name === userRole.extends);
      if (idx !== -1) {
        const base = team.roles[idx];
        team.roles[idx] = {
          name: userRole.name,
          org: base.org,
          team: base.team,
          agent: userRole.agent ?? base.agent,
          skills: userRole.skills ?? [...base.skills],
          hooks: userRole.hooks ?? { ...base.hooks },
          ...(base.stage ? { stage: base.stage } : {}),
          ...(base.expertise ? { expertise: base.expertise } : {}),
          outcomes: userRole.outcomes ?? base.outcomes,
        };
      } else {
        const newRole = buildExtendedRole(userRole, plugins);
        team.roles.push(newRole);
      }
    } else {
      const idx = team.roles.findIndex(r => unscopedName(r.name) === userRole.name);
      if (idx !== -1) {
        const base = team.roles[idx];
        team.roles[idx] = {
          name: base.name,
          org: base.org,
          team: base.team,
          agent: userRole.agent ?? base.agent,
          skills: userRole.skills ?? [...base.skills],
          hooks: userRole.hooks ?? { ...base.hooks },
          ...(base.stage ? { stage: base.stage } : {}),
          ...(base.expertise ? { expertise: base.expertise } : {}),
          outcomes: userRole.outcomes ?? base.outcomes,
        };
      } else {
        const newRole = buildUserRole(userRole, plugins, `team:${team.name}:${userRole.name}`);
        team.roles.push(newRole);
      }
    }
  }
}

/** Finds a plugin org by "pluginName:orgName" reference. */
function findPluginOrg(extendsRef: string, pluginOrgs: RuntimeOrg[]): RuntimeOrg | null {
  const colonIdx = extendsRef.indexOf(':');
  if (colonIdx === -1) {
    return pluginOrgs.find(o => o.name === extendsRef) ?? null;
  }

  const orgName = extendsRef.substring(colonIdx + 1);
  return pluginOrgs.find(o => o.name === orgName) ?? null;
}

/** Deep copies a RuntimeOrg to avoid mutating the original. */
function deepCopyOrg(org: RuntimeOrg): RuntimeOrg {
  return {
    name: org.name,
    teams: org.teams.map(team => ({
      name: team.name,
      roles: team.roles.map(role => ({
        name: role.name,
        org: role.org,
        team: role.team,
        agent: role.agent,
        skills: [...role.skills],
        hooks: {
          pre: [...role.hooks.pre],
          validation: [...role.hooks.validation],
          post: [...role.hooks.post],
        },
        ...(role.stage ? { stage: role.stage } : {}),
        ...(role.expertise ? { expertise: role.expertise } : {}),
        ...(role.outcomes ? { outcomes: [...role.outcomes] } : {}),
      })),
    })),
  };
}

/**
 * Applies user role definitions to an extended org.
 *
 * Matches roles by explicit extends or by unscoped name suffix.
 */
function applyUserRoles(
  org: RuntimeOrg,
  userRoles: RoleDef[],
  plugins: PluginDef[]
): void {
  for (const userRole of userRoles) {
    if (userRole.extends) {
      const found = findAndOverrideRole(org, userRole);
      if (!found) {
        const newRole = buildExtendedRole(userRole, plugins);
        ensureDefaultTeam(org).roles.push(newRole);
      }
    } else {
      const matched = findAndOverrideRoleByName(org, userRole);
      if (!matched) {
        const newRole = buildUserRole(userRole, plugins, `${org.name}:default:${userRole.name}`);
        ensureDefaultTeam(org).roles.push(newRole);
      }
    }
  }
}

/** Finds a role in an org by its scoped name and overrides fields. */
function findAndOverrideRole(
  org: RuntimeOrg,
  userRole: RoleDef
): boolean {
  for (const team of org.teams) {
    const idx = team.roles.findIndex(r => r.name === userRole.extends);
    if (idx !== -1) {
      const base = team.roles[idx];
      team.roles[idx] = {
        name: userRole.name,
        org: base.org,
        team: base.team,
        agent: userRole.agent ?? base.agent,
        skills: userRole.skills ?? [...base.skills],
        hooks: userRole.hooks ?? { ...base.hooks },
        ...(base.stage ? { stage: base.stage } : {}),
        ...(base.expertise ? { expertise: base.expertise } : {}),
        outcomes: userRole.outcomes ?? base.outcomes,
      };
      return true;
    }
  }
  return false;
}

/**
 * Finds a role by unscoped name match and overrides fields.
 */
function findAndOverrideRoleByName(
  org: RuntimeOrg,
  userRole: RoleDef
): boolean {
  for (const team of org.teams) {
    const idx = team.roles.findIndex(r => unscopedName(r.name) === userRole.name);
    if (idx !== -1) {
      const base = team.roles[idx];
      team.roles[idx] = {
        name: base.name,
        org: base.org,
        team: base.team,
        agent: userRole.agent ?? base.agent,
        skills: userRole.skills ?? [...base.skills],
        hooks: userRole.hooks ?? { ...base.hooks },
        ...(base.stage ? { stage: base.stage } : {}),
        ...(base.expertise ? { expertise: base.expertise } : {}),
        outcomes: userRole.outcomes ?? base.outcomes,
      };
      return true;
    }
  }
  return false;
}

/** Extracts the unscoped name from a potentially scoped "plugin:Name" string. */
function unscopedName(name: string): string {
  const colonIdx = name.lastIndexOf(':');
  return colonIdx === -1 ? name : name.substring(colonIdx + 1);
}

/** Builds a RuntimeRole from a user role that extends a plugin role. */
function buildExtendedRole(
  userRole: RoleDef,
  plugins: PluginDef[]
): RuntimeRole {
  const base = findPluginRole(userRole.extends!, plugins);
  if (!base) {
    throw new ResolverError(
      `Role "${userRole.name}" extends "${userRole.extends}" which was not found in any plugin`
    );
  }

  return {
    name: userRole.name,
    // `org` and `team` are populated by finaliseRuntimeOrgs() once the full
    // composition has been stitched together.
    org: '',
    team: '',
    agent: userRole.agent ?? base.agent,
    skills: userRole.skills ?? [...base.skills],
    hooks: userRole.hooks ?? { ...base.hooks },
    ...(base.stage ? { stage: base.stage } : {}),
    ...(base.expertise ? { expertise: base.expertise } : {}),
    outcomes: userRole.outcomes ?? (base.outcomes ? [...base.outcomes] : undefined),
  };
}

/** Builds a standalone RuntimeRole from a user role definition. */
function buildUserRole(
  userRole: RoleDef,
  plugins: PluginDef[],
  context?: string
): RuntimeRole {
  if (userRole.extends) {
    return buildExtendedRole(userRole, plugins);
  }

  if (!userRole.agent) {
    throw new ResolverError(
      `Role "${userRole.name}" has no "agent" field${context ? ` (at ${context})` : ''}. ` +
      'Either set "agent" explicitly or use "extends" to inherit from a plugin role.'
    );
  }

  return {
    name: userRole.name,
    // `org` and `team` are populated by finaliseRuntimeOrgs().
    org: '',
    team: '',
    agent: userRole.agent,
    skills: userRole.skills ?? [],
    hooks: userRole.hooks ?? { pre: [], validation: [], post: [] },
    ...(userRole.outcomes ? { outcomes: userRole.outcomes } : {}),
  };
}

/** Finds a plugin role by "pluginName:RoleName" across all plugins. */
function findPluginRole(scopedName: string, plugins: PluginDef[]): PluginRoleDef | null {
  const colonIdx = scopedName.indexOf(':');
  if (colonIdx === -1) {
    return null;
  }

  const pluginName = scopedName.substring(0, colonIdx);
  const roleName = scopedName.substring(colonIdx + 1);

  const plugin = plugins.find(p => p.name === pluginName);
  if (!plugin) {
    return null;
  }

  for (const org of plugin.orgs) {
    for (const team of org.teams) {
      const role = team.roles.find(r => r.name === roleName);
      if (role) {
        return role;
      }
    }
  }

  return null;
}

/** Ensures the org has a "default" team and returns it. */
function ensureDefaultTeam(org: RuntimeOrg): RuntimeTeam {
  let team = org.teams.find(t => t.name === 'default');
  if (!team) {
    team = { name: 'default', roles: [] };
    org.teams.push(team);
  }
  return team;
}

/** Merges allowed tools from all plugins. Union of all tool sets, deduplicated. */
function mergeAllowedTools(plugins: PluginDef[]): string[] {
  const tools = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.pipeline) {
      for (const tool of plugin.pipeline.allowedTools) {
        tools.add(tool);
      }
    }
  }
  return Array.from(tools);
}

/**
 * Merges outcome rules from all plugins with build file rules.
 *
 * Plugin rules form the base. Build file rules are additive.
 */
function mergeOutcomeRules(plugins: PluginDef[], buildConfig: BuildConfig): OutcomeRule[] {
  const ruleMap = new Map<string, OutcomeRule>();

  for (const plugin of plugins) {
    if (plugin.outcome) {
      for (const rule of plugin.outcome.rules) {
        ruleMap.set(rule.expression, { ...rule });
      }
    }
  }

  if (buildConfig.outcome?.enabled === false) {
    return [];
  }

  if (buildConfig.outcome) {
    for (const rule of buildConfig.outcome.rules) {
      const existing = ruleMap.get(rule.expression);
      if (existing) {
        existing.action = rule.action ?? existing.action;
        existing.maxRetries = rule.maxRetries ?? existing.maxRetries;
        existing.type = rule.type;
      } else {
        ruleMap.set(rule.expression, { ...rule });
      }
    }
  }

  return Array.from(ruleMap.values());
}

// -- Constraint parsing and resolution --------------------------------------

/**
 * Parses the constraints block from a plugin YAML file.
 */
function parsePluginConstraints(
  raw: unknown,
  pluginName: string
): ConstraintGroup[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new PluginValidationError(pluginName, '"constraints" must be an array');
  }

  const groups: ConstraintGroup[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      throw new PluginValidationError(pluginName, `constraints[${i}]: must be an object`);
    }

    if (typeof entry['name'] !== 'string' || !entry['name']) {
      throw new PluginValidationError(pluginName, `constraints[${i}]: "name" is required`);
    }

    const name = entry['name'];
    validateGroupUniqueness(name, seenNames, pluginName);
    validateGroupContent(entry, i, pluginName);

    groups.push({
      name,
      mandatory: typeof entry['mandatory'] === 'string' ? entry['mandatory'] : '',
      optional: typeof entry['optional'] === 'string' ? entry['optional'] : '',
    });

    seenNames.add(name);
  }

  return groups;
}

/**
 * Validates that a constraint group name is unique within its plugin.
 */
function validateGroupUniqueness(
  name: string,
  seenNames: Set<string>,
  pluginName: string
): void {
  if (seenNames.has(name)) {
    throw new PluginValidationError(
      pluginName,
      `constraints: duplicate group name "${name}"`
    );
  }
}

/**
 * Validates that a constraint group has at least one of mandatory or optional.
 */
function validateGroupContent(
  entry: Record<string, unknown>,
  index: number,
  pluginName: string
): void {
  const hasMandatory = typeof entry['mandatory'] === 'string' && entry['mandatory'] !== '';
  const hasOptional = typeof entry['optional'] === 'string' && entry['optional'] !== '';

  if (!hasMandatory && !hasOptional) {
    throw new PluginValidationError(
      pluginName,
      `constraints[${index}]: group "${entry['name']}" must have at least one of "mandatory" or "optional"`
    );
  }
}

/**
 * Resolves constraint includes and merges all constraint text.
 *
 * @param buildConstraints - Parsed constraints from build file, or null.
 * @param plugins - Loaded plugin definitions for include resolution.
 * @param loadedPillars - Optional pre-loaded pillar documents.
 * @returns Fully resolved constraints with merged text and pillar content.
 */
function resolveConstraints(
  buildConstraints: BuildConstraintsConfig | null,
  plugins: PluginDef[],
  loadedPillars?: PillarEntry[]
): ResolvedConstraints {
  if (!buildConstraints) {
    return { mandatory: '', optional: '', pillars: loadedPillars ?? [] };
  }

  const mandatoryParts: string[] = [];
  const optionalParts: string[] = [];

  for (const ref of buildConstraints.include) {
    const groups = resolveIncludeRef(ref, plugins);
    for (const group of groups) {
      if (group.mandatory) {
        mandatoryParts.push(group.mandatory);
      }
      if (group.optional) {
        optionalParts.push(group.optional);
      }
    }
  }

  if (buildConstraints.mandatory) {
    mandatoryParts.push(buildConstraints.mandatory);
  }
  if (buildConstraints.optional) {
    optionalParts.push(buildConstraints.optional);
  }

  return {
    mandatory: mandatoryParts.join('\n'),
    optional: optionalParts.join('\n'),
    pillars: loadedPillars ?? [],
  };
}

/**
 * Resolves a single include reference to constraint groups.
 */
function resolveIncludeRef(
  ref: ConstraintIncludeRef,
  plugins: PluginDef[]
): ConstraintGroup[] {
  const plugin = plugins.find(p => p.name === ref.pluginName);

  if (!plugin) {
    throw new ResolverError(
      `constraints.include: plugin "${ref.pluginName}" not found`
    );
  }

  if (ref.groupName === '*') {
    return plugin.constraints;
  }

  const group = plugin.constraints.find(g => g.name === ref.groupName);
  if (!group) {
    throw new ResolverError(
      `constraints.include: group "${ref.groupName}" not found in plugin "${ref.pluginName}"`
    );
  }

  return [group];
}
