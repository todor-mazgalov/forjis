# Contributing to Forjis

Thank you for your interest in contributing to Forjis. This guide covers the development workflow, coding standards, and PR process.

## Prerequisites

- Node.js >= 20
- npm >= 10
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/todor-mazgalov/forjis.git
cd forjis

# Install dependencies
cd forjis-runtime
npm install

# Build all packages
npm run build

# Run tests
npm test

# Lint
npm run lint
```

### Package Structure

The runtime is a monorepo with six packages built in dependency order:

```
shared -> resolver -> web -> facilitator -> cli
```

The `orchestrator` package contains markdown commands executed by Claude Code and is not published to npm.

## Development Workflow

1. **Fork** the repository and create a feature branch from `main`
2. **Make changes** in the relevant package(s)
3. **Build** to verify TypeScript compilation: `npm run build`
4. **Test** your changes: `npm test`
5. **Lint** your code: `npm run lint`
6. **Commit** using the conventions below
7. **Open a PR** against `main`

## Commit Conventions

Follow this format:

```
type(scope): short description

Optional longer description.
```

**Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`

**Scopes:** package name (`shared`, `resolver`, `facilitator`, `web`, `cli`, `orchestrator`) or a feature area.

Examples:
```
feat(resolver): add wildcard support for constraint includes
fix(facilitator): guard renderEvents against non-TTY stdout
test(facilitator): add unit tests for pre-processor
docs: add CONTRIBUTING.md
```

## Code Style

- TypeScript strict mode is enabled across all packages
- ESLint and Prettier are configured at the monorepo root -- run `npm run lint` to check
- Prefer `import type` for type-only imports
- Use explicit return types on exported functions
- Avoid `any` -- use `unknown` and narrow with type guards

## Testing

- Tests use Jest with `ts-jest` and experimental ESM support
- Place test files next to the source as `<name>.test.ts`
- Run all tests: `npm test` from the `forjis-runtime` root
- Run a single package's tests: `cd <package> && npm test`

## Pull Requests

- Keep PRs focused on a single concern
- Include a clear description of what changed and why
- Link related issues if applicable
- Ensure CI passes (build + lint + test)
- One approval required before merging

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include steps to reproduce for bugs
- Include your Node.js version, OS, and relevant `build.forjis` config

## Plugins

Plugins (agents, skills, hooks) live in a separate repository. If your contribution involves plugin changes, open a PR there instead.
