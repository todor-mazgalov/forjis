# Forjis Architecture

## System Overview

Forjis is an AI-powered software development pipeline that orchestrates multiple specialized LLM agents (roles) to execute tasks. It follows a three-layer architecture: **Resolver** (configuration), **Facilitator** (orchestration), and **Orchestrator** (execution).

The system runs as a monorepo (`forjis-runtime/`) with six packages built in dependency order.

## Package Dependency Graph

```
@forjis/shared          (zero deps — service interfaces, DTOs)
       |
       +---> @forjis/resolver     (shared — build file parsing, plugin composition, config generation)
       |
       +---> @forjis/web          (shared — HTTP server, dashboard UI, REST API)
       |
       +---> @forjis/facilitator  (shared + resolver — task queue, engine abstraction, CLI commands)
                    |
                    +---> @forjis/cli  (facilitator — argument parser, command dispatch)

@forjis/orchestrator    (non-NPM — .claude/ markdown commands executed by Claude Code CLI)
```

Build order: shared -> resolver -> web -> facilitator -> cli.

## The Three Layers

### Layer 1: Resolver (`@forjis/resolver`)

Single responsibility: transform `build.forjis` + plugin directories into normalized config files under `.forjis/config/`.

**Resolution pipeline:**

1. **Parse** `build.forjis` — validates YAML against strict schema, collects all errors before throwing
2. **Resolve repositories** — git clone or local dir indexing, manifest loading, resource registry construction
3. **Load plugins** — parse `.forjis.yaml` plugin definitions from resolved repositories
4. **Compose runtime** — merge build config + plugin orgs/metrics/constraints/pipeline into a single `RuntimeConfig`
5. **Load pillars** — read pillar document files from disk, embed content
6. **Write config files** — seven writers produce YAML files, each with checksum-based skip-if-unchanged
7. **Write lock file** — `plugins.lock.yaml` for reproducibility

**Config files produced:**

| File | Content |
|------|---------|
| `orgs.yaml` | Org/team/role hierarchy with absolute paths to agent/skill/hook files |
| `tasks.yaml` | Task queue settings (source, path, poll_interval, concurrency) |
| `outcomes.yaml` | Named outcome groups with per-group metrics and rules |
| `constraints.yaml` | Fully merged mandatory + optional constraint text, pillar documents |
| `personas.yaml` | Persona definitions with embedded markdown content |
| `token-budget.yaml` | Token rate limiting settings |
| `health-check.yaml` | Heartbeat monitoring settings |

**Hard rules:**
- Only the resolver writes to `.forjis/config/` — no other component creates or modifies files there
- Only the resolver reads `build.forjis` and plugin directories for configuration data
- Checksum caching ensures idempotent re-runs skip unchanged files

### Layer 2: Facilitator (`@forjis/facilitator`)

Thin orchestration layer. Does NOT build prompts, compose agent content, or resolve plugins. It dispatches work.

**Responsibilities:**

1. **CLI dispatch** — receives commands (`run`, `persona`, `strategist`, `assess`, `init`, `status`, `stop`, `validate`), routes to handlers
2. **Invoke resolver** — calls `resolve()` as the first step of every command that needs config
3. **Task queue management** — scans task directory, manages state transitions, priority ordering, dependency resolution, concurrency control
4. **Engine invocation** — spawns orchestrator subprocess via the engine abstraction, passes config directory path and mode flags
5. **Token tracking** — monitors cumulative token usage within rolling budget windows, pauses execution when threshold exceeded
6. **Health check monitoring** — polls for orchestrator heartbeats, triggers retries on stuck roles
7. **Web dashboard** — serves HTTP API and dashboard UI when `--web` flag is set

**Hard rule:** The facilitator must not construct, compose, or transform any prompt text. All prompt logic lives in the orchestrator commands.

### Layer 3: Orchestrator (`@forjis/orchestrator`)

LLM-executed markdown commands that run inside the Claude Code subprocess. The orchestrator is responsible for all prompt composition and agent dispatch.

**Command routing:**

The entry point is `forjis.md` which parses arguments, detects execution mode, loads constraints, and delegates to the appropriate mode handler:

| Mode | Trigger | Handler |
|------|---------|---------|
| ORG | `orgs.yaml` exists (default) | `forjis-org-mode.md` |
| Swarm | `--swarm` flag | `forjis-swarm-mode.md` |
| Independent | `--agents` or `--skip` flag | `forjis-independent-mode.md` |
| Fallback | no `orgs.yaml` | `forjis-fallback-mode.md` |
| Persona | `--persona` flag | `forjis-persona.md` |
| Strategist | `--strategist` flag | `forjis-strategist.md` |
| Assess | `--assess` flag | `forjis-assess.md` |

**Config injection:** For each role invocation, the orchestrator reads config files from `.forjis/config/`, loads agent/skill/hook markdown from resolved paths in `orgs.yaml`, injects constraints, and composes the full prompt.

**Constraint enforcement:**
- Mandatory constraints are injected as "## Common Mandatory Constraints" with "You MUST follow" language
- Optional constraints are injected as "## Common Optional Constraints" with "You SHOULD follow" language
- Task-specific constraints from `TASK.md` get highest precedence
- Pillar documents are injected as "## Foundational Reference Documents"

## Subprocess Model

The facilitator spawns one Claude Code CLI process per task:

```
facilitator (Node.js process)
    |
    +-- spawn('claude', ['--add-dir', projectDir, '-p', '--verbose', '--output-format', 'stream-json', '-'])
    |       cwd = orchestrator/ directory
    |       stdin = "/forjis [--mode-flags] <projectDir> <taskId>"
    |
    +-- parses stdout stream-json events (system, assistant, user, result)
    +-- tracks token usage per role
    +-- writes PID file for stop/health-check
```

The orchestrator subprocess discovers `.claude/commands/` and `.claude/skills/` from its working directory. It reads config files from `<projectDir>/.forjis/config/` and task files from `<projectDir>/.forjis/tasks/<taskId>/`.

Within the orchestrator, roles are dispatched as Claude Code subagents using the `Agent` tool. Each role invocation includes the full composed prompt with agent content, skills, hooks, constraints, and task description.

## Task Lifecycle

```
                       +-----------+
  dir scan / CLI  ---> |  pending  |
                       +-----+-----+
                             |
                   dependency check
                             |
                       +-----v-----+
                       |  queued   |
                       +-----+-----+
                             |
                   concurrency slot
                             |
                       +-----v-----+
                       |  running  | <-- engine.invoke() spawns orchestrator
                       +-----+-----+
                            / \
                   exit 0 /   \ exit != 0
                         /     \
                  +-----v-+   +-v-------+
                  |  done |   | failed  |
                  +-------+   +---------+
```

Special state: `needs_clarification` — the orchestrator writes a questions file, the facilitator pauses until answers are provided.

## Plugin System

Plugins are defined as `.forjis.yaml` files inside resolved repositories. A plugin declares:

- **requires** — agents, skills, hooks it depends on (must exist in the same or another repository)
- **orgs** — organization/team/role definitions that can be extended by the build file via `extends: "plugin:orgName"`
- **pipeline** — default execution mode, finish behavior, parallelism, allowed tools
- **outcome** — default assessment rules and actions
- **metrics** — custom assessment metrics
- **constraints** — named constraint groups that can be included via `constraints.include` in the build file

The compositor merges plugin definitions with build file overrides: build file orgs can extend plugin orgs, build file roles can override plugin roles, and constraint includes pull specific groups from plugins into the merged mandatory/optional text.

## Event System

The Claude CLI outputs `stream-json` events on stdout. The engine parses these line-by-line:

- **system** — session init (model, tools, cwd)
- **assistant** — model output (text blocks, tool_use blocks)
- **user** — tool results
- **result** — final summary (turns, cost, duration, error status)

Events are forwarded to:
1. Rolling terminal display (last N events)
2. `events.jsonl` file per task (via event-writer)
3. Web dashboard via polling API

## Web Dashboard

The web layer provides a REST API backed by service interfaces defined in `@forjis/shared`:

| Endpoint | Service | Data Source |
|----------|---------|-------------|
| `GET /api/tasks` | TaskService | TaskQueue (state.yaml files) |
| `GET /api/tasks/:id/plan` | PlanService | pipeline-plan.yaml |
| `GET /api/tasks/:id/events` | EventService | events.jsonl |
| `GET /api/resources` | ResourceService | RuntimeConfig + ResourceRegistry |
| `GET /api/token-usage` | TokenUsageService | TokenTracker (in-memory) |
| `GET /api/tasks/:id/manifest` | ManifestService | output-files.yaml |

The `plan-writer` module bridges orchestrator and dashboard: it polls `pipeline-state.yaml` (written by the orchestrator) and converts it to `pipeline-plan.yaml` (read by the dashboard API).

## File System Layout

```
project/
  build.forjis                    # Build configuration (input)
  .forjis/
    config/                       # Resolver output (7 YAML files)
    resolved/
      plugins.lock.yaml           # Plugin lock for reproducibility
    resolver-cache/
      checksums.json              # Change detection cache
    tasks/
      <taskId>/
        TASK.md                   # Task description (written by engine)
        state.yaml                # Task state (managed by facilitator)
        pipeline-state.yaml       # Execution state (written by orchestrator)
        pipeline-plan.yaml        # Dashboard format (written by plan-writer)
        events.jsonl              # Stream events (written by event-writer)
        output-files.yaml         # File manifest (written by orchestrator)
        pid                       # Process ID (transient, cleaned on exit)

forjis-runtime/
  shared/                         # Service interfaces, DTOs
  resolver/                       # Config resolution pipeline
  facilitator/                    # Task queue, engine, CLI commands
  web/                            # HTTP server, dashboard
  cli/                            # Argument parser, entry point
  orchestrator/
    .claude/
      commands/                   # Mode handler markdown files
      skills/                     # Workflow protocol (SKILL.md)
