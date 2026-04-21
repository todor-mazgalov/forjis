---
name: forjis-workflow
description: >
  Forjis development factory workflow protocol. Defines file formats, status
  conventions, feedback mechanisms, and quality standards for the multi-agent
  pipeline. Referenced by all forjis agents.
---

# Forjis Workflow Protocol

## Logging Protocol

All orchestrator outputs and agent status updates MUST use this format:

```
[<actor>]: <action-description>
```

Where `<actor>` is one of:
- `orchestrator` — for mode detection, org/team selection, weight evaluation, pipeline control
- The role name (e.g., `Explorer`, `Developer`, `Reviewer`) — for agent lifecycle events

Required log points for the orchestrator:
- Mode detection, org/team selection, setup check, weight evaluation per role
- Before/after each agent: starting, context loaded, completed with status
- Pipeline completion

Required log points for agents (when acting as an agent):
- Key actions during work (e.g., "exploring codebase", "writing design.md", "running tests")
- Reading input artifacts
- Writing output artifacts
- Status marker written

This logging is critical for the user to understand what the pipeline is doing.

## Architecture

Forjis is a standalone tool. All agents, commands, and skills live in the Forjis
project directory. Target projects receive an `openspec/` directory for both
project configuration and design artifacts, and a `.forjis/` directory for
pipeline metadata.

- **Forjis directory:** Contains `.claude/` with agents, commands, skills. Never modified by agents.
- **Target project:** The external project being worked on. Agents `cd` into it,
  read/write source code there, and store pipeline metadata in `<target>/.forjis/tasks/<task-id>/`.
- **OpenSpec:** Project configuration lives in `<target>/openspec/config.yaml`.
  The Setup agent creates the OpenSpec change via the `openspec` CLI.
  The Analyst writes requirements as a spec artifact in `<target>/openspec/changes/<task-id>/specs/`.
  The Architect creates design artifacts (proposal, design, tasks) in the same change.
  The Developer and Reviewer read these artifacts.
  The `openspec` CLI must be available on PATH in the target project.

Every agent receives `TARGET_PROJECT` (absolute path) and `TASK_ID` as context.

## Agent Working Pattern

All agents MUST:
1. `cd` into the target project path before doing any work
2. Read project context from `openspec/config.yaml` (or receive it via `openspec instructions`)
3. Read/write orchestration metadata (TASK.md, logs, FAILURE.md) in `<target>/.forjis/tasks/<task-id>/`
4. Read/write all artifacts (exploration, specs, design, qa, review) in `<target>/openspec/changes/<task-id>/`
5. Read/write source code in the target project directory
6. Never modify files in the Forjis directory

## Status Protocol

Every agent writes an HTML comment at the **last line** of its output file:

```
<!-- STATUS: READY -->
<!-- STATUS: NEEDS_REVISION -->
<!-- STATUS: PASS -->
<!-- STATUS: FAIL -->
```

| Agent | Output File | Success | Retry |
|-------|------------|---------|-------|
| Explorer | openspec/changes/&lt;task-id&gt;/exploration.md | READY | NEEDS_REVISION |
| Analyst | openspec/changes/&lt;task-id&gt;/specs/requirements/spec.md | READY | NEEDS_REVISION |
| Analyst (streams) | openspec/changes/&lt;task-id&gt;/streams.md | READY | NEEDS_REVISION |
| Architect | (via `openspec status --change`) | all `applyRequires` done | any not done |
| Architect (stream) | streams/&lt;name&gt;/tasks.md | READY | NEEDS_REVISION |
| Developer | openspec/changes/&lt;task-id&gt;/qa.md | READY | (always proceeds to reviewer) |
| Developer (stream) | streams/&lt;name&gt;/qa.md | READY | (always proceeds to reviewer) |
| Reviewer | openspec/changes/&lt;task-id&gt;/review.md | PASS | FAIL |
| Reviewer (stream) | streams/&lt;name&gt;/review.md | PASS | FAIL |

## Feedback Mechanism

When Reviewer sets STATUS: FAIL, review.md must include:

### Failed Tests
For each failure: test name, expected vs actual, root cause, design.md section, requirement ID.

### Required Fixes
Numbered list of concrete actions with file paths relative to target project.

Developer on next iteration reads review.md first and makes targeted fixes only.

## File Locations (relative to target project)

```
<target-project>/
├── openspec/
│   ├── config.yaml                    ← Project configuration (created by /forjis-init)
│   ├── specs/                         ← Long-lived main specs (after archive)
│   │   └── <capability>/
│   │       └── spec.md
│   └── changes/
│       └── <task-id>/                 ← ALL artifacts live here
│           ├── .openspec.yaml         ← Schema and artifact graph (Setup creates)
│           ├── specs/
│           │   └── requirements/
│           │       └── spec.md        ← Requirements spec (Analyst)
│           ├── proposal.md            ← What and why (Architect)
│           ├── design.md              ← Architecture and interfaces (Architect)
│           ├── tasks.md               ← Implementation steps (Architect → Developer)
│           ├── exploration.md         ← Codebase exploration report (Explorer)
│           ├── qa.md                  ← Developer test plan output
│           ├── review.md             ← Reviewer test results
│           ├── streams.md            ← Stream topology manifest (Analyst, conditional)
│           └── streams/              ← Stream-scoped artifacts (parallel mode only)
│               └── <stream-name>/
│                   ├── proposal.md   ← Stream proposal (Architect)
│                   ├── design.md     ← Stream design (Architect)
│                   ├── tasks.md      ← Stream tasks (Architect -> Developer)
│                   ├── qa.md         ← Stream QA plan (Developer)
│                   └── review.md     ← Stream review (Reviewer)
├── .forjis/
│   ├── exploration/             ← Cross-task exploration cache
│   │   └── <task-id>.md         ← Cached exploration with YAML frontmatter
│   └── tasks/
│       ├── <task-id>.md               ← Single-file task description (alternative)
│       └── <task-id>/                 ← Task directory
│           ├── TASK.md or task.md     ← Task description (mandatory in directory form)
│           ├── *.png, *.pdf, ...      ← Supporting files referenced by task.md
│           ├── logs/                  ← Agent invocation logs
│           └── FAILURE.md             ← Only on pipeline failure
├── src/                               ← Source code (Developer writes here)
├── tests/                             ← Tests (Reviewer writes here)
└── ...
```

## Parallel Mode

When the Analyst identifies independent work streams, it produces a `streams.md`
manifest. The presence of `streams.md` with `<!-- STATUS: READY -->` triggers
parallel execution mode. When absent, the pipeline runs sequentially as usual.

### Stream-Scoped File Locations

In parallel mode, each stream's artifacts are isolated under `streams/<stream-name>/`:

```
<target-project>/openspec/changes/<task-id>/
├── streams.md                        <- Stream topology (Analyst)
└── streams/
    └── <stream-name>/
        ├── proposal.md               <- Stream proposal (Architect)
        ├── design.md                 <- Stream design (Architect)
        ├── tasks.md                  <- Stream tasks (Architect -> Developer)
        ├── qa.md                     <- Stream QA plan (Developer)
        └── review.md                <- Stream review (Reviewer)
```

### streams.md Manifest Format

The `streams.md` file declares named streams, their types, requirement mappings,
and dependency ordering. The orchestrator parses this to build a DAG for execution.

```markdown
# Stream Topology

## Streams

### <stream-name>
- **Type:** bottleneck | parallel
- **Requirements:** FR-001, FR-002
- **Depends on:** (none) | stream-name-1, stream-name-2

### <stream-name-2>
- **Type:** parallel
- **Requirements:** FR-003, FR-004
- **Depends on:** <stream-name>

## DAG Summary

| Tier | Streams | Type |
|------|---------|------|
| 1 | <stream-name> | bottleneck |
| 2 | <stream-name-2>, <stream-name-3> | parallel |

<!-- STATUS: READY -->
```

**Parsing rules (for the orchestrator):**
- Stream names are H3 headings (`### <name>`) under `## Streams`
- Type is extracted from the `**Type:**` line: either `bottleneck` or `parallel`
- Requirements are extracted from the `**Requirements:**` line: comma-separated FR-xxx identifiers
- Dependencies are extracted from the `**Depends on:**` line: comma-separated stream names, or `(none)`
- The DAG Summary table is informational; the orchestrator builds the DAG from individual stream definitions
- Status marker on the last line determines readiness

**Validation rules (enforced by the Analyst):**
- Every FR-xxx in `specs/requirements/spec.md` appears in exactly one stream
- No FR-xxx appears in more than one stream
- Dependency graph has no cycles
- At least one stream has no dependencies (DAG root)
- Stream names are kebab-case

## Layer-Specialized Agents

When stream names match reserved layer names, the orchestrator dispatches
specialized agents with domain-specific skills and scope restrictions.

### Dispatch Table

| Stream Name | Architect | Developer | Reviewer |
|-------------|-----------|-----------|----------|
| `api` | forjis-api-architect | forjis-api-developer | forjis-api-reviewer |
| `backend` | forjis-backend-architect | forjis-backend-developer | forjis-backend-reviewer |
| `frontend` | forjis-frontend-architect | forjis-frontend-developer | forjis-frontend-reviewer |
| *(other)* | forjis-fullstack-architect | forjis-fullstack-developer | forjis-fullstack-reviewer |

### Skill Mappings

| Layer | Skills Read | Focus |
|-------|------------|-------|
| API | `java` | Endpoints, DTOs, validation, error formats, service interface stubs |
| Backend | `java`, `postgre` | Database schemas, domain models, services, repositories, migrations |
| Frontend | `ui`, `solidjs` | Components, pages, routing, state management, API client |

### Unified Tier Execution Model

In parallel mode with layer-specialized agents, each DAG tier completes fully
before the next tier advances:

```
Tier 1 (bottleneck):
  API Architect → API Developer ↔ API Reviewer (loop until PASS)
  --- Tier 1 complete: API code is finished and reviewed ---

Tier 2 (parallel):
  Backend Architect → Backend Developer ↔ Backend Reviewer
  Frontend Architect → Frontend Developer ↔ Frontend Reviewer
  (Backend and Frontend run simultaneously)
  --- Tier 2 complete: all code finished and reviewed ---
```

This ensures:
- Backend and frontend architects can read the API layer's finished `design.md`
- Backend and frontend developers can reference the API layer's actual implementation
- No cross-tier data races or incomplete dependencies

### Reserved Layer Names

The names `api`, `backend`, `frontend` are reserved for layer dispatch.
Non-layer stream names (e.g., `auth`, `notifications`) use fullstack agents.
The Analyst uses these reserved names when grouping requirements into
layer-based streams.

## Quality Standards

1. Git branching: `forjis/<task-id>` branch for each task
2. Doc comments on every exported function/class
3. No dead code, no commented-out blocks, no TODOs
4. Minimal dependencies — stdlib first, justify every third-party package
5. Utility modules, dependency injection, clear interfaces
6. Single-responsibility functions, ~40 line max, early returns
7. Independent tests, descriptive names, fixture-based data

## Bash Tool Timeouts

When invoking a long-running command through the Bash tool (`npm test`,
`npm run build`, `tsc`, integration scripts, anything that shells out to a
test runner or compiler), always pass an explicit `timeout` — default
300000 ms (5 min). If the command genuinely needs longer, raise the value
deliberately. Never call these commands without a timeout.

A missing timeout is how orchestrator hangs happen: a nested Bash call
that never exits (unterminated test server, stuck compiler, hung REPL)
blocks the parent subprocess indefinitely, and the engine's `result`
event is never emitted. The engine-level silence watchdog is a safety
net, not an excuse to skip per-call timeouts.

When a test runner supports it, also pass `--forceExit` (or the
equivalent) so lingering handles cannot keep the process alive past
test completion.

## No Destructive Side-Effects in Test Commands

Test commands must **assume a clean working tree** and **fail fast** if
it isn't. Do not embed destructive git operations (e.g. `git stash -u`,
`git reset --hard`, `git clean -fdx`, `git checkout --`) inside the
script run by `npm test`, `npm run build`, or any hook. These
operations can silently discard the user's uncommitted work when
invoked automatically. If a clean tree is a prerequisite, check the
status and abort with a clear error instead of mutating state.

## Pipeline Limits (defaults, configurable in openspec/config.yaml context)

| Phase | Max Iterations |
|-------|---------------|
| Explorer loop | 2 |
| Analyst loop | 3 |
| Architect loop | 3 |
| Developer ↔ Reviewer loop | 5 |

On limit exceeded: write `<target>/.forjis/tasks/<task-id>/FAILURE.md` and halt.

---

## Prompt Composition Templates

Referenced by ORG, Swarm, Fallback, and Independent modes. All modes inject
identical section formats — the orchestrator substitutes placeholder values
when composing each agent's prompt.

### Constraint Injection

Append constraint sections to the composed prompt in this order. Omit any
section whose source is empty. Task constraints have the highest precedence
and override all above.

1. **Foundational Reference Documents** — injected BEFORE `Common Mandatory
   Constraints` (or before validation hooks if no mandatory constraints).
   Render each pillar from `PILLAR_DOCUMENTS` as a `###` heading with its
   path followed by its content.

   ```
   ## Foundational Reference Documents

   The following documents are foundational references for this project.
   All outputs must align with these documents.

   ### <pillar-path>

   <pillar-content>
   ```

2. **Common Mandatory Constraints** — appended AFTER validation hooks.

   ```
   ## Common Mandatory Constraints

   You MUST follow these constraints. They apply to every task in this project
   and override any conflicting default behavior from your base instructions.

   <COMMON_MANDATORY_CONSTRAINTS>
   ```

3. **Common Optional Constraints** — appended AFTER mandatory (or after
   validation hooks if no mandatory).

   ```
   ## Common Optional Constraints

   You SHOULD follow these guidelines when possible. They represent project
   preferences but may be overridden by task-specific constraints.

   <COMMON_OPTIONAL_CONSTRAINTS>
   ```

4. **Task Constraints** — appended LAST.

   ```
   ## Task Constraints

   You MUST follow these constraints for this task. They override any
   conflicting default behavior.

   <TASK_CONSTRAINTS>
   ```

### Load Event Injection

Appended as the final section of the composed prompt (after all constraints).
The orchestrator pre-computes `<SLUG>` as the lowercase `<team>-<role>` pair.
In Fallback mode the team slug is `default` and the role slug is the agent
stage name (e.g. `explorer`), producing files like `events-default-explorer.jsonl`.

```
## Load Event (mandatory first action)

Before doing ANYTHING else, write a load event to record what was loaded for this agent.
Run this exact Bash command as your very first tool call:

mkdir -p "<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>" && echo '{"timestamp":"<CURRENT_ISO_TIMESTAMP>","type":"load","role":"<ROLE_NAME>","content":"<LOADED_RESOURCES>"}' >> "<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>/events-<SLUG>.jsonl"

Where <LOADED_RESOURCES> is a pipe-separated summary of what was loaded:
agent: <agent-file> | skills: <skill1, skill2> | hooks: <pre-hooks, validation-hooks> | expertise: <yes/no> | constraints: <mandatory: N, optional: N, task: N>

Replace <CURRENT_ISO_TIMESTAMP> with the actual current ISO-8601 timestamp when you execute.
This is mandatory. Do not skip this step.
```

---

## ORG MODE Protocol

ORG MODE provides organization-aware orchestration with weight-based agent selection.
When `.forjis/config/orgs.yaml` exists in the target project, the orchestrator evaluates
each role's relevance to the task and only runs agents that score above the threshold.

### Execution Modes

| Mode | Trigger | Intelligence | Org Required |
|------|---------|-------------|--------------|
| **ORG** (default) | No flags | Weight evaluation, org+team selection | **Yes — halts if missing** |
| **Swarm** | `--swarm` flag | ORG + dynamic re-evaluation | **Yes — halts if missing** |
| **Independent** | `--agents` or `--skip` flag | None — explicit agent selection | No (uses org for enrichment if available) |
| **Independent (raw)** | `--raw --agents` flags | None — no org enrichment | No |
| **Fallback** | `--fallback` flag (explicit) | Full sequential pipeline (legacy) | No |
| **Persona** | `--persona` flag | Persona-driven concurrent execution | No (reads personas.yaml) |
| **Strategist** | `--strategist` flag | Autonomous code scanning | No (reads tasks.yaml) |
| **Assess** | `--assess` flag | Outcome re-assessment | No (reads outcomes.yaml + orgs.yaml) |

### Org File Format: `orgs.yaml` (via `.forjis/config/`)

Lives in **`<target>/.forjis/config/`** (produced by the resolver). One project = one file. Multiple orgs allowed.
All paths (agent, skills, hooks) are absolute, resolved by the resolver.

```yaml
version: 1

orgs:
  - name: CompanyDev
    teams:
      - name: Dev
        roles:
          - name: Explorer
            agent: "/absolute/path/to/forjis-explorer.md"
          - name: Analyst
            agent: "/absolute/path/to/forjis-analyst.md"
            skills:
              - "/absolute/path/to/business-analyst/SKILL.md"
            hooks:
              pre: ["/absolute/path/to/lint-check.md"]
              post: ["/absolute/path/to/format-check.md"]
              validation: ["/absolute/path/to/security-checklist.md"]
          - name: Architect
            agent: "/absolute/path/to/forjis-fullstack-architect.md"
          - name: Developer
            agent: "/absolute/path/to/forjis-fullstack-developer.md"
            skills: ["/absolute/path/to/java/SKILL.md"]
            outcomes: ["default"]
          - name: SolidJSDeveloper
            agent: "/absolute/path/to/forjis-frontend-developer.md"
            skills: ["/absolute/path/to/solidjs/SKILL.md", "/absolute/path/to/ui/SKILL.md"]
            expertise: "Front End SolidJS development"
            stage: developer
          - name: Reviewer
            agent: "/absolute/path/to/forjis-fullstack-reviewer.md"
          - name: Copywriter
            agent: "/absolute/path/to/writer.md"
            expertise: "Marketing copy and press releases"
            stage: developer
```

The resolver always produces array-style format with absolute paths for `agent`, `skills`, and `hooks` fields.

### Role Fields

| Field | Required | Description |
|-------|----------|-------------|
| `agent` | Yes | Agent file (absolute path from resolver) |
| `skills` | No | List of skill file paths (absolute from resolver) |
| `expertise` | Conditional | Mandatory when agent filename doesn't match standard pattern |
| `stage` | Conditional | Mandatory when agent filename doesn't match standard pattern. Values: `explorer`, `analyst`, `architect`, `developer`, `reviewer` |
| `stream` | No | Explicit stream assignment (overrides filename-based inference) |
| `hooks.pre` | No | List of hook file paths (absolute from resolver). Prepended to agent prompt |
| `hooks.post` | No | List of hook file paths (absolute from resolver). Orchestrator evaluates PASS/FAIL after agent |
| `hooks.validation` | No | List of hook file paths (absolute from resolver). Appended to agent prompt as constraints |

### Path Resolution

All paths in `.forjis/config/orgs.yaml` are absolute, resolved by the resolver.
No dual-path detection is needed. Read files directly from their paths.

### Weight Evaluation

The orchestrator scores each role 1-100 based on task description + quick project scan:
- Weight >= 70 → RUN
- Weight < 70 → SKIP
- `finish` → always 0 (never auto-started)
- `setup` → not weight-evaluated (runs if change is new)

**Developer-Reviewer coupling:** If ANY Developer-stage role is RUN, ALL Reviewer-stage roles that could review its domain are forced to RUN regardless of weight.

Weights are persisted to `.forjis/tasks/<TASK_ID>/weights.yaml` with an org file content hash for change detection on resume.

### Hooks

#### Prompt Hooks (agent self-compliance)

| Type | When | How |
|------|------|-----|
| `pre` | Before agent starts | Prepended to agent prompt as pre-execution instructions |
| `validation` | Injected into prompt | Appended as additional constraints the agent must satisfy |

#### Post-Check Hooks (orchestrator evaluation)

| Type | When | How |
|------|------|-----|
| `post` | After agent completes | Orchestrator reads hook + agent output, makes separate LLM PASS/FAIL judgment. On FAIL, agent re-runs with failure reason. Max 3 retries then ask user. |

Post-hook retry count tracked within agent's iteration budget. NEEDS_REVISION > post-hook FAIL > iteration limit. Cross-team post-hook failures are independent.

### Finish Phase

The `forjis-finish` agent archives the OpenSpec change, commits all work, and optionally pushes/creates a PR. It writes `finish.md` with `<!-- STATUS: DONE -->`.

- Only runs when explicitly requested (`--finish` or `--agents` list)
- When finish is in the plan, it owns archive+commit (orchestrator skips auto-archive)
- When finish is NOT in the plan, orchestrator auto-archives+commits (legacy behavior)

### Multi-Developer Artifacts

When multiple Developer-stage roles exist (non-stream mode), role-scoped directories prevent artifact collisions:

```
openspec/changes/<TASK_ID>/roles/<RoleName>/
  proposal.md, design.md, tasks.md   (Architect per domain)
  qa.md                               (Developer)
  review.md                           (Reviewer)
```

Single Developer → flat structure. With streams → `streams/<name>/`.

### Safety Commit on Failure

When the pipeline fails, a safety commit preserves partial work:
```bash
git add -A && git commit -m "forjis(<TASK_ID>): WIP - pipeline halted at <agent>"
```
Does NOT archive — archiving implies completion.

---

## Appendix: Project Detection Reference

Used by `/forjis-init` during project auto-detection. Scan the project root
up to 2 levels deep, match markers, and build a combined profile when
multiple languages or frameworks coexist.

### Language + Version

| Marker | Language | Version source |
|---|---|---|
| `pom.xml` | Java (Maven) | `<java.version>` / `<maven.compiler.source>` |
| `build.gradle(.kts)` | Java or Kotlin (Gradle) | `sourceCompatibility`, `kotlin("jvm")` plugin |
| `settings.gradle(.kts)` | Multi-module JVM | `include` for subprojects |
| `gradlew`, `.mvn/wrapper/` | JVM wrappers | `gradle-wrapper.properties`, `maven-wrapper.properties` |
| `package.json` | JS or TS | `typescript` in devDeps → TS |
| `tsconfig.json` | TypeScript | `strict`, `target`, `module` |
| `pyproject.toml` | Python | `[project].requires-python` |
| `setup.py`, `requirements.txt` | Python (legacy) | — |
| `go.mod` | Go | `go` directive |
| `Cargo.toml` | Rust | `edition` |
| `sfdx-project.json` | Salesforce (Apex/LWC) | `sourceApiVersion` |
| `composer.json` | PHP | `require.php` |
| `*.csproj` / `*.sln` | C# / .NET | `<TargetFramework>` |
| `Gemfile` | Ruby | (check Rails) |
| `mix.exs` | Elixir | (check Phoenix) |
| `pubspec.yaml` | Dart / Flutter | (check flutter) |
| `CMakeLists.txt`, `Makefile` | C / C++ | — |

Multiple matches → polyglot/monorepo; detect all, note the primary.

### Build Tool & Package Manager

| Marker | Tool |
|---|---|
| `pom.xml` | Maven |
| `build.gradle(.kts)` | Gradle |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` (+ `.yarnrc.yml` → Berry) | Yarn |
| `package-lock.json` | npm |
| `bun.lockb` | Bun |
| `Pipfile` | pipenv |
| `poetry.lock` + `[tool.poetry]` | Poetry |
| `uv.lock` | uv |
| `Makefile` | Make |
| `Dockerfile` / `docker-compose.yml` | Docker / Compose |

### Framework

| Marker | Framework |
|---|---|
| `spring-boot-starter` | Spring Boot (note starters: web, webflux, data-jpa, security) |
| `spring-cloud` | Spring Cloud |
| `quarkus` | Quarkus |
| `micronaut` | Micronaut |
| `jakarta.ee` / `javax.servlet` | Jakarta EE |
| `io.dropwizard` | Dropwizard |
| `io.vertx` | Vert.x |
| `react` | React |
| `next` | Next.js |
| `vue` / `nuxt` | Vue / Nuxt |
| `@angular/core` | Angular |
| `svelte` | Svelte |
| `express` / `fastify` / `hono` | Node HTTP |
| `@nestjs/core` | NestJS |
| `django` / `fastapi` / `flask` | Python web |
| `rails` (Gemfile) | Ruby on Rails |
| `phoenix` (mix.exs) | Phoenix |
| `laravel` (composer.json) | Laravel |
| `flutter` (pubspec.yaml) | Flutter |

### Testing

| Marker | Framework | Language |
|---|---|---|
| `junit-jupiter` / `junit-platform` | JUnit 5 | Java |
| `junit:junit:4` | JUnit 4 (legacy) | Java |
| `org.mockito` | Mockito | Java |
| `org.testcontainers` | Testcontainers | Java |
| `io.rest-assured` | REST Assured | Java |
| `spring-boot-starter-test` | Spring Boot Test | Java |
| `vitest` / `jest` / `mocha` | Unit | JS/TS |
| `playwright` / `cypress` | E2E | JS/TS |
| `pytest` | pytest | Python |

### Project Type Classification

| Signals | Type |
|---|---|
| Spring Boot + REST / Express / FastAPI, no frontend | `backend-api` |
| Spring Boot + Thymeleaf or frontend submodule | `full-stack-java` |
| React/Vue/Angular/Svelte, no backend | `frontend` |
| Frontend + backend in same repo | `full-stack` |
| `sfdx-project.json` | `salesforce` |
| `bin` in package.json / `console_scripts` in pyproject | `cli` |
| Flutter / React Native | `mobile` |
| Gradle multi-module with api/core/app | `java-modular` |
| Library package, no entry point | `library` |
| Nothing detected | `unknown` |

### Monorepo / Multi-Module

| Marker | Pattern |
|---|---|
| `workspaces` in package.json | npm/yarn/pnpm workspaces |
| `pnpm-workspace.yaml` | pnpm workspaces |
| `settings.gradle(.kts)` with `include` | Gradle multi-module |
| `<modules>` in pom.xml | Maven multi-module |
| `nx.json` | Nx |
| `turbo.json` | Turborepo |

Scan each subproject separately and build a combined profile.

### Conventions & Tooling

| Marker | Convention |
|---|---|
| `tsconfig.json` | TypeScript config |
| `.eslintrc*` / `eslint.config.*` | ESLint |
| `.prettierrc*` | Prettier |
| `checkstyle.xml` / `spotless` Gradle plugin | Java linting |
| `.editorconfig` | EditorConfig |
| `.env.example` | Env vars |
| `Dockerfile` / `docker-compose.yml` | Containerized |
| `.github/workflows/` / `Jenkinsfile` / `.gitlab-ci.yml` | CI |
| `sonar-project.properties` | SonarQube |
| `lombok.config` | Lombok (Java) |
| `application.yml` / `application.properties` | Spring Boot config |
