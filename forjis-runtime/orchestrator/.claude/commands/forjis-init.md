---
description: >
  Initialize Forjis in a target project. Creates openspec/config.yaml with
  auto-detected project settings and .forjis/tasks/ for pipeline metadata.
  Does NOT copy agents or commands — those stay in the Forjis project.
  Run once per target project.
argument-hint: <project-path>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Forjis Project Initialization

You are initializing Forjis support in an external target project.
Forjis agents, commands, and skills stay in the current Forjis directory.
The target project gets `openspec/config.yaml` for project configuration
and `.forjis/tasks/` for pipeline metadata.

**Target project path:** $ARGUMENTS

If the path is `.` or empty, ask the user for a path — the current directory
is the Forjis tool itself, not a target project.

## Procedure

### Step 1: Validate the target path

Verify `$ARGUMENTS` is a valid directory. If it does not exist, create it.
Resolve to an absolute path and store as TARGET_PROJECT.

### Step 2: Initialize OpenSpec

If `<TARGET_PROJECT>/openspec/` does not exist, initialize OpenSpec:

```bash
cd <TARGET_PROJECT>
openspec init --tools claude
```

If `openspec` CLI is not available on PATH, fail immediately with a clear error message.

If `openspec/` already exists, skip this step.

### Step 3: Create .forjis directory

```bash
mkdir -p <TARGET_PROJECT>/.forjis/tasks
```

### Step 4: Auto-detect project profile

`cd <TARGET_PROJECT>` and scan the project root up to 2 levels deep. Use the
**Project Detection Reference** appendix in `forjis-workflow/SKILL.md` to
classify:

1. **Language + version** — detect all languages present; note the primary.
2. **Build tool + package manager** — from lockfiles and manifests.
3. **Framework** — match dependency markers.
4. **Testing framework** — from test-scope dependencies.
5. **Project type** — classify using the signals table (`backend-api`,
   `full-stack`, `frontend`, `salesforce`, `cli`, `mobile`, `library`,
   `unknown`, etc.).
6. **Monorepo / multi-module** — if detected, scan each subproject
   separately and build a combined profile.
7. **Conventions & tooling** — linters, formatters, CI, env vars,
   framework-specific config files.

For each category, extract the values listed in the appendix's "Version
source" / "Extract" columns where present. Record everything detected —
they become the inputs for Step 5.

### Step 5: Write openspec/config.yaml

Write `<TARGET_PROJECT>/openspec/config.yaml` using OpenSpec's native project
config format. The `context` field is injected into all `openspec instructions`
calls, so agents automatically receive project context.

```yaml
schema: spec-driven

context: |
  ## Project
  - Name: <detected from manifest or directory name>
  - Type: <detected project type>
  - Description: <from manifest description field, or "Edit this">

  ## Technology Stack
  - Language: <detected language> <version>
  - Runtime: <detected runtime>
  - Package Manager: <detected PM>
  - Build Tool: <detected build tool, if separate from PM>
  - Framework: <detected framework or "(Architect will select)">
  - Database: <detected or "(Architect will select)">
  - Testing: <detected or "(Architect will select)">

  ## Project Conventions
  ### Code Style
  <filled from detected linters/formatters, or sensible defaults for the language>
  ### File Naming
  <filled from detected conventions or language defaults>
  ### Directory Structure
  <actual directory layout detected from the project>

  ## Git
  - Default Branch: <detected from git, or "main">
  - Branch Prefix: forjis/

  ## Constraints
  - <detected constraints, or sensible defaults>

  ## Pipeline Limits
  - Max Analyst Iterations: 3
  - Max Architect Iterations: 3
  - Max Dev-Review Cycles: 5

  ## Additional Context
  <PROJECT-TYPE-SPECIFIC CONTEXT — see below>

rules:
  specs:
    - "Every requirement MUST be testable by an automated unit test"
    - "Use FR-xxx for functional, NFR-xxx for non-functional requirements"
  proposal:
    - "Include scope boundaries and out-of-scope items"
  design:
    - "Target fewer than 5 runtime dependencies"
    - "Include requirements traceability matrix"
  tasks:
    - "Each task should create/modify 1-4 files"
    - "4-8 tasks typical for a standard feature"
```

**For Java/Spring Boot, add to Additional Context:**
```
### Java Project Context
- Build Tool: Maven / Gradle (detected)
- Java Version: <detected>
- Framework: Spring Boot <version>
- Key Starters: <list detected starters>
- Testing: JUnit 5 + Mockito + Spring Boot Test
- Code Style: <Checkstyle/Spotless/Google Java Format if detected>
- Developer must use `./mvnw` or `./gradlew` wrappers
- Reviewer runs `./mvnw test` or `./gradlew test`
- Config in `src/main/resources/application.yml`
- Controllers in `<package>/controller/`
- Services in `<package>/service/`
- Repositories in `<package>/repository/`
- Standard Maven/Gradle layout (src/main/java, src/test/java)
- Constructor injection only (no @Autowired on fields)
- Lombok: <available/not detected>
```

**For Kotlin, write:** Kotlin DSL, data class for DTOs, sealed class for errors, coroutines guidance.

**For frontend, Salesforce, CLI, mobile, full-stack, etc.** — same pattern:
detected values + project-type-specific agent guidance.

For anything not detected: `(not detected — edit openspec/config.yaml)`.

### Step 6: Generate `config/orgs.yaml`

Generate `<TARGET_PROJECT>/.forjis/config/orgs.yaml` with a minimal org definition based on
auto-detected stack. If the file already exists (in `.forjis/` or legacy project root), skip this step.

**Template:**

```yaml
version: 1

orgs:
  - org: <ProjectName>
    teams:
      Dev:
        roles:
          Explorer:
            agent: "forjis-explorer.md"
          Analyst:
            agent: "forjis-analyst.md"
          Architect:
            agent: "forjis-fullstack-architect.md"
          Developer:
            agent: "forjis-fullstack-developer.md"
            skills: <auto-detected>
          Reviewer:
            agent: "forjis-fullstack-reviewer.md"
```

**Org name:** Derive from the target project directory name, PascalCase (e.g., `my-app` → `MyApp`).

**Skills auto-detection:**
- Java project (pom.xml / build.gradle) → `skills: ["java"]` on Developer
- PostgreSQL detected (spring-data-jpa, pg driver, etc.) → add `skills: ["postgre"]` on Developer
- SolidJS detected → add a `SolidJSDeveloper` role:
  ```yaml
  SolidJSDeveloper:
    agent: "forjis-frontend-developer.md"
    skills: ["solidjs", "ui"]
    expertise: "Frontend SolidJS development"
    stage: developer
  ```
- If both Java backend + SolidJS frontend detected → add a `JavaDeveloper` role:
  ```yaml
  JavaDeveloper:
    agent: "forjis-backend-developer.md"
    skills: ["java", "postgre"]
    expertise: "Backend Java development"
    stage: developer
  ```

**No hooks by default.** Users can add hooks later by creating files in `<forjis>/.claude/hooks/` and referencing them in the org file.

### Step 7: Report

```
═══════════════════════════════════════════════════
 Forjis initialized in: <TARGET_PROJECT>
═══════════════════════════════════════════════════

 Detected:
   Language:        <detected>
   Build Tool:      <detected>
   Framework:       <detected>
   Testing:         <detected>
   Project Type:    <detected>

 Created:
   <TARGET_PROJECT>/openspec/config.yaml
   <TARGET_PROJECT>/.forjis/config/orgs.yaml
   <TARGET_PROJECT>/.forjis/tasks/

 Next steps:
   1. Review <TARGET_PROJECT>/openspec/config.yaml
   2. Review <TARGET_PROJECT>/.forjis/config/orgs.yaml (org roles and skills)
   3. From the Forjis directory, run:
      /forjis <TARGET_PROJECT> <task-id> <description>
═══════════════════════════════════════════════════
```

## Rules

- Create `openspec/config.yaml`, `.forjis/config/orgs.yaml`, and `.forjis/tasks/` in the target project
- Do NOT copy agents, commands, or skills to the target project
- Do NOT modify source code in the target project
- Do NOT modify any files in the Forjis directory
- Auto-detect as much as possible to minimize manual editing
