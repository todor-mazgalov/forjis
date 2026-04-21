---
name: openspec
description: >
  OpenSpec workflow orchestrator for Claude Code. Manages change-driven development
  through four actions: explore (think), propose (plan), apply (implement), archive
  (finalize). Use this skill whenever the user mentions OpenSpec, asks about their
  changes or artifacts, wants to start a new feature or fix using the openspec workflow,
  or references openspec commands (/opsx:explore, /opsx:propose, /opsx:apply, /opsx:archive).
  Also triggers when the user asks "what changes do I have?", "what's the status?",
  or wants to understand how OpenSpec works in their project.
license: MIT
compatibility: Requires openspec CLI installed and available on PATH.
metadata:
  author: openspec
  version: "1.0"
---

# OpenSpec — Change-Driven Development for Claude Code

OpenSpec is a lightweight workflow for building software through **changes** — named
units of work that move from idea to implementation to archive. Each change carries
its own artifacts (proposal, design, specs, tasks) and tracks its own progress.

## Core Concepts

### Changes

A **change** is a named unit of work (kebab-case: `add-user-auth`, `fix-login-bug`).
Each change lives in `openspec/changes/<name>/` and contains:

```
openspec/changes/<name>/
├── .openspec.yaml          ← Schema, artifact graph, apply requirements
├── proposal.md             ← What & why
├── design.md               ← How (architecture, decisions)
├── specs/                  ← Capability specs (requirements)
│   └── <capability>/
│       └── spec.md
└── tasks.md                ← Implementation steps (checkboxes)
```

### Schemas

Each change uses a **schema** (defined in `.openspec.yaml`) that determines:
- Which artifacts exist and their dependencies
- Which artifacts must be complete before implementation (`applyRequires`)
- The artifact build order

### Artifact Graph

Artifacts have dependencies — e.g., `design` depends on `proposal`, `tasks` depends
on `design`. The CLI resolves the graph and tells you what's ready to create next.

### Main Specs

Long-lived specs live at `openspec/specs/<capability>/spec.md`. Changes can create
**delta specs** that get synced back to main specs on archive.

---

## The Four Actions

OpenSpec has four actions that form a fluid workflow. They aren't rigid phases —
you can move between them freely based on what the work needs.

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Explore  │────▶│ Propose  │────▶│  Apply   │────▶│ Archive  │
  │          │     │          │     │          │     │          │
  │  Think   │     │  Plan    │     │  Build   │     │ Finalize │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
       │                                  │
       └──────── loop back freely ────────┘
```

| Action | Skill | Command | Purpose |
|--------|-------|---------|---------|
| **Explore** | `openspec-explore` | `/opsx:explore` | Think through ideas, investigate, compare options |
| **Propose** | `openspec-propose` | `/opsx:propose` | Create a change with all artifacts in one step |
| **Apply** | `openspec-apply-change` | `/opsx:apply` | Implement tasks from a change |
| **Archive** | `openspec-archive-change` | `/opsx:archive` | Finalize and archive a completed change |

### When to use each

- **Explore** — Vague idea, comparing approaches, stuck mid-implementation, investigating a problem. No code written. Thinking only.
- **Propose** — Ready to start. Creates the change directory and generates all artifacts (proposal → design → specs → tasks) in dependency order.
- **Apply** — Artifacts exist, tasks are ready. Implements each task, marks checkboxes, pauses on blockers.
- **Archive** — All tasks done. Validates completion, syncs delta specs, moves to `openspec/changes/archive/YYYY-MM-DD-<name>/`.

---

## CLI Reference

The `openspec` CLI manages changes, artifacts, and status.

### Essential Commands

```bash
# List all active changes
openspec list --json

# Create a new change
openspec new change "<name>"

# Check status and artifact graph
openspec status --change "<name>" --json

# Get artifact creation instructions
openspec instructions <artifact-id> --change "<name>" --json

# Get apply instructions (tasks, progress, context files)
openspec instructions apply --change "<name>" --json
```

### Status JSON Structure

```json
{
  "schemaName": "spec-driven",
  "applyRequires": ["tasks"],
  "artifacts": [
    { "id": "proposal", "status": "done", "dependencies": [] },
    { "id": "design", "status": "ready", "dependencies": ["proposal"] },
    { "id": "tasks", "status": "pending", "dependencies": ["design"] }
  ]
}
```

- `done` — Artifact file exists and is complete
- `ready` — Dependencies satisfied, can be created now
- `pending` — Dependencies not yet satisfied

### Instructions JSON Structure

```json
{
  "context": "Project background (constraints for you — do NOT include in output)",
  "rules": "Artifact-specific rules (constraints for you — do NOT include in output)",
  "template": "Structure to use for the output file",
  "instruction": "Schema-specific guidance for this artifact type",
  "outputPath": "Where to write the artifact",
  "dependencies": ["list of completed artifacts to read for context"]
}
```

**Critical rule**: `context` and `rules` are constraints that guide your writing.
They must NEVER appear in the artifact file itself. Only `template` shapes the output.

---

## Orchestration Behavior

When this skill triggers, determine what the user needs and route to the right action.

### 1. Status Check

If the user asks about their changes, status, or what they're working on:

```bash
openspec list --json
```

Display active changes with their schema and artifact status. Suggest next actions
based on state.

### 2. Routing

| User Intent | Route To |
|-------------|----------|
| "I'm thinking about..." / "should we..." / "compare X vs Y" | **Explore** — invoke `openspec-explore` |
| "I want to build..." / "let's start..." / "create a change" | **Propose** — invoke `openspec-propose` |
| "implement" / "start coding" / "work on tasks" / "apply" | **Apply** — invoke `openspec-apply-change` |
| "we're done" / "archive" / "finalize" | **Archive** — invoke `openspec-archive-change` |
| "what changes do I have?" / "status" | Status check (above) |

When routing, use the **Skill tool** to invoke the appropriate skill:
- `openspec-explore`
- `openspec-propose`
- `openspec-apply-change`
- `openspec-archive-change`

### 3. Ambiguous Requests

If intent is unclear, check context:
1. Run `openspec list --json` to see active changes
2. If no changes exist → likely Explore or Propose
3. If changes exist with incomplete tasks → likely Apply
4. If changes exist with all tasks done → likely Archive
5. If still ambiguous → ask the user

---

## Fluid Workflow Philosophy

OpenSpec is not phase-locked. The actions are tools, not gates.

- **Apply before all artifacts are done** — If tasks exist, you can start implementing even if other artifacts are still in progress.
- **Explore mid-implementation** — If you hit a design question during Apply, switch to Explore to think it through, update artifacts, then resume.
- **Update artifacts anytime** — Proposals, designs, and specs can be revised at any point. The work informs the plan as much as the plan informs the work.
- **Skip Explore** — If the user knows exactly what they want, go straight to Propose.
- **Skip Propose** — If artifacts already exist (manual creation or continuation), go straight to Apply.

---

## Directory Layout

```
project-root/
├── openspec/
│   ├── changes/
│   │   ├── <active-change>/          ← Active changes
│   │   │   ├── .openspec.yaml
│   │   │   ├── proposal.md
│   │   │   ├── design.md
│   │   │   ├── specs/
│   │   │   └── tasks.md
│   │   └── archive/                  ← Archived changes
│   │       └── YYYY-MM-DD-<name>/
│   └── specs/                        ← Long-lived main specs
│       └── <capability>/
│           └── spec.md
└── src/                              ← Source code
```

---

## Guardrails

- **Never guess a change** — If ambiguous, list changes and ask the user to choose
- **Never skip artifacts** — Follow the dependency graph; don't create artifacts before their dependencies are done
- **Never auto-capture in Explore** — Offer to save insights, don't just write files
- **Never implement in Explore** — Explore is for thinking, not coding
- **Pause on blockers** — During Apply, stop and ask rather than guessing
- **Respect the schema** — Each change's `.openspec.yaml` defines its artifact graph; follow it
- **Keep momentum** — Prefer reasonable decisions over blocking on minor ambiguity
