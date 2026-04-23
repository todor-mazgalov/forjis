---
description: >
  Swarm MODE orchestration for Forjis. Extends ORG MODE with dynamic
  re-evaluation after each agent completes. Can add agents mid-pipeline
  based on discovered information.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis Swarm Mode

You are the Swarm mode orchestrator. Swarm mode is identical to ORG MODE
(Steps 1-9) with one addition: **dynamic re-evaluation** after each agent completes.

## Prerequisites

This mode requires `.forjis/config/orgs.yaml` in the target project. If not found, halt with error:
"Config not found: .forjis/config/orgs.yaml -- run 'forjis resolve' first."

## Base Behavior

Follow ALL steps from ORG MODE. Read `.claude/commands/forjis-org-mode.md` for the
full protocol. Everything in ORG MODE applies here unless overridden below.

- Steps 1-4b: Discover, Parse, Validate, Org/Team Selection, Setup, TASK.md
- Step 5: Weight Evaluation (same rules, coupling, persistence)
- Steps 6-9: Decision Table, Resume Detection, Load Context, Execute

**Use the `Read` tool** to load `.claude/skills/forjis-workflow/SKILL.md` for the workflow protocol, then activate it via the `Skill` tool with `skill: "forjis-workflow"`.

**Pid self-check first.** `state.yaml: running` + live `<task>/pid` on a fresh start point at you. Halt as "another pipeline running" ONLY if the pid is alive AND `!= $$`.

## Context Variables

Receives from router: TARGET_PROJECT, TASK_ID, TASK_DESCRIPTION, TASK_CONSTRAINTS
(may be empty), COMMON_MANDATORY_CONSTRAINTS (may be empty),
COMMON_OPTIONAL_CONSTRAINTS (may be empty), and flags:
--include, --exclude, --finish, --stream, --dry-run.

## Dynamic Re-evaluation Protocol

After each agent finishes (for dev↔reviewer loops, re-evaluation happens only
**after the loop fully completes** with PASS):

### Re-evaluation Steps

1. Read the agent's output file
2. Assess whether new information changes weight scores for SKIPPED roles:
   - Explorer discovered frontend needs → SolidJSDeveloper weight may increase
   - Analyst requirements revealed database changes → JavaDeveloper weight may increase
   - Architect design introduced new API layer → API-related roles may increase
3. If any previously-SKIPPED role's re-evaluated weight >= 70:
   - Print re-evaluation decision table (showing old vs new weights):
     ```
     Re-evaluation after: explorer
     Role              Old Weight  New Weight  Decision
     SolidJSDeveloper  30          85          ADD
     ```
   - Add the role to the execution queue at its correct pipeline position
   - **Update `pipeline-state.yaml`**: change the role's status from `skipped` to `planned`
4. Re-evaluation can only **ADD** agents, never remove already-completed ones
5. Re-evaluation considers roles from **ALL teams** in the selected org — Swarm can
   pull in roles from new teams when new information warrants it, with printed
   justification. Follow strict cross-team criteria: only when existing plan has zero
   matching roles for the newly discovered need.

### Late Developer Addition Rule

When Swarm re-evaluation adds a Developer-stage role and the Architect stage has
already completed:

1. The Architect is **re-invoked with targeted scope** — existing designs are preserved
2. The Architect receives:
   - Original task description
   - Existing designs (read-only context)
   - The newly added Developer role's expertise field
3. It produces additional design artifacts scoped to the new domain using role-scoped
   directories: `roles/<RoleName>/proposal.md`, `design.md`, `tasks.md`
4. Uses the same Architect-stage role from the execution plan (or standard Architect
   if none exists)

### Re-evaluation State Persistence

Persist to `.forjis/tasks/<TASK_ID>/swarm-state.yaml`:

```yaml
re_evaluations:
  - after_agent: explorer
    added_roles:
      SolidJSDeveloper: { old_weight: 30, new_weight: 85, team: Dev }
  - after_agent: analyst
    added_roles:
      Copywriter: { old_weight: 0, new_weight: 75, team: Marketing, justification: "Task requires user-facing copy" }
```

**On resume:** Load `swarm-state.yaml` to reconstruct the full execution plan
including dynamically added roles.

### Swarm Parallelism

When multiple agents at the same pipeline stage are eligible:

- **Default: sequential** — same-stage agents run sequentially, ordered alphabetically
  by role name
- **Parallel only when targeting different streams** — if agents work on different
  streams (isolated artifact directories), they run in parallel

This makes the parallelism decision deterministic rather than relying on LLM judgment.

### Finish Agent

The finish agent is **NEVER added by re-evaluation**. It only runs when explicitly
requested via `--finish` flag.

## Mode Switch on Resume

| Previous Mode | Resume Mode | Behavior |
|---|---|---|
| ORG → Swarm | Load `weights.yaml` normally. Start swarm re-evaluation from first incomplete agent. `swarm-state.yaml` created on first re-evaluation. |
| Swarm → ORG | Load `weights.yaml` AND `swarm-state.yaml` (dynamically added roles included in plan). No further re-evaluation. |
| Any → Independent | Ignore `weights.yaml`. Run listed agents only. |

## Pillar Document Injection

Follows the **Constraint Injection** template in `forjis-workflow/SKILL.md`,
same as ORG MODE.

## Decision Rules

- All ORG MODE rules apply
- Re-evaluation happens only after agent completes (or after full dev-rev loop PASS)
- Re-evaluation can only add, never remove
- Late Developer addition triggers targeted Architect re-invocation
- Finish is never dynamically added
- Read STATUS markers from actual files
- Never modify files in the Forjis directory
