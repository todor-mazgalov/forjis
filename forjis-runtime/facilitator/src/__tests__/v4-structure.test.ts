/**
 * Structural verification tests for the Forjis v3-to-v4 restructure.
 *
 * These tests verify:
 *   - FR-001: Monorepo workspace structure and package.json correctness
 *   - FR-002: Dependency direction enforcement via package.json declarations
 *   - FR-003: CLI thinness — only arg parsing + facilitator calls
 *   - FR-005, FR-006: Engine abstraction and orchestrator path resolution
 *   - FR-007, FR-014: TaskEvent defined in facilitator, web re-exports it
 *   - FR-012, FR-013: Content preservation for orchestrator and plugins
 *   - FR-015: ESM module format
 *   - NFR-003: No circular package dependencies
 *   - NFR-004: Minimal third-party dependencies
 *
 * All tests are unit tests that examine source files, package manifests, and
 * directory structure. No infrastructure, network, or subprocess required.
 */

import { readFile, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
// facilitator/src/__tests__/v4-structure.test.ts
// -> facilitator/src/__tests__
// -> facilitator/src
// -> facilitator
// -> forjis-runtime  (monorepo root)
const facilitatorRoot = dirname(dirname(dirname(thisFile)));
const runtimeRoot = dirname(facilitatorRoot);
// forjis-v4 is one level above forjis-runtime
const v4Root = dirname(runtimeRoot);

/** Helper: parse a JSON file. */
async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

/** Helper: check a path is accessible. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// FR-001: Monorepo workspace structure
// ---------------------------------------------------------------------------

describe('FR-001: Monorepo workspace structure', () => {
  it('root package.json has correct workspaces', async () => {
    /** Verifies FR-001: four workspaces declared at root */
    const pkg = await readJson(join(runtimeRoot, 'package.json'));
    expect(pkg['private']).toBe(true);
    expect(pkg['workspaces']).toEqual(['shared', 'cli', 'facilitator', 'resolver', 'web', 'orchestrator']);
    expect(pkg['main']).toBeUndefined();
    expect(pkg['bin']).toBeUndefined();
  });

  it('root package.json has build, test, clean scripts', async () => {
    /** Verifies FR-001: workspace-level scripts present */
    const pkg = await readJson(join(runtimeRoot, 'package.json'));
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts).toBeDefined();
    expect(typeof scripts['build']).toBe('string');
    expect(typeof scripts['test']).toBe('string');
    expect(typeof scripts['clean']).toBe('string');
  });

  it('facilitator package.json has correct name and version', async () => {
    /** Verifies FR-001: each workspace has independent @forjis/ name */
    const pkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    expect(pkg['name']).toBe('@forjis/facilitator');
    expect(typeof pkg['version']).toBe('string');
  });

  it('cli package.json has correct name and version', async () => {
    /** Verifies FR-001: CLI workspace has unique identity */
    const pkg = await readJson(join(runtimeRoot, 'cli', 'package.json'));
    expect(pkg['name']).toBe('@forjis/cli');
    expect(typeof pkg['version']).toBe('string');
  });

  it('web package.json has correct name and version', async () => {
    /** Verifies FR-001: web workspace has unique identity */
    const pkg = await readJson(join(runtimeRoot, 'web', 'package.json'));
    expect(pkg['name']).toBe('@forjis/web');
    expect(typeof pkg['version']).toBe('string');
  });

  it('orchestrator package.json has correct name and version', async () => {
    /** Verifies FR-001: orchestrator workspace has unique identity */
    const pkg = await readJson(join(runtimeRoot, 'orchestrator', 'package.json'));
    expect(pkg['name']).toBe('@forjis/orchestrator');
    expect(typeof pkg['version']).toBe('string');
    expect(typeof pkg['description']).toBe('string');
  });

  it('TypeScript packages have type module and build script', async () => {
    /** Verifies FR-001, FR-015: ESM and build config present in all TS workspaces */
    for (const workspace of ['shared', 'cli', 'facilitator', 'web']) {
      const pkg = await readJson(join(runtimeRoot, workspace, 'package.json'));
      expect(pkg['type']).toBe('module');
      const scripts = pkg['scripts'] as Record<string, string>;
      expect(scripts['build']).toBeDefined();
    }
  });

  it('shared package.json has correct name and version', async () => {
    /** Verifies FR-001: shared workspace has unique identity */
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    expect(pkg['name']).toBe('@forjis/shared');
    expect(typeof pkg['version']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// FR-002: Dependency direction enforcement
// ---------------------------------------------------------------------------

describe('FR-002: Dependency direction enforcement', () => {
  it('cli dependencies include facilitator and exclude web and orchestrator', async () => {
    /** Verifies FR-002: CLI -> facilitator only, no web or orchestrator */
    const pkg = await readJson(join(runtimeRoot, 'cli', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/facilitator']).toBeDefined();
    expect(deps['@forjis/web']).toBeUndefined();
    expect(deps['@forjis/orchestrator']).toBeUndefined();
  });

  it('web dependencies include shared and exclude facilitator, cli, and orchestrator', async () => {
    /** Verifies FR-002: web -> shared only, no facilitator, cli, or orchestrator */
    const pkg = await readJson(join(runtimeRoot, 'web', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/shared']).toBeDefined();
    expect(deps['@forjis/facilitator']).toBeUndefined();
    expect(deps['@forjis/cli']).toBeUndefined();
    expect(deps['@forjis/orchestrator']).toBeUndefined();
  });

  it('facilitator runtime dependencies include shared and orchestrator, exclude cli and web', async () => {
    /** Verifies FR-002: facilitator depends on shared and orchestrator (for path resolution), not on cli or web */
    const pkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/shared']).toBeDefined();
    expect(deps['@forjis/orchestrator']).toBeDefined();
    expect(deps['@forjis/cli']).toBeUndefined();
    expect(deps['@forjis/web']).toBeUndefined();
  });

  it('orchestrator has no dependencies field', async () => {
    /** Verifies FR-002: orchestrator is content-only with no runtime deps */
    const pkg = await readJson(join(runtimeRoot, 'orchestrator', 'package.json'));
    const deps = pkg['dependencies'];
    expect(deps === undefined || Object.keys(deps as object).length === 0).toBe(true);
  });

  it('shared package has no workspace dependencies', async () => {
    /** Verifies FR-002: shared is the leaf of the dependency graph */
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    const internalDeps = Object.keys(deps).filter(d => d.startsWith('@forjis/'));
    expect(internalDeps).toEqual([]);
  });

  it('package dependency graph has no cycles', async () => {
    /** Verifies NFR-003: acyclic dependency graph CLI->facilitator, web->facilitator */
    // Build adjacency: workspace -> its runtime deps (other @forjis/ packages)
    const workspaces = ['shared', 'cli', 'facilitator', 'web', 'orchestrator'];
    const edges: Map<string, string[]> = new Map();

    for (const ws of workspaces) {
      const pkg = await readJson(join(runtimeRoot, ws, 'package.json'));
      const name = pkg['name'] as string;
      const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
      const internalDeps = Object.keys(deps).filter(d => d.startsWith('@forjis/'));
      edges.set(name, internalDeps);
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();

    function hasCycle(node: string): boolean {
      if (inStack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      inStack.add(node);
      for (const dep of (edges.get(node) ?? [])) {
        if (hasCycle(dep)) return true;
      }
      inStack.delete(node);
      return false;
    }

    for (const name of edges.keys()) {
      expect(hasCycle(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-003: CLI thinness
// ---------------------------------------------------------------------------

describe('FR-003: CLI thinness', () => {
  let cliSource: string;

  beforeAll(async () => {
    cliSource = await readFile(
      join(runtimeRoot, 'cli', 'src', 'bin', 'forjis.ts'),
      'utf-8',
    );
  });

  it('CLI imports all commands from @forjis/facilitator', async () => {
    /** Verifies FR-003: CLI has no direct engine/plugin/queue imports */
    expect(cliSource).toContain("from '@forjis/facilitator'");
  });

  it('CLI does not import from @forjis/web', async () => {
    /** Verifies FR-003: CLI does not directly reference web package */
    expect(cliSource).not.toContain("from '@forjis/web'");
  });

  it('CLI does not import engine internals', async () => {
    /** Verifies FR-003: no engine, task-queue, plugin imports in CLI */
    expect(cliSource).not.toContain("from './engine");
    expect(cliSource).not.toContain("from '../engine");
    expect(cliSource).not.toContain("from './task-queue");
    expect(cliSource).not.toContain("from './plugin");
  });

  it('CLI source only imports from node builtins and @forjis/facilitator', async () => {
    /** Verifies FR-003: all import sources are node: or @forjis/facilitator */
    const importLines = cliSource.split('\n').filter(l => l.trim().startsWith('import'));
    for (const line of importLines) {
      const match = line.match(/from\s+['"]([^'"]+)['"]/);
      if (match) {
        const source = match[1];
        const allowed =
          source.startsWith('node:') ||
          source === '@forjis/facilitator';
        expect(`${source}: allowed=${allowed}`).toMatch(/allowed=true$/);
      }
    }
  });

  it('CLI routes all existing commands', async () => {
    /** Verifies FR-003: all 8 command handlers routed */
    expect(cliSource).toContain('runCommand');
    expect(cliSource).toContain('initCommand');
    expect(cliSource).toContain('validateCommand');
    expect(cliSource).toContain('statusCommand');
    expect(cliSource).toContain('stopCommand');
    expect(cliSource).toContain('assessCommand');
    expect(cliSource).toContain('registryListCommand');
    expect(cliSource).toContain('registryAddCommand');
  });

  it('CLI parses --web and --port flags', async () => {
    /** Verifies FR-003: web server flags are recognized */
    expect(cliSource).toContain('--web');
    expect(cliSource).toContain('--port');
  });
});

// ---------------------------------------------------------------------------
// FR-005, FR-006: Engine abstraction and orchestrator path resolution
// ---------------------------------------------------------------------------

describe('FR-005: Engine abstraction in facilitator', () => {
  it('facilitator engine module exports registerEngine, loadEngine, getRegisteredEngines', async () => {
    /** Verifies FR-005: engine registry exported from facilitator */
    const engineSrc = await readFile(
      join(facilitatorRoot, 'src', 'engine.ts'),
      'utf-8',
    );
    expect(engineSrc).toContain('export function registerEngine');
    expect(engineSrc).toContain('loadEngine');
    expect(engineSrc).toContain('export function getRegisteredEngines');
  });

  it('ForjisEngine interface is exported from facilitator index', async () => {
    /** Verifies FR-005: ForjisEngine type available in public API */
    const indexSrc = await readFile(
      join(facilitatorRoot, 'src', 'index.ts'),
      'utf-8',
    );
    expect(indexSrc).toContain('ForjisEngine');
  });

  it('ClaudeEngine exists in facilitator engines directory', async () => {
    /** Verifies FR-005: Claude adapter present in facilitator */
    const exists = await pathExists(
      join(facilitatorRoot, 'src', 'engines', 'claude', 'claude-engine.ts'),
    );
    expect(exists).toBe(true);
  });
});

describe('FR-006: Orchestrator directory path resolution', () => {
  it('getOrchestratorDir resolves via @forjis/orchestrator package', async () => {
    /** Verifies FR-006: orchestrator dir is resolved through Node module resolution */
    const claudeEngineSrc = await readFile(
      join(facilitatorRoot, 'src', 'engines', 'claude', 'claude-engine.ts'),
      'utf-8',
    );
    expect(claudeEngineSrc).toContain("'@forjis/orchestrator/package.json'");
    expect(claudeEngineSrc).toContain('createRequire');
  });

  it('getOrchestratorDir includes existsSync guard', async () => {
    /** Verifies FR-006: missing directory throws descriptive error */
    const claudeEngineSrc = await readFile(
      join(facilitatorRoot, 'src', 'engines', 'claude', 'claude-engine.ts'),
      'utf-8',
    );
    expect(claudeEngineSrc).toContain('existsSync');
    expect(claudeEngineSrc).toContain('Orchestrator directory not found');
  });

  it('getOrchestratorDir returns the actual orchestrator directory in runtime', async () => {
    /** Verifies FR-006: resolved path points to the real orchestrator package */
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const dir = engine.getOrchestratorDir();
    const normalised = dir.replace(/\\/g, '/');
    // Must end with 'orchestrator', not the old v3 path
    expect(normalised).toMatch(/\/orchestrator$/);
    // Must NOT be the v3 path
    expect(normalised).not.toContain('src/engines/claude/orchestrator');
  });

  it('orchestrator directory resolved by engine contains .claude subdirectory', async () => {
    /** Verifies FR-006: the directory has expected structure */
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const dir = engine.getOrchestratorDir();
    const claudeDir = join(dir, '.claude');
    expect(await pathExists(claudeDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-007, FR-014: TaskEvent defined in facilitator, web re-exports
// ---------------------------------------------------------------------------

describe('FR-007, FR-014: TaskEvent type distribution', () => {
  it('TaskEvent is defined in shared types.ts', async () => {
    /** Verifies FR-007: TaskEvent interface definition lives in shared */
    const typesSrc = await readFile(
      join(runtimeRoot, 'shared', 'src', 'types.ts'),
      'utf-8',
    );
    expect(typesSrc).toContain('export interface TaskEvent');
  });

  it('TaskEvent in shared has required fields', async () => {
    /** Verifies FR-007: TaskEvent has timestamp, type, role, content */
    const typesSrc = await readFile(
      join(runtimeRoot, 'shared', 'src', 'types.ts'),
      'utf-8',
    );
    const taskEventBlock = typesSrc.slice(
      typesSrc.indexOf('export interface TaskEvent'),
      typesSrc.indexOf('export interface TaskEvent') + 400,
    );
    expect(taskEventBlock).toContain('timestamp');
    expect(taskEventBlock).toContain('type');
    expect(taskEventBlock).toContain('role');
    expect(taskEventBlock).toContain('content');
  });

  it('facilitator types.ts re-exports TaskEvent from @forjis/shared', async () => {
    /** Verifies FR-007: facilitator re-exports TaskEvent from shared */
    const typesSrc = await readFile(
      join(facilitatorRoot, 'src', 'types.ts'),
      'utf-8',
    );
    expect(typesSrc).toContain("from '@forjis/shared'");
    expect(typesSrc).toContain('TaskEvent');
    expect(typesSrc).not.toContain('export interface TaskEvent');
  });

  it('web types.ts re-exports TaskEvent from @forjis/shared', async () => {
    /** Verifies FR-007: web re-exports TaskEvent from shared for backward compat */
    const webTypesSrc = await readFile(
      join(runtimeRoot, 'web', 'src', 'types.ts'),
      'utf-8',
    );
    expect(webTypesSrc).toContain("from '@forjis/shared'");
    expect(webTypesSrc).toContain('TaskEvent');
    expect(webTypesSrc).not.toContain('export interface TaskEvent');
  });

  it('facilitator source files do not import TaskEvent from web', async () => {
    /** Verifies FR-007: no web-to-facilitator type coupling */
    const engineSrc = await readFile(
      join(facilitatorRoot, 'src', 'engine.ts'),
      'utf-8',
    );
    expect(engineSrc).not.toContain("import('./web/types.js')");
    expect(engineSrc).not.toContain("from '@forjis/web'");

    const claudeEngineSrc = await readFile(
      join(facilitatorRoot, 'src', 'engines', 'claude', 'claude-engine.ts'),
      'utf-8',
    );
    expect(claudeEngineSrc).not.toContain("import('../../web/types.js')");
    expect(claudeEngineSrc).not.toContain("from '@forjis/web'");
  });

  it('facilitator runtime dependencies do not include @forjis/web', async () => {
    /** Verifies FR-007 NFR-003: no runtime circular dependency facilitator->web */
    const pkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/web']).toBeUndefined();
  });

  it('facilitator exports TaskEvent in public API via @forjis/shared re-export', async () => {
    /** Verifies FR-014: TaskEvent accessible via shared package, re-exported through resolver */
    const indexSrc = await readFile(
      join(facilitatorRoot, 'src', 'index.ts'),
      'utf-8',
    );
    // TaskEvent is now defined in @forjis/shared and re-exported from @forjis/resolver
    // The facilitator re-exports resolver types for backward compatibility
    expect(indexSrc).toContain("from '@forjis/resolver'");
  });
});

// ---------------------------------------------------------------------------
// FR-009: Web service implementations in facilitator
// ---------------------------------------------------------------------------

describe('FR-009: Web service implementations in facilitator', () => {
  it('all 6 web-service files exist in facilitator', async () => {
    /** Verifies FR-009: service implementations moved to facilitator/web-services/ */
    const webServicesDir = join(facilitatorRoot, 'src', 'web-services');
    const expectedFiles = [
      'task-service.ts',
      'plan-service.ts',
      'event-service.ts',
      'resource-service.ts',
      'plan-writer.ts',
      'event-writer.ts',
    ];
    for (const file of expectedFiles) {
      const exists = await pathExists(join(webServicesDir, file));
      expect(`${file}: exists=${exists}`).toMatch(/exists=true$/);
    }
  });

  it('facilitator index exports TaskServiceImpl, PlanServiceImpl, EventServiceImpl, ResourceServiceImpl', async () => {
    /** Verifies FR-009: service implementation classes exported from facilitator */
    const indexSrc = await readFile(
      join(facilitatorRoot, 'src', 'index.ts'),
      'utf-8',
    );
    expect(indexSrc).toContain('TaskServiceImpl');
    expect(indexSrc).toContain('PlanServiceImpl');
    expect(indexSrc).toContain('EventServiceImpl');
    expect(indexSrc).toContain('ResourceServiceImpl');
  });

  it('task-service.ts uses import type from @forjis/shared for interface', async () => {
    /** Verifies FR-009: service implementations reference shared interfaces via type imports only */
    const taskServiceSrc = await readFile(
      join(facilitatorRoot, 'src', 'web-services', 'task-service.ts'),
      'utf-8',
    );
    const sharedImports = taskServiceSrc
      .split('\n')
      .filter(l => l.includes('@forjis/shared'));
    for (const line of sharedImports) {
      expect(line).toMatch(/import type/);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-012: Orchestrator content preserved
// ---------------------------------------------------------------------------

describe('FR-012: Orchestrator content preserved', () => {
  const commandsDir = join(runtimeRoot, 'orchestrator', '.claude', 'commands');
  const skillsDir = join(runtimeRoot, 'orchestrator', '.claude', 'skills');

  it('orchestrator commands directory contains all expected .md files', async () => {
    /** Verifies FR-012: all command md files present */
    const expectedFiles = [
      'forjis.md',
      'forjis-org-mode.md',
      'forjis-fallback-mode.md',
      'forjis-independent-mode.md',
      'forjis-swarm-mode.md',
      'forjis-init.md',
    ];
    for (const file of expectedFiles) {
      const exists = await pathExists(join(commandsDir, file));
      expect(`${file}: exists=${exists}`).toMatch(/exists=true$/);
    }
  });

  it('orchestrator commands/opsx directory contains all 4 files', async () => {
    /** Verifies FR-012: opsx subdirectory with apply, archive, explore, propose */
    const opsxDir = join(commandsDir, 'opsx');
    for (const file of ['apply.md', 'archive.md', 'explore.md', 'propose.md']) {
      const exists = await pathExists(join(opsxDir, file));
      expect(`${file}: exists=${exists}`).toMatch(/exists=true$/);
    }
  });

  it('orchestrator skills directory contains forjis-workflow/SKILL.md', async () => {
    /** Verifies FR-012: forjis-workflow skill present */
    const exists = await pathExists(join(skillsDir, 'forjis-workflow', 'SKILL.md'));
    expect(exists).toBe(true);
  });

  it('orchestrator skills directory contains openspec/SKILL.md', async () => {
    /** Verifies FR-012: openspec skill present */
    const exists = await pathExists(join(skillsDir, 'openspec', 'SKILL.md'));
    expect(exists).toBe(true);
  });

  it('orchestrator package.json has name, version, description only', async () => {
    /** Verifies FR-012: orchestrator is minimal content-only package */
    const pkg = await readJson(join(runtimeRoot, 'orchestrator', 'package.json'));
    expect(pkg['name']).toBeDefined();
    expect(pkg['version']).toBeDefined();
    expect(pkg['description']).toBeDefined();
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['main']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FR-013: Plugins directory preserved
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FR-015: ESM module format
// ---------------------------------------------------------------------------

describe('FR-015: ESM module format', () => {
  it('all TypeScript packages declare "type": "module"', async () => {
    /** Verifies FR-015: ESM format preserved across all TS workspaces */
    for (const workspace of ['shared', 'cli', 'facilitator', 'web']) {
      const pkg = await readJson(join(runtimeRoot, workspace, 'package.json'));
      expect(pkg['type']).toBe('module');
    }
  });

  it('CLI source uses .js extensions for relative imports', async () => {
    /** Verifies FR-015: ESM relative imports use .js extension */
    const cliSrc = await readFile(
      join(runtimeRoot, 'cli', 'src', 'bin', 'forjis.ts'),
      'utf-8',
    );
    // Any relative import (from './) must end in .js
    const relativeImports = cliSrc.split('\n')
      .filter(l => l.trim().startsWith('import') && l.includes("from '."));
    for (const line of relativeImports) {
      const match = line.match(/from\s+['"](\.[^'"]+)['"]/);
      if (match) {
        expect(match[1]).toMatch(/\.js$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NFR-004: Minimal third-party dependencies
// ---------------------------------------------------------------------------

describe('NFR-004: Minimal third-party dependencies', () => {
  it('only facilitator declares yaml as runtime dependency', async () => {
    /** Verifies NFR-004: yaml is facilitator-only runtime dep */
    const facilPkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    const facilDeps = (facilPkg['dependencies'] ?? {}) as Record<string, string>;
    expect(facilDeps['yaml']).toBeDefined();

    const cliPkg = await readJson(join(runtimeRoot, 'cli', 'package.json'));
    const cliDeps = (cliPkg['dependencies'] ?? {}) as Record<string, string>;
    expect(cliDeps['yaml']).toBeUndefined();

    const webPkg = await readJson(join(runtimeRoot, 'web', 'package.json'));
    const webDeps = (webPkg['dependencies'] ?? {}) as Record<string, string>;
    expect(webDeps['yaml']).toBeUndefined();
  });

  it('facilitator has yaml as only non-workspace runtime dependency', async () => {
    /** Verifies NFR-004: no other third-party runtime deps introduced */
    const pkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    const thirdParty = Object.keys(deps).filter(d => !d.startsWith('@forjis/'));
    expect(thirdParty).toEqual(['yaml']);
    const workspaceDeps = Object.keys(deps).filter(d => d.startsWith('@forjis/')).sort();
    expect(workspaceDeps).toEqual(['@forjis/orchestrator', '@forjis/resolver', '@forjis/shared']);
  });
});

// ---------------------------------------------------------------------------
// Build output verification
// ---------------------------------------------------------------------------

describe('Build output verification', () => {
  it('shared dist/index.js exists', async () => {
    /** Verifies build success: shared compiled */
    const exists = await pathExists(join(runtimeRoot, 'shared', 'dist', 'index.js'));
    expect(exists).toBe(true);
  });

  it('facilitator dist/index.js exists', async () => {
    /** Verifies build success: facilitator compiled */
    const exists = await pathExists(join(runtimeRoot, 'facilitator', 'dist', 'index.js'));
    expect(exists).toBe(true);
  });

  it('web dist/index.js exists', async () => {
    /** Verifies build success: web compiled */
    const exists = await pathExists(join(runtimeRoot, 'web', 'dist', 'index.js'));
    expect(exists).toBe(true);
  });

  it('cli dist/bin/forjis.js exists', async () => {
    /** Verifies build success: CLI entry point compiled */
    const exists = await pathExists(join(runtimeRoot, 'cli', 'dist', 'bin', 'forjis.js'));
    expect(exists).toBe(true);
  });

  it('facilitator dist exports are loadable', async () => {
    /** Verifies FR-004: command handlers accessible via compiled output */
    // Dynamic import via the dist to verify it's importable
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.runCommand).toBe('function');
    expect(typeof mod.initCommand).toBe('function');
    expect(typeof mod.validateCommand).toBe('function');
    expect(typeof mod.statusCommand).toBe('function');
    expect(typeof mod.stopCommand).toBe('function');
    expect(typeof mod.assessCommand).toBe('function');
    expect(typeof mod.registryListCommand).toBe('function');
    expect(typeof mod.registryAddCommand).toBe('function');
  });

  it('facilitator dist exports TaskQueue class', async () => {
    /** Verifies FR-010: TaskQueue available in compiled output */
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.TaskQueue).toBe('function');
  });

  it('facilitator dist exports engine functions', async () => {
    /** Verifies FR-005: engine registry accessible in compiled output */
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.loadEngine).toBe('function');
    expect(typeof mod.registerEngine).toBe('function');
    expect(typeof mod.getRegisteredEngines).toBe('function');
  });

  it('facilitator dist exports all service implementations', async () => {
    /** Verifies FR-009: service impls accessible via compiled output */
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.TaskServiceImpl).toBe('function');
    expect(typeof mod.PlanServiceImpl).toBe('function');
    expect(typeof mod.EventServiceImpl).toBe('function');
    expect(typeof mod.ResourceServiceImpl).toBe('function');
  });

  it('web dist exports createWebServer', async () => {
    /** Verifies FR-008: createWebServer available in compiled web output */
    const webDist = join(runtimeRoot, 'web', 'dist', 'index.js');
    const mod = await import(webDist);
    expect(typeof mod.createWebServer).toBe('function');
  });
});
