---
description: >
  Independent MODE for Forjis. Explicit agent selection with no intelligence.
  Runs listed agents in pipeline order. Optionally enriches with org skills/hooks.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis Independent Mode

You are running specific Forjis agents on a target project with explicit control.
No weight evaluation, no org/team selection intelligence.

**Use the `Read` tool** to load `.claude/skills/forjis-workflow/SKILL.md` for the workflow protocol, including the Logging Protocol section — all log lines must follow `[<actor>]: <action>` format. Then activate it via the `Skill` tool with `skill: "forjis-workflow"`.

**Pid self-check first.** `state.yaml: running` + live `<task>/pid` on a fresh start point at you. Halt as "another pipeline running" ONLY if the pid is alive AND `!= $$`.

## Context Variables

Receives from router: TARGET_PROJECT, TASK_ID, TASK_DESCRIPTION, TASK_CONSTRAINTS
(may be empty), COMMON_MANDATORY_CONSTRAINTS (may be empty),
COMMON_OPTIONAL_CONSTRAINTS (may be empty), and flags:
- `--agents <list>` — comma-separated agent/role names to run (mutually exclusive with --skip)
- `--skip <list>` — run full pipeline EXCEPT listed agents (mutually exclusive with --agents)
- `--raw` — ignore org file entirely, agents run with built-in capabilities only
- `--finish` — add finish agent to execution plan
- `--stream <name>` — target a specific stream

## Agent Resolution

### Mode 1: --agents (run ONLY these)

Parse comma-separated list. Resolve each name using alias table below. If `--finish`
flag is set, add `finish` to the list.

### Mode 2: --skip (run all EXCEPT these)

Start with full pipeline: `setup, explorer, analyst, architect, developer, reviewer`.
Remove listed agents. If `--finish` flag set, add `finish`. Result is the execution list.

### Agent Names & Aliases

| Name | Aliases | Agent File |
|------|---------|------------|
| `setup` | `s` | forjis-setup.md |
| `explorer` | `e`, `explore` | forjis-explorer.md |
| `analyst` | `a`, `analysis` | forjis-analyst.md |
| `architect` | `arch`, `sa` | forjis-fullstack-architect.md |
| `developer` | `dev`, `d` | forjis-fullstack-developer.md |
| `reviewer` | `rev`, `r`, `review` | forjis-fullstack-reviewer.md |
| `finish` | `f`, `fin` | forjis-finish.md |
| `api-architect` | `api-arch` | forjis-api-architect.md |
| `api-developer` | `api-dev` | forjis-api-developer.md |
| `api-reviewer` | `api-rev` | forjis-api-reviewer.md |
| `backend-architect` | `be-arch` | forjis-backend-architect.md |
| `backend-developer` | `be-dev` | forjis-backend-developer.md |
| `backend-reviewer` | `be-rev` | forjis-backend-reviewer.md |
| `frontend-architect` | `fe-arch` | forjis-frontend-architect.md |
| `frontend-developer` | `fe-dev` | forjis-frontend-developer.md |
| `frontend-reviewer` | `fe-rev` | forjis-frontend-reviewer.md |

### Role Name Resolution (when org file exists and --raw is NOT set)

When an org file exists and multiple roles share the same pipeline stage, users MUST
specify role names instead of stage aliases. If a stage alias is ambiguous (maps to
multiple roles), halt with error:

```
ERROR: "dev" is ambiguous — matches multiple Developer-stage roles.
Available roles in team Dev:
  Developer        (forjis-fullstack-developer.md)
  JavaDeveloper    (forjis-backend-developer.md)
  SolidJSDeveloper (forjis-frontend-developer.md)
Use: --agents JavaDeveloper,SolidJSDeveloper
```

### Raw Mode Alias Resolution

In `--raw` mode, alias resolution uses the standard agent name table only (no org
roles). `dev` always maps to `forjis-fullstack-developer.md`. No ambiguity possible — standard
aliases are 1:1 with agent files.

## Pre-Flight Checks

1. Verify TARGET_PROJECT exists and contains `openspec/config.yaml`
   - If not: tell user to run `/forjis-init <project-path>` first
2. Read `openspec/config.yaml` for project context and pipeline limits

## Setup Handling

The sentinel for "setup has already run" is the **openspec change directory**
(`<TARGET_PROJECT>/openspec/changes/<TASK_ID>/`), not the task directory. The
facilitator queue pre-creates `.forjis/tasks/<TASK_ID>/` (with `state.yaml`,
`TASK.md`, and `events.jsonl`) before the orchestrator spawns, so the presence
of that directory does NOT indicate a resume.

If `<TARGET_PROJECT>/openspec/changes/<TASK_ID>/` does NOT exist:
- If `setup` is in the agent list → run setup normally
- If `setup` is NOT in the list → create minimal infrastructure before running agents:
  1. Create `.forjis/tasks/<TASK_ID>/` directory and `logs/` subdirectory (if not
     already present — the queue may have seeded it)
  2. Write `TASK.md` with the task description (if not already present)
  3. Capture source branch and create task branch:
     ```bash
     SOURCE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
     git checkout forjis/<TASK_ID> 2>/dev/null || git checkout -b forjis/<TASK_ID>
     ```
  4. Run `openspec change new --id "<TASK_ID>"` in the target project
  5. Write a minimal `pipeline-state.yaml` with the branches field:
     ```yaml
     branches:
       - <SOURCE_BRANCH>
       - forjis/<TASK_ID>
     status: running
     roles: []
     ```
  This ensures the workspace is functional without requiring setup in the agent list.

If `<TARGET_PROJECT>/openspec/changes/<TASK_ID>/` exists → genuine resume scenario,
skip setup infrastructure.

## Pipeline Ordering

Always sort agents by pipeline order regardless of user-provided order:

```
setup(1) → explorer(2) → analyst(3) → architect(4) → developer(5) → reviewer(6) → finish(7)
```

Even if the user writes `--agents developer,analyst`, run analyst first.

## Org Enrichment (default, unless --raw)

If `.forjis/config/orgs.yaml` exists in the target project and `--raw` is NOT set:

1. For each agent in the execution list, find the matching role in the org file.
   The resolver always produces array-style format with absolute paths.
2. Match by agent filename; if multiple roles share the same agent file, use `expertise`
   to pick best match; if no expertise differentiates, pick any
3. Load the role's skills, expertise, and hooks. All paths in orgs.yaml are absolute;
   read directly from the path. No dual-path resolution needed.
4. Inject skill content into agent prompt, prepend pre hooks, append
   validation hooks, then apply the **Constraint Injection** template from
   `forjis-workflow/SKILL.md` (Foundational Reference Documents, Common
   Mandatory/Optional Constraints, Task Constraints). Task constraints have
   the highest precedence.
5. Post hooks: evaluate after agent completes (orchestrator makes separate LLM PASS/FAIL
   judgment; on FAIL, re-run agent with failure reason; max 3 retries then ask user)
6. Deduplicate skills: if agent file already references a skill, don't inject again

## Constraint Injection (applies to all paths)

Regardless of whether org enrichment is active (default) or disabled
(`--raw`), apply the **Constraint Injection** template from
`forjis-workflow/SKILL.md` to every agent's prompt. Task constraints have
the highest precedence.

In org-enriched mode, this is already handled by the Org Enrichment step 4.
In raw mode, this is the ONLY additional context beyond the agent's base prompt.

## Stream Support

When `--stream <name>` is provided AND task has `streams.md`:
- Agents run only for the named stream
- Agent receives STREAM_NAME=`<name>` as context
- Layer-specialized dispatch applies automatically:
  - `--agents architect --stream api` → dispatches `forjis-api-architect`
  - `--agents dev,rev --stream backend` → dispatches backend-developer + backend-reviewer

When `--stream` omitted AND task has `streams.md`:
- Agents run for all streams following DAG order
- Layer dispatch applies per stream name
- Respect max parallel limit from config.yaml

When task has no `streams.md`:
- `--stream` ignored with warning: "No streams.md found — running in sequential mode."

## Execution

### Report Plan

Before running, show the execution plan:

```
Forjis Run: <TASK_ID>

Target:  <TARGET_PROJECT>
Mode:    Independent
Agents:  analyst → architect → developer
Skipped: setup, explorer, reviewer

Warnings:
  (list missing input files, or "none")

Proceeding...
```

### Dependency Warnings

Warn (don't block) on missing inputs:

**Sequential mode:**

| Agent | Required Input | Warning If Missing |
|-------|---------------|-------------------|
| explorer | TASK.md | "TASK.md not found — explorer needs a task description" |
| analyst | TASK.md | "TASK.md not found — analyst needs a task description" |
| architect | specs/requirements/spec.md | "Requirements spec not found — run analyst first" |
| developer | tasks.md | "tasks.md not found — run architect first" |
| reviewer | qa.md | "qa.md not found — run developer first" |

**Parallel mode:**

| Agent | Required Input | Warning If Missing |
|-------|---------------|-------------------|
| architect | streams.md + spec.md | "streams.md or requirements spec not found" |
| developer | streams/&lt;name&gt;/tasks.md | "Stream tasks.md not found — run stream architect first" |
| reviewer | streams/&lt;name&gt;/qa.md | "Stream qa.md not found — run stream developer first" |

Print warnings but let the user decide whether to proceed.

### Looping Behavior

- **Explorer:** Loop until READY (max from config.yaml)
- **Analyst:** Loop until READY (max from config.yaml)
- **Architect:** Loop until READY (max from config.yaml)
- **Developer + Reviewer together:** Loop Dev ↔ Rev until PASS (max from config.yaml)
- **Developer alone (no Reviewer):** Run once, no loop
- **Reviewer alone (no Developer):** Run once. If FAIL, report with Required Fixes for the user
- **Architect + Developer (no Reviewer):** Architect loops until READY, Developer runs once

### Agent Invocation

For each selected agent, pass context:
- TARGET_PROJECT (absolute path)
- TASK_ID
- TASK_CONSTRAINTS (injected into prompt as described above)
- STREAM_NAME (if in parallel mode and agent is architect, developer, or reviewer)

Layer-specialized dispatch table:

| Stream Name | Architect | Developer | Reviewer |
|-------------|-----------|-----------|----------|
| `api` | forjis-api-architect | forjis-api-developer | forjis-api-reviewer |
| `backend` | forjis-backend-architect | forjis-backend-developer | forjis-backend-reviewer |
| `frontend` | forjis-frontend-architect | forjis-frontend-developer | forjis-frontend-reviewer |
| *(other)* | forjis-fullstack-architect | forjis-fullstack-developer | forjis-fullstack-reviewer |

Auto-dispatch: when user specifies generic name (e.g., `architect`) with `--stream`
targeting a reserved layer, substitute the specialized agent.

Log each invocation: `> [<agent-name>] iteration/cycle N`

### Load Event Injection

For every agent invoked, append the **Load Event Injection** template from
`forjis-workflow/SKILL.md` (after all constraints). `<SLUG>` is the lowercase
kebab of `<org>-<team>-<role>`. In `--raw` mode use `default` for org and
team, and the agent stage name as role.

### Git Behavior

- If setup is selected: creates branch `forjis/<TASK_ID>` as normal
- If setup NOT selected but branch missing:
  ```bash
  cd <TARGET_PROJECT>
  git checkout forjis/<TASK_ID> 2>/dev/null || git checkout -b forjis/<TASK_ID>
  ```
- Commit at end only if developer or reviewer was in the agent list:
  ```bash
  cd <TARGET_PROJECT>
  git add -A
  git commit -m "forjis(<TASK_ID>): <brief description>"
  ```

### Completion Report

```
Forjis Run Complete: <TASK_ID>

Target:     <TARGET_PROJECT>
Mode:       Independent
Executed:
  analyst:    N iteration(s) → READY
  architect:  N iteration(s) → READY
  developer:  1 run → qa.md written

Skipped: setup, explorer, reviewer

Artifacts updated:
  SPECS         openspec/changes/<TASK_ID>/specs/requirements/spec.md
  PROPOSAL      openspec/changes/<TASK_ID>/proposal.md
  DESIGN        openspec/changes/<TASK_ID>/design.md
  TASKS         openspec/changes/<TASK_ID>/tasks.md
  QA PLAN       openspec/changes/<TASK_ID>/qa.md

Branch: forjis/<TASK_ID>
```

## Decision Rules

- Always respect pipeline order: setup → explorer → analyst → architect → developer → reviewer → finish
- Warn on missing inputs but don't block — user may have created files manually
- Only loop Dev ↔ Rev when BOTH are selected; single agents run once
- Read STATUS markers from actual files
- Pass TARGET_PROJECT and TASK_ID to every subagent
- Never modify files in the Forjis directory
