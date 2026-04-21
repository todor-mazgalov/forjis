# Forjis Data Model

## Overview

Five layers:

1. **Build config** — user-authored `build.forjis`
2. **Resolved config** — `.forjis/config/` YAML files
3. **Runtime state** — in-memory `RuntimeConfig`
4. **Task state** — `.forjis/tasks/<id>/`
5. **Lock and cache** — reproducibility metadata

## 1. Build Configuration — `build.forjis`

Single user-authored input. Only `version` and `repositories` required.

```yaml
version: 1
engine: claude
repositories:
  - { type: git, url: ..., ref: main }
  - { type: dir, path: ./local-plugins }
plugins: [{ name: software-dev }]
orgs:
  - name: my-org
    extends: "software-dev:default"
    teams:
      - name: dev-team
        roles:
          - name: Developer
            agent: forjis-developer
            skills: [java, postgre]
            hooks: { pre: [], validation: [code-quality], post: [] }
            outcomes: [default, security]
tasks: { source: dir, path: ./tasks, poll_interval: 5m, max_concurrent: 3, auto_dependencies: true }
outcome:
  enabled: true
  default_action: halt
  default_max_retries: 1
  groups:
    - name: default
      metrics:
        completeness: { description: ..., criteria: [...], scale: "0-100" }
      rules:
        - { type: fail, expression: "completeness < 70", action: halt }
token_budget: { max_tokens: 500000, reset_window: 1h }
constraints:
  include: ["software-dev:git", "software-dev:*"]
  mandatory: |
    Prefix branches with forjis/F-
  optional: ""
  pillars: [pillars/architecture.md]
personas: { dir: ./personas }
health_check: { interval: 300, max_retries: 3 }
```

### Type Definitions

```
BuildConfig {
  version: 1, engine?, repositories: RepoConfig[], plugins: PluginRef[],
  orgs: OrgDef[], tasks?, outcome?, tokenBudget?, constraints?, personas?, healthCheck?
}

RepoConfig = { type: 'git', url, ref } | { type: 'dir', path }

OrgDef { name, extends?, roles? | teams? }    # roles and teams mutually exclusive
TeamDef { name, extends?, roles: RoleDef[] }
RoleDef { name, agent?, extends?, skills?, hooks?: RoleHooks, outcomes?, stage?, expertise? }
RoleHooks { pre, validation, post: string[] }

TasksConfig { source?: 'dir', path?, pollIntervalMs, maxConcurrent?, autoDependencies }
OutcomeConfig { enabled, rules, defaultAction: 'halt'|'retry', defaultMaxRetries, groups? }
OutcomeRule { type: 'fail'|'warning', expression, action?, maxRetries? }
OutcomeGroupDef { name, metrics: Record<string, MetricDef>, rules }
MetricDef { description, criteria: string[], scale, roles? }
TokenBudgetConfig { maxTokens, resetWindowMs }    # Default reset 1h
BuildConstraintsConfig { include: ConstraintIncludeRef[], mandatory, optional, pillars: string[] }
ConstraintIncludeRef { pluginName, groupName }    # groupName "*" = wildcard
PersonasConfig { dir }
HealthCheckConfig { interval, maxRetries }    # interval in seconds
```

### Validation

- Durations: `30s` / `5m` / `1h` → ms
- Include refs: `^([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+|\*)$`
- Task IDs: `^[a-zA-Z0-9_-]+$`
- All errors collected before throwing

## 2. Plugin Definitions — `.forjis.yaml`

Plugins live inside resolved repositories.

```
PluginDef {
  name, version, description?, requires: PluginRequires,
  orgs: PluginOrgDef[], pipeline?: PluginPipeline, outcome?: PluginOutcomeConfig,
  metrics: Map<string, MetricDef>, constraints: ConstraintGroup[]
}
PluginRequires { agents, skills, hooks: string[] }
PluginOrgDef { name, teams: PluginTeamDef[] }
PluginTeamDef { name, roles: PluginRoleDef[] }
PluginRoleDef { name, agent, skills, hooks, stage?, expertise? }
PluginPipeline { mode: 'org'|'swarm'|'independent', finish: 'auto'|'manual'|'never', maxParallel, allowedTools }
PluginOutcomeConfig { rules, defaultAction, defaultMaxRetries }
ConstraintGroup { name, mandatory, optional }
```

### Repository Manifest — `manifest.yaml`

```yaml
name: repo-name
version: "1.0.0"
contents:
  agents: [...]
  skills: [...]
  hooks: [...]
  plugins: [...]
```

## 3. Resolved Config Files — `.forjis/config/`

All paths in resolved files are absolute.

- **`orgs.yaml`** — orgs/teams/roles with absolute paths to agents, skills, hooks
- **`tasks.yaml`** — task source config (defaults: poll 5m, concurrent 3, auto_deps true)
- **`outcomes.yaml`** — outcome groups; `metrics.criteria` serialized as multiline string; `rules[].max_retries` optional
- **`constraints.yaml`** — merged mandatory/optional from plugin + user; `pillars` embeds full file content; key omitted when empty
- **`token-budget.yaml`** — `{ max_tokens, reset_window }` or `{}` if unset
- **`health-check.yaml`** — `{ interval, max_retries }`
- **`personas.yaml`** — `personas: [{ name, description, tools, model, content }]`

## 4. Runtime Configuration — In-Memory

Fully composed config returned from `resolve()`.

```
RuntimeConfig {
  orgs: RuntimeOrg[], metrics, outcomeRules, outcomeEnabled,
  defaultAction, defaultMaxRetries, pipeline?, allowedTools,
  tokenBudget?, resolvedConstraints, healthCheck
}
RuntimeOrg { name, teams: RuntimeTeam[] }
RuntimeTeam { name, roles: RuntimeRole[] }
RuntimeRole { name, agent, skills, hooks, stage?, expertise?, outcomes? }    # all paths absolute
ResolvedConstraints { mandatory, optional, pillars: PillarEntry[] }
PillarEntry { path, content }

ConfigResult {
  generated: string[], skipped: string[], configDir,
  runtimeConfig: RuntimeConfig, registry: ResourceRegistry,
  summary: { orgCount, pluginCount, roleCount }
}
```

## 5. Task State — `.forjis/tasks/<taskId>/`

### `TASK.md`
Markdown body + frontmatter `stage: pending`. Written by engine before orchestrator spawn.

### `state.yaml` — managed by TaskQueue
```
TaskState {
  id, status: 'pending'|'queued'|'running'|'done'|'failed'|'needs_clarification',
  priority: 'critical'|'high'|'medium'|'low'|number,
  created, queued?, started?, completed? (ISO 8601),
  source: 'dir'|'cli', dependencies, description,
  retryCount, currentStage?, branches?
}
```

### `pipeline-state.yaml` — orchestrator's source of truth
```yaml
org, team, status: running|done|failed
branches: [...]
roles:
  - { name, agent, status, description, weight, justification }
```

### `pipeline-plan.yaml` — dashboard view (derived from pipeline-state)
```
PipelinePlanResponse {
  taskId, orgName?, teamName?,
  status: 'evaluating'|'ready', maxRetries?, steps: PipelineStep[]
}
PipelineStep {
  role: "org:team:role", agent,
  status: 'planned'|'running'|'done'|'skipped',
  description, weight? (1-100), justification?,
  startedAt?, completedAt?, retryCount?, halted?
}
```

### `events.jsonl` — one JSON object per line
```
TaskEvent { timestamp, type, role, content, stream?: 'stdout'|'stderr' }
```

### `output-files.yaml`
```yaml
files: [{ role, path, label, createdAt }]
```

### `<taskId>.questions.yaml`
```
ClarificationFile {
  task, status: 'awaiting_answers',
  questions: [{ id, question, answer }]   # answer empty until user responds
}
```

## 6. Lock and Cache

### `.forjis/resolved/plugins.lock.yaml`
```
PluginLockFile {
  resolvedAt, resolverVersion,
  plugins: [{ name, version, source (abs path), checksum (SHA-256) }]
}
```

### `.forjis/resolver-cache/checksums.json`
```
ChecksumCache {
  owner: "resolver", version: "1",
  entries: {
    "config:<key>": { sourceHash, targetPaths, generatedAt }
  }
}
```
Keys: `orgs`, `tasks`, `outcomes`, `constraints`, `token-budget`, `health-check`, `personas`.

## 7. Engine Interface

```
EngineInvokeOptions {
  projectDir, taskId, taskDescription, configDir,
  mode?: 'persona'|'strategist'|'assess', modeArgs?,
  dryRun, onEvent?: (TaskEvent) => void
}
EngineResult {
  exitCode, taskId, stage?,
  usage?: { inputTokens, outputTokens, perRole? }
}
```

## 8. Web API Response Types

```
ResourcesResponse { orgs, agents, skills, hooks, plugins }
TokenUsageResponse {
  inputTokens, outputTokens, totalTokens,
  windowStartedAt, lastUpdatedAt,
  budget: { maxTokens, resetWindowMs } | null
}
AssessmentResult {
  task, assessed, scores: Record<string, number>,
  verdict: 'PASS'|'FAIL'|'WARNING'|'ERROR',
  warnings, failures, notes, error?
}
```

## 9. Data Flow

```
build.forjis
   |
   v
[Resolver] parse → resolve repos → load plugins → compose runtime → write configs
   |
   v
.forjis/config/*.yaml + RuntimeConfig + ResourceRegistry
   |
   v
[Facilitator] load config → task queue → per task:
   |
   +-- engine.invoke() → claude subprocess
   |       └── [Orchestrator] read configs → select roles → dispatch agents
   |              ├── pipeline-state.yaml (role statuses)
   |              ├── output-files.yaml (produced files)
   |              └── stdout stream-json events
   |
   +-- plan-writer: pipeline-state → pipeline-plan
   +-- event-writer: stream → events.jsonl
   +-- token-tracker: enforce budget
   +-- health-check: heartbeats, retries
   +-- task-queue: state.yaml transitions
   |
   v
[Web Dashboard] serves plan, events, resources, token-usage via REST
```
