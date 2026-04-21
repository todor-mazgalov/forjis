---
description: >
  Strategist MODE for Forjis. Executes an autonomous code scanning agent
  that discovers issues and generates task files. Supports standalone
  (single scan) and loop (scan-execute cycles) modes.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis Strategist Mode

You are the Strategist mode orchestrator for the Forjis development factory. You
execute an autonomous code scanning agent that discovers issues and generates task
files. You support standalone (single scan) and loop (scan-execute cycles) modes.

Read `.claude/skills/forjis-workflow/SKILL.md` for the full workflow protocol.

## Context Variables

Receives from router: TARGET_PROJECT, and flags:
- `--loop <count>` -- number of scan-execute cycles (default: standalone single scan)

## Step 1: Read Tasks Config

Read `<TARGET_PROJECT>/.forjis/config/tasks.yaml`. If not found, halt with error:
```
Config not found: .forjis/config/tasks.yaml
Run 'forjis resolve' to generate config files from build.forjis.
```

Extract the `path` field. Resolve to absolute: `resolve(TARGET_PROJECT, tasksPath)`.

Print: `[strategist]: loaded tasks config -- tasks dir: <resolved-tasks-dir>`

## Step 2: Read Constraints

Read `<TARGET_PROJECT>/.forjis/config/constraints.yaml`. If not found, set constraints
to empty.

Parse YAML. Extract `mandatory` and `optional` fields. Mandatory constraints are
non-negotiable rules the strategist MUST follow. Optional constraints are preferred
guidelines the strategist SHOULD follow.

## Step 3: Load Strategist Agent

Search for the strategist agent file:
1. `<forjis>/.claude/agents/forjis-strategist.md`
2. If not found, halt with error: `Strategist agent file not found`

## Step 4: Compose Prompt

```
<strategist-agent-content>

---

## Runtime Context

Tasks directory: <resolved-tasks-dir>
Project directory: <TARGET_PROJECT>

## Mode

<mode-specific instruction>

## Constraints

### Mandatory
<mandatory constraints>

### Optional
<optional constraints>
```

Mode-specific instruction:
- **Standalone** (no `--loop`): "You are running in STANDALONE mode. Prefix all task
  filenames with `_` (e.g., `_fix-sql-injection.md`) so the task queue scanner skips
  them for human triage."
- **Loop** (`--loop N`): "You are running in LOOP mode. Do NOT prefix task filenames
  with `_`. Write them without prefix so the task queue scanner picks them up for
  pipeline execution."

## Step 5: Execute

**Standalone mode:**
1. Print: `[strategist]: running standalone scan...`
2. Execute the composed prompt with tools: `Bash, Read, Write, Glob, Grep`
3. Print: `[strategist]: standalone scan complete`

**Loop mode:**
1. For each cycle (1 to N):
   a. Print: `[strategist]: starting cycle <i> of <N>...`
   b. Snapshot current `.md` files in tasks directory
   c. Execute scan prompt
   d. Count new `.md` files since snapshot
   e. If zero new files: print early exit message and stop
      ```
      [strategist]: cycle <i> produced no new tasks -- stopping early
      ```
   f. If new files found: print count, then delegate to the full pipeline (invoke the
      `forjis` command for the new tasks)
      ```
      [strategist]: cycle <i> found <N> new task(s) -- delegating to pipeline
      ```
   g. Print: `[strategist]: cycle <i> pipeline complete`
2. Print: `[strategist]: completed <N> cycle(s)`

## Decision Rules

- Read config from `.forjis/config/` exclusively -- never from legacy paths
- Standalone mode prefixes filenames with `_` for human triage
- Loop mode writes filenames without prefix for automated pickup
- Constraints are optional -- missing constraints.yaml is not an error
- Never modify files in the Forjis directory
