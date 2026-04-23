---
description: >
  Unified Forjis command. Detects execution mode (ORG, Swarm, Independent,
  Fallback, Persona, Strategist, Assess) and delegates to the appropriate mode handler. Replaces
  forjis-task, forjis-run, and forjis-resume.
argument-hint: "[--swarm] [--agents list] [--raw] [--skip list] [--include roles] [--exclude roles] [--finish] [--stream name] [--dry-run] [--persona] [--strategist] [--assess] [--fallback] [--names list] [--create name] [--generate] [--description text] [--interactive] [--loop count] [--role name] <project-path> <task-id> [task description]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis — Unified Command Router

You are the entry point for all Forjis pipeline operations. Your job is minimal:
parse arguments, detect the execution mode, and delegate to the appropriate mode file.

**Use the `Read` tool** to load `.claude/skills/forjis-workflow/SKILL.md` for the full workflow protocol, then activate it via the `Skill` tool with `skill: "forjis-workflow"`.

## Pre-flight — do not police your own lifecycle

The facilitator owns orchestrator lifecycle. `state.yaml: running` and a live pid in `<task>/pid` are both managed by the facilitator — DO NOT halt based on them. The facilitator writes `<task>/pid` immediately AFTER spawning you, so there is an unavoidable window where that file still holds a prior pid; reading it and comparing to `$$` is racy and produces false halts. Trust the facilitator: if you were spawned, you are the intended orchestrator. Proceed into Step 1.

## Logging Protocol

Throughout execution, you MUST print structured log lines in this format:

```
[<actor>]: <action-description>
```

Where `<actor>` is `orchestrator` for pipeline-level events, or the role name (e.g., `Explorer`, `Developer`) for agent-level events. Print these as regular text output. Every significant action must have a log line so the user can follow what is happening.

## Step 1: Parse Arguments

From `$ARGUMENTS`, extract:

### Flags (consume before positional args)

| Flag | Value | Description |
|------|-------|-------------|
| `--swarm` | (none) | Enable Swarm mode |
| `--agents` | `<comma-list>` | Run only listed agents (Independent mode) |
| `--skip` | `<comma-list>` | Run all except listed agents (Independent mode) |
| `--raw` | (none) | No org enrichment (only with --agents) |
| `--include` | `<comma-list>` | Force-add roles in ORG/Swarm mode |
| `--exclude` | `<comma-list>` | Force-skip roles in ORG/Swarm mode |
| `--finish` | (none) | Add finish agent to execution plan |
| `--stream` | `<name>` | Target specific stream |
| `--dry-run` | (none) | Preview execution plan without running |
| `--persona` | (none) | Persona mode |
| `--strategist` | (none) | Strategist mode |
| `--assess` | (none) | Assess mode |
| `--fallback` | (none) | Legacy sequential pipeline (no org file required) |
| `--names` | `<comma-list>` | Persona names to run (persona mode only) |
| `--create` | `<name>` | Create new persona (persona mode only) |
| `--generate` | (none) | Generate new persona from description (persona mode only) |
| `--description` | `<text>` | Persona description for generation (persona mode only) |
| `--interactive` | (none) | Enable clarifying Q&A before generation (persona mode only) |
| `--loop` | `<count>` | Strategist loop count (strategist mode only) |
| `--role` | `<name>` | Role to assess (assess mode only) |

### Positional Arguments

- **TARGET_PROJECT:** First non-flag argument — resolve to absolute path
- **TASK_ID:** Second non-flag argument — the task identifier
- **TASK_DESCRIPTION:** Everything remaining after TASK_ID (may be empty on resume)

If fewer than 2 positional arguments, ask the user for the missing ones.

## Step 2: Validate Flag Combinations

Halt with clear error if mutually exclusive flags are combined:

- `--swarm` + `--agents` → "Cannot combine --swarm with --agents. Swarm requires org-driven execution."
- `--raw` without `--agents` → "The --raw flag only applies to Independent mode (--agents)."
- `--agents` + `--skip` → "Cannot combine --agents and --skip. Use one or the other."
- `--include` or `--exclude` + `--raw` → "Cannot combine --include/--exclude with --raw. Overrides require org context."
- `--persona` + `--strategist` or `--assess` → "Cannot combine mode flags. Use one at a time."
- `--names` without `--persona` → "The --names flag only applies to Persona mode."
- `--create` without `--persona` → "The --create flag only applies to Persona mode."
- `--loop` without `--strategist` → "The --loop flag only applies to Strategist mode."
- `--role` without `--assess` → "The --role flag only applies to Assess mode."
- `--generate` without `--persona` → "The --generate flag only applies to Persona mode."
- `--description` without `--generate` → "The --description flag only applies with --generate."
- `--interactive` without `--generate` → "The --interactive flag only applies with --generate."
- `--generate` + `--create` → "Cannot combine --generate with --create. Use one at a time."
- `--generate` + `--names` → "Cannot combine --generate with --names. Generate creates a new persona; it does not run existing ones."
- `--fallback` + any of `--swarm`, `--agents`, `--skip`, `--persona`, `--strategist`, `--assess` → "Cannot combine --fallback with other mode flags. Use one at a time."
- `--fallback` + `--include` or `--exclude` → "The --include/--exclude flags only apply to ORG/Swarm mode."

## Step 3: Detect Execution Mode

```
if --persona flag present:
    MODE = Persona
elif --strategist flag present:
    MODE = Strategist
elif --assess flag present:
    MODE = Assess
elif --fallback flag present:
    MODE = Fallback
elif --agents OR --skip flag present:
    MODE = Independent
elif --swarm flag present:
    MODE = Swarm
    require <TARGET_PROJECT>/.forjis/config/orgs.yaml to exist (see below)
else:
    MODE = ORG
    require <TARGET_PROJECT>/.forjis/config/orgs.yaml to exist (see below)
```

**ORG mode is strict.** When MODE resolves to ORG or Swarm, the orchestrator
MUST verify that `<TARGET_PROJECT>/.forjis/config/orgs.yaml` exists. If it
does not, halt with this error — do NOT silently downgrade to Fallback:

```
No org file found at .forjis/config/orgs.yaml.

ORG mode requires an organization configuration. Either:
  - Run /forjis-init to create one, or
  - Re-run with --fallback to use the legacy sequential pipeline, or
  - Re-run with --agents <list> for explicit Independent mode.
```

## Step 4: Resolve Task Description

TASK_DESCRIPTION from command args may be empty (normal on resume).
`change-id` in the command syntax maps to `TASK_ID` internally.

You MUST resolve TASK_DESCRIPTION now, before delegating. If it is empty,
use the **Read tool** to check these paths in order (first hit with content
wins; always use forward slashes even on Windows):

1. `<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>/TASK.md`
2. `<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>/task.md`
3. `<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>.md`
4. `<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>/state.yaml` → `description` field

If the Read on path 1 errors, wait 500ms (`sleep 0.5`) and retry once — the
file may not yet be visible due to atomic-rename timing — then continue to
paths 2-4. If nothing is found, halt:

```
No task description found. Provide it inline, or create one of:
  - .forjis/tasks/<TASK_ID>/TASK.md (or task.md)
  - .forjis/tasks/<TASK_ID>.md
```

Print: `[orchestrator]: resolved task description from <source>`

## Step 4b: Extract Execution Constraints

After resolving TASK_DESCRIPTION, check the same file for a `## Constraints`
section.

### Extraction Rules

1. Look for a line matching `## Constraints` (exact heading level 2)
2. Extract all content from that heading until the next `## ` heading or end of file
3. Store the extracted content (trimmed) as TASK_CONSTRAINTS
4. If no `## Constraints` section exists, TASK_CONSTRAINTS is empty

Do NOT treat the `## Requirements` section as constraints — that section describes
product requirements, not execution constraints.

If TASK_CONSTRAINTS is non-empty, print:
```
[orchestrator]: extracted execution constraints from TASK.md
```

If TASK_CONSTRAINTS is empty, do not print anything — absence of constraints is normal.

## Step 4c: Load Common Constraints

After resolving task constraints, load the common constraints that apply to all tasks.

Read `<TARGET_PROJECT>/.forjis/config/constraints.yaml` using the Read tool. If the file
exists, parse its YAML content and extract:

- `mandatory` field → store as COMMON_MANDATORY_CONSTRAINTS
- `optional` field → store as COMMON_OPTIONAL_CONSTRAINTS
- `pillars` field → store as PILLAR_DOCUMENTS (array of `{path, content}` objects, or empty array if key absent)

**Mandatory constraints are non-negotiable rules that every agent MUST follow.** They are
injected into every agent prompt and violations are not acceptable. Optional constraints
are preferred guidelines — agents SHOULD follow them but may deviate with justification.
**Pillar documents are foundational reference material** that shapes every agent's output.
They are injected as a separate "Foundational Reference Documents" section.

These constraints are passed to each mode handler, which injects them into every agent
invocation prompt. The mode handler sections describe exactly where and how.

If the file does not exist (Read tool returns an error), set
COMMON_MANDATORY_CONSTRAINTS and COMMON_OPTIONAL_CONSTRAINTS to empty strings
and PILLAR_DOCUMENTS to an empty array.
This is not an error — it means no common constraints are configured.

If COMMON_MANDATORY_CONSTRAINTS or COMMON_OPTIONAL_CONSTRAINTS is non-empty, print:
```
[orchestrator]: loaded common constraints from .forjis/config/constraints.yaml
```

## Step 5: Delegate to Mode Handler

Use the **Read tool** to load the content of the appropriate mode file from the
Forjis `.claude/commands/` directory. After reading the file content, follow its
instructions as if they were part of this prompt.

| Mode | File to Read |
|------|-------------|
| ORG | `.claude/commands/forjis-org-mode.md` |
| Swarm | `.claude/commands/forjis-swarm-mode.md` |
| Independent | `.claude/commands/forjis-independent-mode.md` |
| Fallback | `.claude/commands/forjis-fallback-mode.md` |
| Persona | `.claude/commands/forjis-persona.md` |
| Strategist | `.claude/commands/forjis-strategist.md` |
| Assess | `.claude/commands/forjis-assess.md` |

After parsing and before delegating, print:
```
[orchestrator]: parsed arguments — project: <TARGET_PROJECT>, task: <TASK_ID>
[orchestrator]: detected mode: <MODE>
[orchestrator]: delegating to <MODE> handler
```

Pass all parsed context to the mode handler:
- TARGET_PROJECT (absolute path)
- TASK_ID
- TASK_DESCRIPTION (may be empty)
- TASK_CONSTRAINTS (may be empty — extracted from TASK.md `## Execution Constraints` section)
- COMMON_MANDATORY_CONSTRAINTS (may be empty — from .forjis/config/constraints.yaml)
- COMMON_OPTIONAL_CONSTRAINTS (may be empty — from .forjis/config/constraints.yaml)
- PILLAR_DOCUMENTS (may be empty — from .forjis/config/constraints.yaml)
- All flags and their values

The mode handler contains all orchestration logic. This router is done after delegation.
