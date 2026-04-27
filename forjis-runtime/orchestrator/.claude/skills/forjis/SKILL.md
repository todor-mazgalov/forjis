---
name: forjis
description: >
  Forjis pipeline orchestrator entry point. Dispatches to the unified
  command router which detects execution mode (ORG, Swarm, Independent,
  Fallback, Persona, Strategist, Assess) and delegates to the appropriate
  mode handler.
---

# Forjis Entry Point

Use the `Read` tool to load `.claude/commands/forjis.md` (relative to your cwd, which is the orchestrator directory). Substitute every occurrence of `$ARGUMENTS` in that file with the args string you were invoked with, then follow the resulting instructions exactly as if they were your own.

The command file is the canonical orchestrator router — do not duplicate its logic here, do not search for it elsewhere, and do not list directories looking for skills or commands. The path is fixed: `.claude/commands/forjis.md`.
