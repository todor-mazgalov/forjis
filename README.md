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
| `forjis assess` | Assess completed task outcomes |
| `forjis init` | Initialize a new project |

## Documentation

- [Configuration Reference](docs/USAGE.md) -- all `build.forjis` options
- [Architecture](pillars/architecture.md) -- system design and package dependencies
- [Data Model](pillars/data.md) -- schemas for config, state, and runtime data