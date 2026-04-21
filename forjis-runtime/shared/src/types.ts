/**
 * Shared type definitions for the Forjis runtime packages.
 *
 * Contains types that cross the facilitator-web boundary:
 * - TaskStatus and TaskEvent from facilitator
 * - All DTO types and WebServerOptions from web
 *
 * Both original packages re-export these types for backward compatibility.
 */

import type { InspectorTransport } from './inspector-services.js';
import type {
  TaskService,
  PlanService,
  EventService,
  ResourceService,
  ConfigService,
  TokenUsageService,
  FileService,
  PluginFileService,
  TaskFileService,
  ManifestService,
  RuntimeService,
} from './services.js';

// -- Task Types (from facilitator) ------------------------------------------

/** Possible states for a task in the queue. */
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'needs_clarification';

/** A single stream event from agent execution. */
export interface TaskEvent {
  /** ISO 8601 timestamp when the event occurred. */
  timestamp: string;
  /** Event type identifier (e.g., "system", "assistant", "tool_call", "result"). */
  type: string;
  /** Role identifier that produced this event. */
  role: string;
  /** Rendering fallback: human-readable one-line summary of the event. */
  content: string;
  /** Which process stream produced this event. Optional for backward compatibility with historical JSONL. */
  stream?: 'stdout' | 'stderr';
  /** Tool name for tool_call and tool_result events. */
  toolName?: string;
  /** Originating tool_use id — lets clients group a result under its tool_call. */
  parentId?: string;
  /** Structured JSON-serializable body (tool input, tool output) for syntax-highlighted rendering. */
  payload?: unknown;
}

// -- Task List DTO ----------------------------------------------------------

/** A single task in the task list response. */
export interface TaskListItem {
  /** Unique task identifier. */
  id: string;
  /** Current task status. */
  status: TaskStatus;
  /** Task priority (named level or numeric 1-100). */
  priority: string | number;
  /** Task description text. */
  description: string;
  /** Currently executing pipeline stage, or null if not running. */
  currentStage: string | null;
  /** ISO 8601 timestamp when the task was created. */
  created: string;
  /** ISO 8601 timestamp when the task started running, or null. */
  started: string | null;
  /** ISO 8601 timestamp when the task completed, or null. */
  completed: string | null;
  /** Ordered branch chain for display, e.g. ["main", "forjis/task-1"]. */
  branches?: string[];
  /** Pipeline progress summary. Populated only when `status === 'running'`;
   *  absent on every other status. Excludes the synthetic orchestrator
   *  pseudo-step from total/done counts. */
  progress?: {
    /** Number of non-orchestrator steps in the plan. */
    total: number;
    /** Number of steps with status `done` or `skipped`. */
    done: number;
    /** Role id of the first running step, or the first non-done/skipped
     *  step when no step is running. Null when all steps are done. */
    current: string | null;
    /** Ordered per-step status array for the progress chain. Matches plan order,
     *  non-orchestrator roles only. Each entry carries the step's `{team, role}`
     *  so the UI can render the two-tone `role @ team` label (`fix-roles-display`);
     *  historical records without `team` fall back to the bare role name. */
    steps: {
      role: string;
      team?: string;
      status: 'done' | 'running' | 'planned' | 'skipped';
    }[];
  };
}

// -- Pipeline Plan DTOs -----------------------------------------------------

/** Pipeline execution plan for a task. */
export interface PipelinePlanResponse {
  /** The task this plan belongs to. */
  taskId: string;
  /** Name of the selected org, or null if no org selected. */
  orgName: string | null;
  /** Name of the selected team, or null if no team selected. */
  teamName: string | null;
  /** Ordered list of pipeline steps. */
  steps: PipelineStep[];
  /** Plan lifecycle: evaluating while orchestrator decides roles, ready when steps are final. */
  status?: 'evaluating' | 'ready';
  /** Max retries per role from health check config. For dashboard display. */
  maxRetries?: number;
}

/** A single step in the pipeline plan. */
export interface PipelineStep {
  /** Organisation name this step belongs to. Together with `team` and `role`
   *  forms the structured identity used to look up the resolved `RuntimeRole`.
   *  The orchestrator writes this as a discrete YAML field — never as part of
   *  a composite string. */
  org: string;
  /** Team name this step belongs to. See `org` for the identity contract. */
  team: string;
  /** Bare role name — must match the resolved config's role name exactly.
   *  No composite `team:role` or `org:team:role` strings, no display-format
   *  `role @ team`. Use `formatRoleDisplay` from `@forjis/shared` for any
   *  user-visible rendering. */
  role: string;
  /** Source plugin name when the role originates from a plugin (e.g.
   *  "software-dev"). Absent for project-local roles. Carried for diagnostic
   *  clarity — not part of the identity used to match against the runtime
   *  config. */
  plugin?: string;
  /** Agent name assigned to this role. */
  agent: string;
  /** Current status of this step. */
  status: 'planned' | 'running' | 'done' | 'skipped';
  /** Human-readable description of the role purpose. */
  description: string;
  /** Score from orchestrator evaluation (0-100). */
  score?: number;
  /** Orchestrator decision. "started" = role invoked, "skipped" = bypassed by weight/flag, "pending" = not yet evaluated. */
  decision?: 'started' | 'skipped' | 'pending';
  /** Short justification for the decision. Preserved across historical data. */
  justification?: string;
  /** ISO 8601 timestamp when this step started running. */
  startedAt?: string;
  /** ISO 8601 timestamp when this step completed. */
  completedAt?: string;
  /** Number of health-check retries for this step. Absent or 0 means never retried. */
  retryCount?: number;
  /** True when this step has been halted due to exceeding max retries. */
  halted?: boolean;
  /** Step ids (each is another step's `role`) this step depends on. Optional;
   *  absent or empty means this step is a root in the dependency graph. */
  deps?: string[];
  /** Discriminator: `orchestrator` for the synthetic head node injected by
   *  plan-writer; `unresolved` for a role entry the orchestrator wrote to
   *  pipeline-state.yaml whose `(org, team, role)` triple does not exist in
   *  the resolved config (e.g. a system agent like `Setup` or a typo). These
   *  steps are kept in the plan for dashboard visibility with a `warning:`
   *  field, but the strict plan parser and runtime dispatcher skip them;
   *  `role` (default) for normal pipeline-state.yaml roles. Absent on
   *  historical pipeline-plan.yaml — readers MUST treat absence as `role`. */
  kind?: 'orchestrator' | 'unresolved' | 'role';
  /** Human-readable warning attached to a step that was flagged during plan
   *  sync (e.g. unresolved role, identity drift). Rendered with a warning
   *  indicator in the UI; absent on normal steps. */
  warning?: string;
}

// -- Resource DTOs ----------------------------------------------------------

/** All loaded runtime resources. */
export interface ResourcesResponse {
  /** Loaded organizations with nested teams and roles. */
  orgs: OrgResource[];
  /** Loaded agent resources. */
  agents: AgentResource[];
  /** Loaded skill resources. */
  skills: SkillResource[];
  /** Loaded hook resources. */
  hooks: HookResource[];
  /** Loaded plugin resources. */
  plugins: PluginResource[];
}

/** An organization resource with nested structure. */
export interface OrgResource {
  /** Organization name. */
  name: string;
  /** Source repository name. */
  source: string;
  /** Teams within this organization. */
  teams: TeamResource[];
}

/** A team within an organization resource. */
export interface TeamResource {
  /** Team name. */
  name: string;
  /** Roles within this team. */
  roles: RoleResource[];
}

/** A role within a team resource. */
export interface RoleResource {
  /** Role name. */
  name: string;
  /** Agent assigned to this role (display name). */
  agent: string;
  /** Skills assigned to this role (display names). */
  skills: string[];
  /** Plugin-root-relative path to the agent definition markdown, or empty when unresolved. */
  agentPath: string;
  /** Plugin-root-relative paths to each skill definition markdown. */
  skillPaths: string[];
  /** Plugin-root-relative paths to each hook markdown (pre, validation, post flattened). */
  hookPaths: string[];
  /** Outcome group references attached to this role. */
  outcomePaths: string[];
  /** Persona definition paths attached to this role. Empty when not applicable. */
  personaPaths: string[];
  /** Constraint document paths attached to this role. Empty when not applicable. */
  constraintPaths: string[];
}

/** A named agent resource entry with source. */
export interface AgentResource {
  /** Agent name. */
  name: string;
  /** Source repository name. */
  source: string;
}

/** A skill resource entry. */
export interface SkillResource {
  /** Skill name. */
  name: string;
  /** Source repository name. */
  source: string;
}

/** A hook resource entry. */
export interface HookResource {
  /** Hook name. */
  name: string;
  /** Source repository name. */
  source: string;
}

/** A plugin resource entry. */
export interface PluginResource {
  /** Plugin name. */
  name: string;
  /** Source repository name. */
  source: string;
}

// -- Token Usage DTO --------------------------------------------------------

/** Response shape for the token usage API endpoint. */
export interface TokenUsageResponse {
  /** Cumulative input tokens consumed this session. */
  inputTokens: number;
  /** Cumulative output tokens consumed this session. */
  outputTokens: number;
  /** Total tokens consumed (input + output). */
  totalTokens: number;
  /** ISO 8601 timestamp when the current budget window started. */
  windowStartedAt: string;
  /** ISO 8601 timestamp of the most recent usage snapshot. */
  lastUpdatedAt: string;
  /** Budget configuration if set, or null when no budget is configured. */
  budget: { maxTokens: number; resetWindowMs: number } | null;
  /** Optional per-task token breakdown with per-role detail. */
  perTask?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    perRole?: Record<string, {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>;
  }>;
}

// -- Manifest DTO -----------------------------------------------------------

/** A single file entry in the output manifest. */
export interface ManifestFileEntry {
  /** The pipeline role that produced this file. */
  role: string;
  /** Project-relative path to the output file. */
  path: string;
  /** Short display label for the file. */
  label: string;
  /** ISO 8601 timestamp when the file was created. */
  createdAt?: string;
}

/** Response shape for the manifest API endpoint. */
export interface ManifestResponse {
  /** List of output file entries. */
  files: ManifestFileEntry[];
}

// -- Config DTOs ------------------------------------------------------------

/** A role within a team in the resolved config hierarchy. */
export interface ConfigRole {
  /** Role name. */
  name: string;
  /** Absolute path to the agent file. */
  agent: string;
  /** Absolute paths to skill files. */
  skills: string[];
  /** Hook files organized by lifecycle phase. */
  hooks: {
    pre: string[];
    validation: string[];
    post: string[];
  };
  /** Named outcome group references. */
  outcomes: string[];
  /** Pipeline stage identifier. */
  stage?: string;
  /** Human-readable expertise description. */
  expertise?: string;
}

/** A team within an organization in the resolved config. */
export interface ConfigTeam {
  /** Team name. */
  name: string;
  /** Roles within this team. */
  roles: ConfigRole[];
}

/** An organization in the resolved config. */
export interface ConfigOrg {
  /** Organization name. */
  name: string;
  /** Teams within this organization. */
  teams: ConfigTeam[];
}

/** A persona definition from the resolved config. */
export interface ConfigPersona {
  /** Persona name. */
  name: string;
  /** Short description of the persona. */
  description: string;
  /** Tools available to this persona. */
  tools: string[];
  /** Model identifier, or empty string if not specified. */
  model: string;
  /** Full markdown content of the persona file. */
  content: string;
}

/** A single outcome rule within an outcome group. */
export interface ConfigOutcomeRule {
  /** Metric name this rule evaluates. */
  metric: string;
  /** Comparison operator (e.g. ">=", "<=", "=="). */
  operator: string;
  /** Threshold value for the comparison. */
  threshold: number;
  /** Action to take when the rule triggers. */
  action: string;
}

/** An outcome group definition from the resolved config. */
export interface ConfigOutcomeGroup {
  /** Outcome group name. */
  name: string;
  /** Metrics tracked by this group (name -> description or config). */
  metrics: Record<string, unknown>;
  /** Rules that evaluate metrics and trigger actions. */
  rules: ConfigOutcomeRule[];
}

/** Top-level outcomes configuration. */
export interface ConfigOutcomes {
  /** Default action when no rule matches. */
  defaultAction: string;
  /** Default maximum retries before giving up. */
  defaultMaxRetries: number;
  /** Outcome group definitions. */
  outcomes: ConfigOutcomeGroup[];
}

/** Complete resolved configuration response from the API. */
export interface ConfigResponse {
  /** Organization hierarchy with teams and roles. */
  orgs: {
    version: number;
    orgs: ConfigOrg[];
  };
  /** Constraint text and pillar documents. */
  constraints: {
    mandatory: string;
    optional: string;
    pillars: Array<{ path: string; content: string }>;
  };
  /** Persona definitions. */
  personas: {
    dir: string;
    personas: ConfigPersona[];
  };
  /** Task queue settings. */
  tasks: {
    source?: string;
    path?: string;
    poll_interval?: string;
    max_concurrent?: number;
    auto_dependencies?: boolean;
  };
  /** Health-check monitoring settings. */
  healthCheck: {
    interval: number;
    max_retries: number;
  };
  /** Token budget settings, or empty object when not configured. */
  tokenBudget: Record<string, unknown>;
  /** Outcomes configuration with groups, metrics, and rules. */
  outcomes: ConfigOutcomes;
  /** Absolute path of the target project directory the orchestrator is
   *  operating on. Populated server-side from the process CWD / CLI flag.
   *  The client uses it to derive the TopBar project icon and breadcrumbs;
   *  falls back to hidden / empty state when the field is absent. */
  projectDir?: string;
}

// -- Runtime DTO ------------------------------------------------------------

/** Runtime/process state surfaced to the dashboard status bar.
 *  Distinct from ConfigResponse (which is YAML-on-disk state). */
export interface RuntimeResponse {
  /** @forjis/orchestrator package version, read at startup. */
  version: string;
  /** Concurrent worker slots: `busy` = tasks currently running,
   *  `max` = configured max_concurrent value. */
  workers: { busy: number; max: number };
  /** Cumulative spend since process start. Absent when no engine has
   *  reported cost — never returned as 0 when unknown. */
  cost?: { total: number; currency: string };
  /** Current branch of the project directory, resolved once at startup
   *  via `git symbolic-ref --short HEAD`. Null when the project is not
   *  a git repo or git is unavailable. */
  gitBranch: string | null;
}

// -- Error Response ---------------------------------------------------------

/** Consistent error envelope for all API error responses. */
export interface ErrorResponse {
  /** Human-readable error message. */
  error: string;
  /** Machine-readable error code. */
  code: string;
  /** Optional additional error details. */
  details?: Record<string, unknown>;
}

// -- Server Options ---------------------------------------------------------

/**
 * Structural contract of the session-metadata record exposed via
 * `SessionTokenRegistryLike.validate(...)`.
 *
 * Mirrors the concrete `SessionMetadata` interface exported from
 * `@forjis/facilitator` (see `session-token.ts`). The facilitator package
 * owns the implementation; this interface lives in `@forjis/shared` so the
 * web server can consume the value without importing from facilitator,
 * preserving the zero-dependency `shared → facilitator` acyclic constraint.
 */
export interface SessionMetadataLike {
  /** Opaque label supplied by the caller at registration time (e.g. "forjis dev session"). */
  readonly label: string;
  /** ISO-8601 timestamp captured when the token was registered. */
  readonly createdAt: string;
}

/**
 * Structural contract of the Inspector session-token registry consumed by
 * the web server's WebSocket upgrade listener.
 *
 * The concrete implementation lives in `@forjis/facilitator` as
 * `SessionTokenRegistry`. Declaring only the `validate` method here keeps
 * the surface minimal — the web server never needs `register`, `revoke`,
 * or the `size` getter — and preserves the zero-dependency
 * `shared → facilitator` acyclic constraint.
 */
export interface SessionTokenRegistryLike {
  /**
   * Validate a session token.
   *
   * @param token - Token value supplied by the upgrading client.
   * @returns Metadata for the registered token, or `null` when the token
   *   is unknown.
   */
  validate(token: string): SessionMetadataLike | null;
}

/** Options for creating the web server. */
export interface WebServerOptions {
  /** Port to listen on. */
  port: number;
  /** Host address to bind the server to. Defaults to '127.0.0.1'. */
  host?: string;
  /** Pre-shared bearer token. When set, all requests must authenticate. */
  token?: string;
  /** Service implementation for task data access. Implemented by backend layer. */
  taskService: TaskService;
  /** Service implementation for pipeline plan data access. Implemented by backend layer. */
  planService: PlanService;
  /** Service implementation for event data access. Implemented by backend layer. */
  eventService: EventService;
  /** Service implementation for resource data access. Implemented by backend layer. */
  resourceService: ResourceService;
  /** Optional absolute path to the built SolidJS client (typically `client/dist/`). When set, `GET /` and any unknown non-`/api/*` path are served from this directory; missing paths fall back to `index.html` so client-side routing works. `/api/*` routes are unaffected. When unset, all non-`/api/*` routes return 404. */
  clientDir?: string;
  /** Optional service for exposing token usage data. Available when the facilitator wires it up. */
  tokenUsageService?: TokenUsageService;
  /** Optional service for reading OpenSpec change artifact files. Available when the facilitator wires it up. */
  fileService?: FileService;
  /** Optional service for reading plugin `.md` files from whitelisted plugin roots. */
  pluginFileService?: PluginFileService;
  /** Optional service for listing and reading task-directory `.md` files. Available when the facilitator wires it up. */
  taskFileService?: TaskFileService;
  /** Optional service for reading the output file manifest. Available when the facilitator wires it up. */
  manifestService?: ManifestService;
  /** Optional service for reading the resolved config files. Available when the facilitator wires it up. */
  configService?: ConfigService;
  /** Optional service for exposing runtime/process state. Available when
   *  the facilitator wires it up. */
  runtimeService?: RuntimeService;
  /** Absolute path to the target project directory the orchestrator is
   *  operating on. Populated server-side from the CLI `TARGET_PROJECT`
   *  argument / facilitator options. Surfaced to the client via
   *  `/api/config.projectDir` (for the TopBar breadcrumb + project icon)
   *  and consumed by the `/favicon.svg` route for deterministic icon
   *  color. Optional so tests and smoke builds can omit it — downstream
   *  consumers treat a missing value as "unknown project" and fall back
   *  to neutral defaults. */
  projectDir?: string;
  /**
   * Optional Inspector WebSocket transport wiring.
   *
   * When present, the caller has already constructed the transport via
   * `createInspectorWebSocketServer(...)` and `createWebServer` will call
   * `attachInspectorUpgradeListener(server, transport, { tokenRegistry })`
   * before `server.listen(...)`, so the `/inspector/ws` endpoint is
   * guaranteed to handle the very first client connection after `listen`.
   *
   * When absent, the server behaves exactly as today: no upgrade listener
   * is installed, no WebSocket endpoint is exposed, and no `ws` runtime
   * dependency is loaded.
   */
  inspector?: {
    /** WebSocket-backed transport satisfying `InspectorTransport`. */
    transport: InspectorTransport;
    /** Per-session token registry used by the upgrade gate. */
    tokenRegistry: SessionTokenRegistryLike;
  };
}
