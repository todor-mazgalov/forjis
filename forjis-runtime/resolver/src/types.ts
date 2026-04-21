/**
 * Shared type definitions for the @forjis/resolver package.
 *
 * Defines the data structures used across all resolver modules: build file
 * configuration, plugin definitions, runtime configuration, outcome groups,
 * lock file entries, and config result types.
 */

import type { RepoConfig } from './repo/index.js';

// -- Build File Types -------------------------------------------------------

/** Top-level parsed build.forjis structure. */
export interface BuildConfig {
  version: 1;
  /** The engine to use for pipeline execution (e.g., 'claude'). Optional; defaults applied at runtime. */
  engine?: string;
  repositories: RepoConfig[];
  plugins: PluginRef[];
  orgs: OrgDef[];
  tasks: TasksConfig | null;
  outcome: OutcomeConfig | null;
  /** Optional token budget for rate limiting. Null when not configured. */
  tokenBudget: TokenBudgetConfig | null;
  /** Optional constraints configuration. Null when not present. */
  constraints: BuildConstraintsConfig | null;
  /** Optional personas configuration. Null when not present. */
  personas: PersonasConfig | null;
  /** Optional health check configuration. Null when not configured (defaults apply at runtime). */
  healthCheck: HealthCheckConfig | null;
  /** Optional inspector configuration. Null when not present. */
  inspector: InspectorConfig | null;
  /** Optional dev configuration for `forjis dev`. Null when not present. */
  dev: DevConfig | null;
}

/** A reference to a plugin by name. */
export interface PluginRef {
  name: string;
}

/** A user-defined team within an organization in the build file. */
export interface TeamDef {
  name: string;
  extends?: string;
  roles: RoleDef[];
}

/** A user-defined organization in the build file. */
export interface OrgDef {
  name: string;
  extends?: string;
  roles: RoleDef[];
  teams?: TeamDef[];
}

/** A user-defined role within an organization. */
export interface RoleDef {
  name: string;
  agent?: string;
  extends?: string;
  skills?: string[];
  hooks?: RoleHooks;
  /** References to named outcome groups that apply to this role (FR-027). */
  outcomes?: string[];
}

/** Hook configuration for a role, organized by execution phase. */
export interface RoleHooks {
  pre: string[];
  validation: string[];
  post: string[];
}

/** Configuration for the tasks block in build.forjis. */
export interface TasksConfig {
  source?: 'dir';
  path?: string;
  pollIntervalMs: number;
  maxConcurrent?: number;
  autoDependencies: boolean;
}

/** Configuration for the outcome block in build.forjis. */
export interface OutcomeConfig {
  enabled: boolean;
  rules: OutcomeRule[];
  defaultAction: 'halt' | 'retry';
  defaultMaxRetries: number;
  /** Named outcome groups (FR-026). When present, metrics are per-group. */
  groups?: OutcomeGroupDef[];
}

/** A single outcome assessment rule (either fail or warning). */
export interface OutcomeRule {
  type: 'fail' | 'warning';
  expression: string;
  action?: 'halt' | 'retry';
  maxRetries?: number;
}

/** A named outcome group with scoped metrics and rules (FR-026). */
export interface OutcomeGroupDef {
  name: string;
  metrics: Record<string, MetricDef>;
  rules: OutcomeRule[];
}

// -- Constraint Types -------------------------------------------------------

/** A named constraint group defined in a plugin. */
export interface ConstraintGroup {
  /** Unique name within the plugin (e.g., "git", "writing-style"). */
  name: string;
  /** Mandatory constraint text. Empty string if not provided. */
  mandatory: string;
  /** Optional constraint text. Empty string if not provided. */
  optional: string;
}

/** A parsed include reference from build.forjis constraints.include. */
export interface ConstraintIncludeRef {
  /** Plugin name (left side of colon). */
  pluginName: string;
  /** Group name or "*" for wildcard (right side of colon). */
  groupName: string;
}

/** Parsed constraints block from build.forjis. */
export interface BuildConstraintsConfig {
  /** Plugin constraint group includes. */
  include: ConstraintIncludeRef[];
  /** Project-level mandatory constraint text. */
  mandatory: string;
  /** Project-level optional constraint text. */
  optional: string;
  /** File paths to foundational reference documents. */
  pillars: string[];
}

/** A loaded pillar document with its original path and file content. */
export interface PillarEntry {
  /** The original declared file path (not the resolved absolute path). */
  path: string;
  /** The full text content of the pillar file. */
  content: string;
}

/** Configuration for the personas block in build.forjis. */
export interface PersonasConfig {
  /** Path to the personas directory, relative to the project root. */
  dir: string;
}

/**
 * Configuration for the optional `inspector` block in build.forjis.
 *
 * Currently exposes a single field: an override for the default clarifier
 * agent the facilitator spawns when finalizing an Inspector pin batch.
 * Omitting the override falls back to the bundled
 * `forjis-inspector` agent shipped inside `@forjis/facilitator`.
 */
export interface InspectorConfig {
  /**
   * Optional clarifier agent override. When set, treated as either an
   * absolute path or a path relative to the resolved `.forjis/config/`
   * directory. When omitted, the bundled default is used.
   */
  clarifier?: string;
}

/**
 * Configuration for the optional top-level `dev` block in build.forjis.
 *
 * Consumed by the `forjis dev` command to configure the user's dev-server
 * subprocess and the listen address/port of the inspector HTTP/WebSocket
 * server. Every field except `command` is optional; the `forjis dev`
 * command applies CLI overrides on top of these values and layers defaults
 * underneath. Omitting the block is non-fatal and surfaces as `null` on
 * both `BuildConfig.dev` and `RuntimeConfig.dev`.
 */
export interface DevConfig {
  /**
   * Shell command string used to spawn the user's dev server (e.g.
   * "npm run dev"). Required when the block is present; must be a
   * non-empty string.
   */
  command: string;
  /**
   * Optional working directory for the dev-server subprocess. May be an
   * absolute path or a project-relative path; when omitted the command's
   * working directory defaults to the project root at runtime.
   */
  cwd?: string;
  /**
   * Optional override for the HTTP / WebSocket listen port. Must be an
   * integer in the range 1024–65535 when present.
   */
  port?: number;
  /** Optional override for the bind host string. */
  host?: string;
}

/** Final resolved constraints ready for serialization. */
export interface ResolvedConstraints {
  /** All merged mandatory constraint text. */
  mandatory: string;
  /** All merged optional constraint text. */
  optional: string;
  /** Loaded pillar documents with path and content. */
  pillars: PillarEntry[];
}

// -- Plugin Types -----------------------------------------------------------

/** Parsed plugin .forjis.yaml file. */
export interface PluginDef {
  name: string;
  version: string;
  description?: string;
  requires: PluginRequires;
  orgs: PluginOrgDef[];
  pipeline: PluginPipeline | null;
  outcome: PluginOutcomeConfig | null;
  metrics: Map<string, MetricDef>;
  /** Constraint groups defined by this plugin. Defaults to empty array. */
  constraints: ConstraintGroup[];
}

/** Resources that a plugin requires to function. */
export interface PluginRequires {
  agents: string[];
  skills: string[];
  hooks: string[];
}

/** An organization defined within a plugin. */
export interface PluginOrgDef {
  name: string;
  teams: PluginTeamDef[];
}

/** A team within a plugin-defined organization. */
export interface PluginTeamDef {
  name: string;
  roles: PluginRoleDef[];
}

/** A role within a plugin-defined team. */
export interface PluginRoleDef {
  name: string;
  agent: string;
  skills: string[];
  hooks: RoleHooks;
  /** Pipeline stage for custom roles. Standard roles derive stage from agent name. */
  stage?: string;
  /** Human-readable expertise description for weight evaluation. */
  expertise?: string;
  /** References to named outcome groups that apply to this role (FR-027). */
  outcomes?: string[];
}

/** Pipeline defaults defined by a plugin. */
export interface PluginPipeline {
  mode: 'org' | 'swarm' | 'independent';
  finish: 'auto' | 'manual' | 'never';
  maxParallel: number;
  allowedTools: string[];
}

/** Outcome assessment defaults defined by a plugin. */
export interface PluginOutcomeConfig {
  rules: OutcomeRule[];
  defaultAction: 'halt' | 'retry';
  defaultMaxRetries: number;
  /** Named outcome groups defined by this plugin (FR-026). */
  groups?: OutcomeGroupDef[];
}

/** Definition for a custom assessment metric. */
export interface MetricDef {
  description: string;
  criteria: string[];
  scale: string;
  /** Roles this metric applies to. Omit or empty for global (all roles). */
  roles?: string[];
}

// -- Health Check Types ------------------------------------------------------

/** Configuration for heartbeat-based health check monitoring. */
export interface HealthCheckConfig {
  /** Seconds between heartbeat checks. Must be a positive integer. */
  interval: number;
  /** Maximum retries per role before halting the task. Must be a positive integer. */
  maxRetries: number;
}

// -- Token Budget Types -----------------------------------------------------

/** Configuration for session-level token usage rate limiting. */
export interface TokenBudgetConfig {
  /** Maximum token count for the rolling budget window. */
  maxTokens: number;
  /** Duration of the rolling budget window in milliseconds. Default: 3600000 (1 hour). */
  resetWindowMs: number;
}

// -- Runtime Config (post-merge) --------------------------------------------

/** Fully resolved configuration ready for engine delegation. */
export interface RuntimeConfig {
  orgs: RuntimeOrg[];
  metrics: Map<string, MetricDef>;
  outcomeRules: OutcomeRule[];
  outcomeEnabled: boolean;
  defaultAction: 'halt' | 'retry';
  defaultMaxRetries: number;
  pipeline: PluginPipeline | null;
  allowedTools: string[];
  /** Optional token budget for rate limiting. Null when not configured. */
  tokenBudget: TokenBudgetConfig | null;
  /** Resolved common constraints for all agents. Always present. */
  resolvedConstraints: ResolvedConstraints;
  /** Health check configuration. Always present; defaults applied when build config omits it. */
  healthCheck: HealthCheckConfig;
  /** Optional inspector configuration; null when the build file omits the block. */
  inspector: InspectorConfig | null;
  /** Optional dev configuration propagated from `BuildConfig.dev`; null when omitted. */
  dev: DevConfig | null;
}

/** A resolved organization in the runtime config. */
export interface RuntimeOrg {
  name: string;
  teams: RuntimeTeam[];
}

/** A resolved team in the runtime config. */
export interface RuntimeTeam {
  name: string;
  roles: RuntimeRole[];
}

/** A resolved role in the runtime config. */
export interface RuntimeRole {
  /** Bare role name (e.g. "Architect"). No plugin or team prefix; reserved
   *  characters (`:`, `@`, newline, tab) are rejected by the resolver. */
  name: string;
  /** Denormalised parent organisation name. Populated by the resolver at
   *  composition time so downstream consumers (plan parser, event writer)
   *  can look up roles by the `{org, team, role}` identity triple without
   *  walking back up the `RuntimeConfig` tree. Required — empty or
   *  reserved-character values are rejected by the resolver. */
  org: string;
  /** Denormalised parent team name. See `org` for the contract. */
  team: string;
  /** Source plugin name when the role originates from a plugin definition
   *  (e.g. "software-dev"). Absent for project-local roles authored directly
   *  in build.forjis. Carried through pipeline-state / pipeline-plan for
   *  diagnostic clarity; not part of the identity used for lookup. */
  plugin?: string;
  agent: string;
  skills: string[];
  hooks: RoleHooks;
  /** Pipeline stage override (e.g., 'assessor'). */
  stage?: string;
  /** Human-readable expertise description. */
  expertise?: string;
  /** Outcome group names that apply to this role (FR-027). */
  outcomes?: string[];
}

/** Shape of outcome-config.yaml written by engine prepare(). */
export interface OutcomeConfigFile {
  rules: OutcomeRule[];
  metrics: Record<string, MetricDef>;
  defaultAction: 'halt' | 'retry';
  defaultMaxRetries: number;
}

// -- Lock File Types --------------------------------------------------------

/** Snapshot of resolved repositories and plugins for reproducibility. */
export interface LockFile {
  resolved: string;
  repositories: LockRepoEntry[];
  plugins: LockPluginEntry[];
}

/** A resolved repository entry in the lock file. */
export interface LockRepoEntry {
  name: string;
  type: 'git' | 'dir';
  url?: string;
  path?: string;
  ref?: string;
  commit?: string;
  cached: string;
}

/** A resolved plugin entry in the lock file. */
export interface LockPluginEntry {
  name: string;
  source: string;
  version: string;
  checksum: string;
}

// -- Config Result Types (FR-002) -------------------------------------------

/** Result returned by the resolve() entry point. */
export interface ConfigResult {
  /** Files that were written to disk. */
  generated: string[];
  /** Files that were skipped because inputs were unchanged. */
  skipped: string[];
  /** Absolute path to the config output directory. */
  configDir: string;
  /** The fully composed runtime configuration. Available for in-memory consumers (e.g., web dashboard). */
  runtimeConfig: RuntimeConfig;
  /** The resource registry with all resolved resources. Available for in-memory consumers. */
  registry: ResourceRegistry;
  /** Summary of resolved configuration for logging. */
  summary: {
    orgCount: number;
    pluginCount: number;
    roleCount: number;
  };
}

/** Options for the resolve() entry point. */
export interface ResolveOptions {
  /** Override project directory (defaults to dirname of buildFilePath). */
  projectDir?: string;
  /** Override cache root for repository resolution. */
  cacheRoot?: string;
}

// -- Plugin Lock File Types (FR-029) ----------------------------------------

/** A single entry in the plugin lock file. */
export interface PluginLockEntry {
  name: string;
  version: string;
  source: string;
  checksum: string;
}

/** Shape of .forjis/resolved/plugins.lock.yaml. */
export interface PluginLockFile {
  /** ISO timestamp when the lock file was generated. */
  resolvedAt: string;
  /** Resolver version that generated this lock file. */
  resolverVersion: string;
  plugins: PluginLockEntry[];
}

// -- Resolved Resource Type -------------------------------------------------

/** A resource resolved from the registry with its file content. */
export interface ResolvedResource {
  /** Resource name (e.g., 'forjis-explorer'). */
  name: string;
  /** Resource type. */
  type: 'agent' | 'skill' | 'hook';
  /** Absolute path to the source file. */
  sourcePath: string;
  /** File content as UTF-8 string. */
  content: string;
}

// -- Writer Types -----------------------------------------------------------

/** Shared context passed to all config writers. */
export interface WriterContext {
  /** Absolute path to the project directory. */
  projectDir: string;
  /** Absolute path to .forjis/config/. */
  configDir: string;
  /** The fully composed runtime configuration. */
  config: RuntimeConfig;
  /** The parsed build configuration (for fields not in RuntimeConfig). */
  buildConfig: BuildConfig;
  /** Resource registry for path resolution. */
  registry: ResourceRegistry;
  /** Current checksum cache entries (mutable, writers add their entries). */
  cacheEntries: Record<string, ChecksumEntry>;
  /** Previous checksum cache for comparison (may be null). */
  previousCache: ChecksumCache | null;
  /** Loaded plugin definitions (used by constraints writer for provenance). */
  plugins: PluginDef[];
}

/** Result returned by a single config writer. */
export interface WriteResult {
  /** Relative path of the config file (e.g., "orgs.yaml"). */
  file: string;
  /** Whether the file was written (true) or skipped due to cache (false). */
  written: boolean;
}

// -- Checksum Cache Types ---------------------------------------------------

/** A single entry in the checksum cache. */
export interface ChecksumEntry {
  /** SHA-256 hex digest of the source content. */
  sourceHash: string;
  /** Paths of files generated from this source (relative to projectDir). */
  targetPaths: string[];
  /** ISO timestamp of when this entry was last generated. */
  generatedAt: string;
}

/** Shape of the checksums.json file. */
export interface ChecksumCache {
  /** Identifier for the cache owner. Always "resolver" in this package. */
  owner: string;
  /** Cache format version. */
  version: string;
  /** Map of source identifier to cache entry. */
  entries: Record<string, ChecksumEntry>;
}

// Forward import for WriterContext
import type { ResourceRegistry } from './repo/index.js';
