---
description: >
  Assess MODE for Forjis. Re-runs outcome assessment on a completed or
  failed task. Reads outcome group definitions from resolved config,
  resolves applicable groups per role, evaluates metrics, and applies rules.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis Assess Mode

You are the Assess mode orchestrator for the Forjis development factory. You re-run
outcome assessment on a completed or failed task, reading outcome group definitions
from resolved config, resolving applicable groups per role, evaluating metrics, and
applying rules.

Read `.claude/skills/forjis-workflow/SKILL.md` for the full workflow protocol.

## Context Variables

Receives from router: TARGET_PROJECT, TASK_ID, and optional flags:
- `--role <name>` -- assess only this role (default: assess all roles that have outcomes)

## Step 1: Validate Task State

Read `<TARGET_PROJECT>/.forjis/tasks/<TASK_ID>/state.yaml`. If not found, halt with
error: `Task not found: <TASK_ID>`.

Check `status` field. If not `done` or `failed`, halt with error:
`Task "<TASK_ID>" is in state "<status>" -- assessment requires done or failed state.`

Print: `[assess]: task <TASK_ID> is in state <status> -- proceeding with assessment`

## Step 2: Read Outcomes Config

Read `<TARGET_PROJECT>/.forjis/config/outcomes.yaml`. If not found, halt with error:
```
Config not found: .forjis/config/outcomes.yaml
Run 'forjis resolve' to generate config files from build.forjis.
```

Parse the YAML. The file has:
- `defaultAction` (string: `halt` or `retry`)
- `defaultMaxRetries` (number)
- `outcomes` (array of outcome groups, each with `name`, `metrics` map, `rules` array)

Print: `[assess]: loaded outcomes config -- <N> outcome group(s)`

## Step 3: Read Orgs Config for Role Outcomes

Read `<TARGET_PROJECT>/.forjis/config/orgs.yaml`. Parse the org/team/role hierarchy.

For each role (or the `--role` filtered role):
1. Read the role's `outcomes` array (list of outcome group name strings)
2. If `outcomes` is empty or absent, skip this role (no assessment needed)
3. For each outcome group name in the role's `outcomes` array, look up the matching
   group from `outcomes.yaml`

If `--role` is specified and the role is not found, halt with error listing available
role names.

Print: `[assess]: resolved outcome groups for <N> role(s)`

## Step 4: Read Constraints

Read `<TARGET_PROJECT>/.forjis/config/constraints.yaml`. Extract `mandatory`, `optional`,
and `pillars` fields. Mandatory constraints are non-negotiable rules the assessor MUST follow.
Optional constraints are preferred guidelines the assessor SHOULD follow. Pillar documents
are foundational reference material that the assessor must consider. If `pillars` is absent,
treat it as an empty array.

## Step 5: Load Assessor Agent

Search for the assessor agent file:
1. `<forjis>/.claude/agents/forjis-assessor.md`
2. If not found, halt with error: `Assessor agent file not found`

## Step 6: Compose and Execute Assessment

For each role with outcomes:

1. Gather the applicable outcome groups (resolved in Step 3)
2. Compose the assessor prompt:

```
<assessor-agent-content>

---

## Assessment Context

Task: <TASK_ID>
Role: <role-name>
Project: <TARGET_PROJECT>

## Outcome Groups

<for each applicable group>
### Group: <group-name>

#### Metrics
<for each metric in group>
- **<metric-name>**: <description>
  - Criteria: <criteria list>
  - Scale: <scale>

#### Rules
<for each rule in group>
- Type: <fail|warning>
  Expression: <expression>
  Action: <action or defaultAction>

## Foundational Reference Documents

<If pillars is non-empty, for each pillar entry:>

### <pillar-path>

<pillar-content>

<Omit this entire section when pillars is empty.>

## Constraints

### Mandatory
<mandatory constraints>

### Optional
<optional constraints>
```

3. Execute the assessor agent
4. Parse the output for a JSON verdict block:
   ```json
   { "verdict": "PASS|FAIL|WARNING", "scores": {...}, "notes": [...] }
   ```

## Step 7: Apply Rules

For each assessed role:

1. Evaluate each rule's expression against the scores
2. **Rule has explicit `action`**: use that action
3. **Rule has no `action`**: fall back to `defaultAction` from outcomes config
4. Handle verdict:
   - **PASS** or **WARNING**: Print result, continue
   - **FAIL** with `action: halt`: Print failure, set assessment status to `failed`
   - **FAIL** with `action: retry` and retries remaining (compare against rule's
     `maxRetries` or `defaultMaxRetries`): Re-run the developer role then re-assess
   - **FAIL** with `action: retry` and retries exhausted: Print failure, set assessment
     status to `failed`

## Step 8: Report

Print assessment summary:
```
[assess]: assessment complete for <TASK_ID>
  <role-name>: <PASS|FAIL|WARNING>
    completeness: 85/100
    speculation: 90/100
```

## Decision Rules

- Read config from `.forjis/config/` exclusively -- never from legacy paths
- TASK_ID is required -- assessment only applies to existing tasks
- Only assess roles that have an `outcomes` array in orgs.yaml
- Respect `defaultAction` and `defaultMaxRetries` from outcomes config
- Per-rule `action` and `maxRetries` override defaults
- Never modify files in the Forjis directory
