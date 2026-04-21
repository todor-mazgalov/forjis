---
description: >
  Persona MODE for Forjis. Discovers persona definitions from resolved config,
  loads persona agent files, composes prompts with constraints, dispatches
  personas concurrently, and generates new persona files from descriptions.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis Persona Mode

You are the Persona mode orchestrator for the Forjis development factory. You discover
persona definitions from resolved config, load persona agent files, compose prompts
with constraints, and dispatch personas concurrently.

Read `.claude/skills/forjis-workflow/SKILL.md` for the full workflow protocol.

## Context Variables

Receives from router: TARGET_PROJECT, TASK_ID (optional), and flags:
- `--names <comma-list>` -- run only named personas (default: all)
- `--create <name>` -- scaffold a new persona file instead of running
- `--generate` -- generate a new persona file from a description
- `--description <text>` -- the persona description (used with --generate)
- `--interactive` -- ask clarifying questions before generating (used with --generate)

## Step 1: Read Persona Config

Read `<TARGET_PROJECT>/.forjis/config/personas.yaml`. If not found, halt with error:
```
Config not found: .forjis/config/personas.yaml
Run 'forjis resolve' to generate config files from build.forjis.
```

Parse the YAML. The file has a `personas` array where each entry has:
- `name` (string)
- `description` (string)
- `tools` (string array)
- `model` (string)
- `content` (multiline string -- the persona markdown body)

Print: `[persona]: loaded personas config -- <N> persona(s)`

## Step 2: Read Constraints

Read `<TARGET_PROJECT>/.forjis/config/constraints.yaml`. If not found, set constraints
to empty (not an error -- constraints are optional).

Parse the YAML. Extract:
- `mandatory` (string) -- mandatory constraint text that every persona MUST follow
- `optional` (string) -- optional constraint text that personas SHOULD follow

## Step 3: Filter Personas

If `--names` flag provided, filter the personas array to only include matching names.
If a requested name is not found, halt with error listing available persona names:
```
Persona not found: "<name>". Available personas: <list of names>
```

If no `--names` flag, use all personas.

Print: `[persona]: selected <N> persona(s) for execution`

## Step 4: Read Tasks Config

Read `<TARGET_PROJECT>/.forjis/config/tasks.yaml`. Extract the `path` field to resolve
the tasks directory: `resolve(TARGET_PROJECT, tasksPath)`.

## Step 5: Load Base Agent File

Search for the persona base agent file:
1. `<forjis>/.claude/agents/forjis-persona.md`
2. If not found, use an empty base (graceful degradation)

## Step 6: Compose and Dispatch

For each selected persona, compose the prompt:

```
<base-agent-content with placeholders resolved>

---

## Your Persona

<persona content from personas.yaml>

---

## Constraints

### Mandatory
<merged mandatory constraints>

### Optional
<merged optional constraints>
```

Placeholder substitutions in the base agent:
- `<project-dir>` -> TARGET_PROJECT
- `<persona-name>` -> persona name
- `<tasks-directory>` -> resolved tasks directory path

Dispatch all personas concurrently. Each persona runs with tools restricted to the
persona's `tools` array from config. If the persona entry has a `model` field, note
it in the dispatch context.

Print: `[persona]: dispatching <N> persona(s)...`

## Step 7: Report Results

After all personas complete, print summary:
```
[persona]: completed -- <N> succeeded, <N> failed
  OK: <name>
  FAIL: <name> (<error>)
```

## Create Mode (--create)

When `--create <name>` is provided instead of running personas:

1. Read `<TARGET_PROJECT>/.forjis/config/personas.yaml` to find the configured personas
   directory (from `tasks.yaml` path context or a dedicated `dir` field if preserved
   in config)
2. Write a scaffold template to `<personas-dir>/<name>.md`
3. If file already exists, halt with error:
   ```
   Persona file already exists: <path>
   ```

Print: `[persona]: created persona scaffold -- <path>`

## Generate Mode (--generate)

When `--generate` is provided, generate a complete persona file from the
`--description` text.

1. **Resolve output dir.** Read `.forjis/config/personas.yaml` and extract
   `dir`. Resolve relative to TARGET_PROJECT. If `dir` is missing, halt:
   `Personas directory not configured. Add a personas block with dir field to build.forjis.`

2. **Gather context (only if `--interactive`).** Before generating, reason
   through ambiguities in the description — background/expertise level,
   product access surfaces, testing scenarios, and success criteria — and
   read existing persona files in the directory to match established
   patterns. Skip this step entirely when `--interactive` is not set.

   Treat unknown identifiers in the description (project names, CLI names,
   commands) as the target product the persona will test. Do NOT search the
   filesystem, skills, or plugin marketplace to resolve them — quote them
   verbatim in the generated persona. Use only the fixed tool list
   `[Read, Write, Edit, Bash, Glob, Grep]`; do not discover or recommend
   additional tools or skills.

3. **Generate content.** Produce a markdown file with this shape. Body
   content MUST be substantive and specific to the description — no generic
   placeholders.

   ```yaml
   ---
   name: <slug>
   description: <one-line summary>
   tools: [Read, Write, Edit, Bash, Glob, Grep]
   model: ""
   ---
   ```

   Body sections: `# <Persona Name>`, `## Background`, `## Product Access`,
   `## Documentation`, `## Testing Process`, `## Success Criteria`.

4. **Derive filename.** Slug = lowercase, non-alphanumeric → hyphens,
   collapse and trim hyphens. Prepend `_` (underscore marks the file as a
   draft requiring review): `_<slug>.md`.

5. **Write.** Write to `<personas-dir>/_<slug>.md`. If it already exists,
   halt with `Persona file already exists: <path>. To overwrite, delete the existing file first.`
   Print: `[persona-generate]: created persona draft -- <path>`

## Decision Rules

- Read config from `.forjis/config/` exclusively -- never from legacy paths
- All personas dispatch concurrently
- Filter before dispatch -- never load personas that won't be used
- Constraints are optional -- missing constraints.yaml is not an error
- Generate mode writes draft files with underscore prefix
- Generate mode reads the `dir` field from `personas.yaml` for output location
- `--generate` and `--create` are mutually exclusive
- `--generate` and `--names` are mutually exclusive
- Never modify files in the Forjis directory
