<p>
  <img src="./assets/logo-h.png" alt="Forjis" height="80">
</p>

AI-powered software development pipeline that orchestrates multiple specialized LLM agents to execute tasks. Define your team of agents in a single `build.forjis` file and let them collaborate through a structured, multi-layer architecture.

## How It Works

Forjis follows a three-layer architecture:

1. **Resolver** -- parses your `build.forjis` config, resolves plugins from repositories, and produces normalized YAML config files
2. **Facilitator** -- manages the task queue, spawns engine subprocesses, tracks token budgets, and serves the web dashboard
3. **Orchestrator** -- runs inside the LLM subprocess, composes prompts, and dispatches agent roles

```
build.forjis --> [Resolver] --> .forjis/config/*.yaml
                                      |
                                [Facilitator] --> task queue --> engine.invoke()
                                      |                              |
                                [Web Dashboard]              [Orchestrator]
                                                                     |
                                                              Agent dispatch
```

## Quick Start

### Prerequisites

- Node.js >= 20
- npm >= 10
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### Install

```bash
git clone https://github.com/todor-mazgalov/forjis.git
cd forjis/forjis-runtime
npm install
npm run build
```

### Configure

Create a `build.forjis` in your project root:

```yaml
version: 1

repositories:
  - type: git
    url: https://github.com/todor-mazgalov/forjis-plugins.git
    ref: main

plugins:
  - name: software-dev

orgs:
  - name: my-team
    extends: "software-dev:default"

tasks:
  source: dir
  path: ./tasks
```

### Run

```bash
# Run the pipeline
forjis run

# Run with web dashboard
forjis run --web

# Run a specific persona
forjis persona my-persona

# Check status
forjis status
```

## Architecture

The runtime is a TypeScript monorepo with six packages:

```
@forjis/shared          Zero-dep service interfaces and DTOs
@forjis/resolver        Config parsing, plugin composition
@forjis/web             HTTP server, dashboard UI, REST API
@forjis/facilitator     Task queue, engine abstraction, CLI commands
@forjis/cli             Argument parser, entry point
@forjis/orchestrator    Claude Code markdown commands (non-NPM)
```

Build order: `shared -> resolver -> web -> facilitator -> cli`

## Plugin System

Plugins provide reusable agent configurations, skills, hooks, and constraints. They are defined as `.forjis.yaml` files inside repositories and can be extended in your `build.forjis`.

Plugins are maintained in a [separate repository](https://github.com/todor-mazgalov/forjis-plugins).

## License

MIT &copy; Todor Mazgalov &mdash; see [LICENSE](LICENSE) for details.

## Key Features

- **Multi-agent orchestration** -- define teams of specialized agents that collaborate on tasks
- **Plugin architecture** -- extend and compose agent configurations from reusable plugins
- **Task queue** -- directory-based task ingestion with dependency resolution and concurrency control
- **Outcome assessment** -- score task completion against configurable metrics with fail/retry rules
- **Token budgeting** -- rolling-window rate limiting across agent invocations
- **Health monitoring** -- heartbeat-based stuck detection with automatic retries
- **Web dashboard** -- real-time task progress, event streams, and resource inspection via REST API

## CLI Commands

| Command | Description |
|---------|-------------|
| `forjis run` | Run the pipeline on pending tasks |
| `forjis dev` | Start an Inspector dev session (Vite + dashboard + WebSocket) |
| `forjis status` | Show task queue status |
| `forjis stop` | Stop running tasks |
| `forjis validate` | Validate `build.forjis` configuration |
| `forjis persona <name>` | Run a named persona |
| `forjis strategist` | Run the strategist mode |
| `forjis task create <desc>` | Generate a task file from a description |
| `forjis task activate` | Activate draft task files |
| `forjis task clean` | Remove runtime state |
| `forjis task remove` | Remove task files and clean |
| `forjis task nuke` | Remove all task files and clean |
| `forjis context refresh` | Build / update the per-project file index in `.forjis/context/` |
| `forjis rewind <task-id>` | Tear down a task: revert merge, delete branch + state, invalidate caches |
| `forjis assess` | Assess completed task outcomes |
| `forjis init` | Initialize a new project |

## Inspector — pin-driven UI feedback

The Inspector lets you point at any element on a running web page,
attach a comment, and let the Forjis pipeline turn that comment into
a code change. End-to-end flow: pin → clarifier persona → finalized
TASK.md → orchestrator → Developer + Reviewer agents → committed
patch.

### Wire it into a Vite project

1. Add the Vite plugin and the SDK as dev deps:
   ```json
   "devDependencies": {
     "@forjis/inspector": "^0.5.1",
     "@forjis/vite-inspector": "^0.5.1"
   }
   ```
2. Register the plugin in `vite.config.ts`:
   ```ts
   import { defineConfig } from 'vite';
   import { forjisInspector } from '@forjis/vite-inspector';

   export default defineConfig({ plugins: [forjisInspector()] });
   ```
3. Add a `dev:` block to `build.forjis` so `forjis dev` knows how to
   boot Vite:
   ```yaml
   dev:
     command: "npm run dev"
     cwd: "."
     port: 4243
   ```
4. Start the session:
   ```bash
   forjis dev
   ```
   `forjis dev` boots Vite, mounts a WebSocket facilitator on the
   configured port, and prints a session URL + QR code. Open the
   Vite URL in a browser; the Inspector overlay docks bottom-right.
5. Click **Inspect** → choose **Element** or **Region** → double-click
   an element. Type the change you want into the comment sheet and
   click **Send**. Open the queue pill and click **Submit batch** to
   dispatch the pipeline.
6. The clarifier asks 0–N disambiguating questions, then finalizes
   a task in `tasks/inspector-<slug>/`. `forjis run` (or `forjis run
   --web`) picks it up; you'll see the change land on
   `forjis/<task-id>` and merge into `forjis/stage`.

A working example project lives at
[`examples/forjis-inspector-example`](https://github.com/todor-mazgalov/forjis-inspector-example) (separate repo).

## Task rules — collapse the pipeline for micro-changes

Many inspector pins boil down to a single text or style tweak — the
full Setup → Architect → Developer ↔ Reviewer → Finish pipeline is
overkill. **Task rules** are project-included presets that match a
task title with a regex and skip pre-implementation stages while
prepending agent-prompt hints.

Plugin author declares the rule (matcher + prompt-prepend, no role
references):

```yaml
# plugins/software-dev.forjis.yaml
rules:
  - name: text-rename
    matches:
      task_title: "^(rename|change) .+ (to|from)\\s+"
    developer:
      prompt_prepend: |
        Pure text-node rename. Locate the target with a single
        search, Edit in place, verify the project's existing
        build / type-check command still passes.
```

Project includes the rule and supplies the role list:

```yaml
# build.forjis
tasks:
  source: dir
  path: ./tasks
  rules:
    include:
      - rule: software-dev:text-rename
        skip:                              # OR `run:` (mutually exclusive)
          - my-org:Frontend:Explorer
          - my-org:Frontend:Analyst
          - my-org:Frontend:Architect
```

When a task title matches `text-rename`, the orchestrator's Step 5b
flips Explorer / Analyst / Architect to `status: skipped` with
`justification: "rule:text-rename"` and the Developer prompt picks
up the `prompt_prepend` body.

## Role visuals — give any role pixels

`visuals:` on a role declares one or more visual sources the
facilitator surfaces in the role's prompt. The agent reads files
with `Read`, fetches URLs with `Bash`+`curl`, and runs declared
capture tools via `Bash` if it wants screenshots.

```yaml
# build.forjis or plugin orgs
- name: Reviewer
  agent: forjis-frontend-reviewer
  visuals:
    - location: http://localhost:5173        # live URL
      command: npm run dev                   # boot if probe fails
      tool: playwright@.                     # capture-tool hint
    - location: https://staging.internal/preview
      credentials: .forjis/secrets/staging.env   # auth file (untracked)
      tool: playwright@.
    - location: file://./design/mockups/*.png    # static design refs
```

Behavior:
- The facilitator probes each `location` with `curl -sI`. If a
  probe fails and `command` is set, it boots the command, retries,
  and tears it down at the end of the role invocation.
- `tool: <name>@<path>` is a hint — facilitator never invokes the
  tool itself, the agent does. v1 surfaces `playwright`.
- `credentials:` paths are surfaced as pointers; contents are never
  read or logged by the facilitator.
- Pin assets from the current task (Inspector) auto-flow to a role
  ONLY when that role declared at least one `visuals:` entry. Roles
  with no `visuals:` are unchanged.

## Context cache — file-level project index

`forjis context refresh` builds and updates two artefacts under
`.forjis/context/`:

| File | Purpose |
|---|---|
| `tree.yaml` | One entry per tracked file: `{path, oid, summary}` (one-sentence per file) |
| `index.md` | Plain-text orient doc the LLM reads in one shot |

Subsequent runs are incremental: only files whose git oid changed
get re-summarized. Auto-refreshes before each task dispatch when
`context.refresh_on_task: true` (default) is set in `build.forjis`:

```yaml
context:
  refresh_on_task: true
  inline_top_n: 20
```

Explorer, Analyst, Architect, and Developer prompts get a "Codebase
index" section with the full `index.md` plus the top N
fuzzy-matched rows of `tree.yaml`. Reviewers don't get the index
(they're already reading specific files).

The exploration cache (`.forjis/exploration/<task-id>.md`) is also
hardened: each entry's frontmatter carries a `files_touched: [{path,
oid}]` list, and a cache hit invalidates if any listed file's oid
has changed since capture. Post-commit hook flips overlapping cache
entries to `status: invalid` automatically.

## `forjis rewind <task-id>` — single-command teardown

When a task run goes wrong, `forjis rewind` cleans up everything in
one shot:

```bash
forjis rewind inspector-001-protocol-contract  # default — interactive prompt
forjis rewind inspector-001 --dry-run          # print plan, execute nothing
forjis rewind inspector-001 --yes              # skip confirmation
forjis rewind inspector-001 --keep-branch      # don't delete the task branch
forjis rewind inspector-001 --purge-task-file  # also remove tasks/<id>.md
forjis rewind inspector-001 --force            # allow on running / dirty / main-merged
```

What it does, depending on the task's state:

| State | Action |
|---|---|
| `queued` | Drop the runtime state dir |
| `running` | Refuse without `--force` |
| `failed` / `done-unmerged` | Delete branch + openspec dir + state dir; invalidate cache |
| `done`, merged to `forjis/stage` | Same + revert the merge commit |
| `done`, merged to `main` | Refuse without `--force` (and an extra-loud confirmation) |

Ancestry-aware: refuses if a later task built on the target's
changes, printing the chain you must rewind first. Idempotent —
running twice is a no-op the second time.

## Documentation

- [Configuration Reference](docs/USAGE.md) -- all `build.forjis` options
- [Architecture](pillars/architecture.md) -- system design and package dependencies
- [Data Model](pillars/data.md) -- schemas for config, state, and runtime data