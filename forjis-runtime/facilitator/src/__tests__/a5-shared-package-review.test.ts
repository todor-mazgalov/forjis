/**
 * Review tests for a5-build-fix: shared package extraction.
 *
 * Validates:
 *   1. Package structure — shared package exists with correct package.json
 *   2. Type definitions — all expected types exist in @forjis/shared
 *   3. Service interfaces — all 8 service interfaces exist in @forjis/shared
 *   4. Backward compatibility — types re-exported from original packages
 *   5. Dependency graph — no circular deps, correct dependency directions
 *   6. Build script — no bootstrap/error-ignoring, correct 4-step order
 *   7. Compilation — dist outputs exist for all packages
 */

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const facilitatorRoot = dirname(dirname(dirname(thisFile)));
const runtimeRoot = dirname(facilitatorRoot);

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
// 1. Shared package scaffold
// ---------------------------------------------------------------------------

describe('Shared package scaffold', () => {
  it('shared/package.json has correct name, version, and type', async () => {
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    expect(pkg['name']).toBe('@forjis/shared');
    expect(pkg['version']).toBe('0.5.1');
    expect(pkg['type']).toBe('module');
  });

  it('shared/package.json has ESM exports with types and import conditions', async () => {
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    const exports = pkg['exports'] as Record<string, unknown>;
    expect(exports).toBeDefined();
    const mainExport = exports['.'] as Record<string, string>;
    expect(mainExport['types']).toBe('./dist/index.d.ts');
    expect(mainExport['import']).toBe('./dist/index.js');
  });

  it('shared/package.json has zero runtime dependencies', async () => {
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    expect(deps).toBeUndefined();
  });

  it('shared/package.json has only devDependencies for @types/node and typescript', async () => {
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    const devDeps = pkg['devDependencies'] as Record<string, string>;
    expect(devDeps).toBeDefined();
    expect(devDeps['@types/node']).toBeDefined();
    expect(devDeps['typescript']).toBeDefined();
    // No other devDeps besides these two
    const keys = Object.keys(devDeps);
    expect(keys.sort()).toEqual(['@types/node', 'typescript']);
  });

  it('shared/tsconfig.json has ES2022 target, Node16 module, strict, declaration', async () => {
    const tsconfig = await readJson(join(runtimeRoot, 'shared', 'tsconfig.json'));
    const opts = tsconfig['compilerOptions'] as Record<string, unknown>;
    expect(opts['target']).toBe('ES2022');
    expect(opts['module']).toBe('Node16');
    expect(opts['moduleResolution']).toBe('Node16');
    expect(opts['strict']).toBe(true);
    expect(opts['declaration']).toBe(true);
  });

  it('workspaces array has shared before other packages', async () => {
    const pkg = await readJson(join(runtimeRoot, 'package.json'));
    const workspaces = pkg['workspaces'] as string[];
    expect(workspaces[0]).toBe('shared');
    expect(workspaces).toContain('cli');
    expect(workspaces).toContain('facilitator');
    expect(workspaces).toContain('web');
    expect(workspaces).toContain('orchestrator');
  });
});

// ---------------------------------------------------------------------------
// 2. Shared types — all expected types defined
// ---------------------------------------------------------------------------

describe('Shared types definitions', () => {
  let typesSrc: string;

  beforeAll(async () => {
    typesSrc = await readFile(
      join(runtimeRoot, 'shared', 'src', 'types.ts'),
      'utf-8',
    );
  });

  it('defines TaskStatus type', () => {
    expect(typesSrc).toContain('export type TaskStatus');
  });

  it('defines TaskEvent interface', () => {
    expect(typesSrc).toContain('export interface TaskEvent');
  });

  it('TaskStatus includes all expected values', () => {
    expect(typesSrc).toContain("'pending'");
    expect(typesSrc).toContain("'queued'");
    expect(typesSrc).toContain("'running'");
    expect(typesSrc).toContain("'done'");
    expect(typesSrc).toContain("'failed'");
    expect(typesSrc).toContain("'needs_clarification'");
  });

  it('defines all DTO types from web', () => {
    const expectedTypes = [
      'TaskListItem',
      'PipelinePlanResponse',
      'PipelineStep',
      'ResourcesResponse',
      'OrgResource',
      'TeamResource',
      'RoleResource',
      'AgentResource',
      'SkillResource',
      'HookResource',
      'PluginResource',
      'ErrorResponse',
      'TokenUsageResponse',
      'ManifestFileEntry',
      'ManifestResponse',
      'WebServerOptions',
    ];
    for (const typeName of expectedTypes) {
      expect(typesSrc).toContain(`export interface ${typeName}`);
    }
  });

  it('WebServerOptions references service interfaces from ./services.js', () => {
    expect(typesSrc).toContain("from './services.js'");
    // WebServerOptions should reference service types
    const webServerBlock = typesSrc.slice(
      typesSrc.indexOf('export interface WebServerOptions'),
    );
    expect(webServerBlock).toContain('taskService: TaskService');
    expect(webServerBlock).toContain('planService: PlanService');
    expect(webServerBlock).toContain('eventService: EventService');
    expect(webServerBlock).toContain('resourceService: ResourceService');
  });

  it('all exported interfaces have JSDoc comments', () => {
    // Every 'export interface' or 'export type' should be preceded by a JSDoc comment
    const lines = typesSrc.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('export interface ') || line.startsWith('export type TaskStatus')) {
        // Look backward for JSDoc closing
        let foundJsdoc = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          if (prev === '') continue;
          if (prev.endsWith('*/')) {
            foundJsdoc = true;
            break;
          }
          break; // Non-empty, non-JSDoc line
        }
        expect(`${line}: hasJSDoc=${foundJsdoc}`).toMatch(/hasJSDoc=true$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Shared services — all 8 service interfaces defined
// ---------------------------------------------------------------------------

describe('Shared service interfaces', () => {
  let servicesSrc: string;

  beforeAll(async () => {
    servicesSrc = await readFile(
      join(runtimeRoot, 'shared', 'src', 'services.ts'),
      'utf-8',
    );
  });

  it('defines all 8 service interfaces', () => {
    const expectedInterfaces = [
      'TaskService',
      'PlanService',
      'EventService',
      'ResourceService',
      'TokenUsageService',
      'FileService',
      'TaskFileService',
      'ManifestService',
    ];
    for (const iface of expectedInterfaces) {
      expect(servicesSrc).toContain(`export interface ${iface}`);
    }
  });

  it('services.ts imports DTO types from ./types.js', () => {
    expect(servicesSrc).toContain("from './types.js'");
  });

  it('all service interfaces have JSDoc comments', () => {
    const lines = servicesSrc.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('export interface ')) {
        let foundJsdoc = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          if (prev === '') continue;
          if (prev.endsWith('*/')) {
            foundJsdoc = true;
            break;
          }
          break;
        }
        expect(`${line}: hasJSDoc=${foundJsdoc}`).toMatch(/hasJSDoc=true$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Shared barrel export
// ---------------------------------------------------------------------------

describe('Shared barrel export', () => {
  it('index.ts re-exports from ./types.js and ./services.js', async () => {
    const indexSrc = await readFile(
      join(runtimeRoot, 'shared', 'src', 'index.ts'),
      'utf-8',
    );
    expect(indexSrc).toContain("export * from './types.js'");
    expect(indexSrc).toContain("export * from './services.js'");
  });
});

// ---------------------------------------------------------------------------
// 5. Backward compatibility — web re-exports
// ---------------------------------------------------------------------------

describe('Web backward compatibility re-exports', () => {
  it('web/src/types.ts re-exports all DTO types from @forjis/shared', async () => {
    const webTypes = await readFile(
      join(runtimeRoot, 'web', 'src', 'types.ts'),
      'utf-8',
    );
    expect(webTypes).toContain("from '@forjis/shared'");
    // All 16 types should be re-exported
    const expectedTypes = [
      'TaskStatus', 'TaskEvent', 'TaskListItem', 'PipelinePlanResponse',
      'PipelineStep', 'ResourcesResponse', 'OrgResource', 'TeamResource',
      'RoleResource', 'AgentResource', 'SkillResource', 'HookResource',
      'PluginResource', 'ErrorResponse', 'TokenUsageResponse',
      'ManifestFileEntry', 'ManifestResponse', 'WebServerOptions',
    ];
    for (const typeName of expectedTypes) {
      expect(webTypes).toContain(typeName);
    }
    // Should NOT have local definitions
    expect(webTypes).not.toContain('export interface TaskEvent');
    expect(webTypes).not.toContain('export interface TaskListItem');
  });

  it('web/src/services.ts re-exports all 8 service interfaces from @forjis/shared', async () => {
    const webServices = await readFile(
      join(runtimeRoot, 'web', 'src', 'services.ts'),
      'utf-8',
    );
    expect(webServices).toContain("from '@forjis/shared'");
    const expectedInterfaces = [
      'TaskService', 'PlanService', 'EventService', 'ResourceService',
      'TokenUsageService', 'FileService', 'TaskFileService', 'ManifestService',
    ];
    for (const iface of expectedInterfaces) {
      expect(webServices).toContain(iface);
    }
    // Should NOT have local definitions
    expect(webServices).not.toContain('export interface TaskService');
  });

  it('web/src/index.ts barrel is unchanged (re-exports from ./types.js and ./services.js)', async () => {
    const webIndex = await readFile(
      join(runtimeRoot, 'web', 'src', 'index.ts'),
      'utf-8',
    );
    expect(webIndex).toContain("from './types.js'");
    expect(webIndex).toContain("from './services.js'");
    expect(webIndex).toContain('createWebServer');
  });
});

// ---------------------------------------------------------------------------
// 6. Backward compatibility — facilitator re-exports
// ---------------------------------------------------------------------------

describe('Facilitator backward compatibility re-exports', () => {
  it('facilitator/src/types.ts re-exports TaskStatus from @forjis/shared', async () => {
    const facilTypes = await readFile(
      join(runtimeRoot, 'facilitator', 'src', 'types.ts'),
      'utf-8',
    );
    expect(facilTypes).toContain("export type { TaskStatus } from '@forjis/shared'");
    // Should NOT define TaskStatus locally
    expect(facilTypes).not.toContain('export type TaskStatus =');
  });

  it('facilitator/src/types.ts re-exports TaskEvent from @forjis/shared', async () => {
    const facilTypes = await readFile(
      join(runtimeRoot, 'facilitator', 'src', 'types.ts'),
      'utf-8',
    );
    expect(facilTypes).toContain("export type { TaskEvent } from '@forjis/shared'");
    // Should NOT define TaskEvent locally
    expect(facilTypes).not.toContain('export interface TaskEvent');
  });

  it('facilitator/src/types.ts re-exports config types from resolver and defines facilitator-only types', async () => {
    const facilTypes = await readFile(
      join(runtimeRoot, 'facilitator', 'src', 'types.ts'),
      'utf-8',
    );
    expect(facilTypes).toContain("from '@forjis/resolver'");
    expect(facilTypes).toContain('export interface TaskState');
    expect(facilTypes).toContain('export class PromptOptions');
    expect(facilTypes).toContain('export type TaskPriority');
  });

  it('facilitator/src/index.ts barrel exports types from types.ts', async () => {
    const facilIndex = await readFile(
      join(runtimeRoot, 'facilitator', 'src', 'index.ts'),
      'utf-8',
    );
    expect(facilIndex).toContain("from './types.js'");
  });
});

// ---------------------------------------------------------------------------
// 7. Dependency graph — correct directions
// ---------------------------------------------------------------------------

describe('Dependency graph correctness', () => {
  it('web depends on @forjis/shared, not @forjis/facilitator', async () => {
    const pkg = await readJson(join(runtimeRoot, 'web', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/shared']).toBe('0.5.1');
    expect(deps['@forjis/facilitator']).toBeUndefined();
  });

  it('facilitator depends on @forjis/shared, not @forjis/web', async () => {
    const pkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/shared']).toBe('0.5.1');
    expect(deps['@forjis/web']).toBeUndefined();
  });

  it('facilitator does NOT have @forjis/web in devDependencies', async () => {
    const pkg = await readJson(join(runtimeRoot, 'facilitator', 'package.json'));
    const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, string>;
    expect(devDeps['@forjis/web']).toBeUndefined();
  });

  it('shared has zero workspace dependencies (leaf node)', async () => {
    const pkg = await readJson(join(runtimeRoot, 'shared', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    const internalDeps = Object.keys(deps).filter(d => d.startsWith('@forjis/'));
    expect(internalDeps).toEqual([]);
  });

  it('cli depends on facilitator only (no shared, web, orchestrator)', async () => {
    const pkg = await readJson(join(runtimeRoot, 'cli', 'package.json'));
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/facilitator']).toBeDefined();
    expect(deps['@forjis/shared']).toBeUndefined();
    expect(deps['@forjis/web']).toBeUndefined();
    expect(deps['@forjis/orchestrator']).toBeUndefined();
  });

  it('no circular dependencies in the package graph', async () => {
    const workspaces = ['shared', 'cli', 'facilitator', 'web', 'orchestrator'];
    const edges: Map<string, string[]> = new Map();

    for (const ws of workspaces) {
      const pkg = await readJson(join(runtimeRoot, ws, 'package.json'));
      const name = pkg['name'] as string;
      const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
      const internalDeps = Object.keys(deps).filter(d => d.startsWith('@forjis/'));
      edges.set(name, internalDeps);
    }

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
// 8. Facilitator web-services import from @forjis/shared
// ---------------------------------------------------------------------------

describe('Facilitator web-services import from @forjis/shared', () => {
  const webServicesDir = join(runtimeRoot, 'facilitator', 'src', 'web-services');

  const serviceFiles = [
    'task-service.ts',
    'plan-service.ts',
    'plan-writer.ts',
    'event-service.ts',
    'resource-service.ts',
    'token-usage-service.ts',
    'file-service.ts',
    'task-file-service.ts',
    'manifest-service.ts',
  ];

  for (const file of serviceFiles) {
    it(`${file} imports from @forjis/shared, not @forjis/web`, async () => {
      const src = await readFile(join(webServicesDir, file), 'utf-8');
      // Should import types from shared
      expect(src).toContain("from '@forjis/shared'");
      // Should NOT import from web
      expect(src).not.toContain("from '@forjis/web'");
    });
  }

  it('plan-writer-timing.test.ts imports PipelinePlanResponse from @forjis/shared', async () => {
    const testSrc = await readFile(
      join(runtimeRoot, 'facilitator', 'src', '__tests__', 'plan-writer-timing.test.ts'),
      'utf-8',
    );
    expect(testSrc).toContain("from '@forjis/shared'");
    expect(testSrc).toContain('PipelinePlanResponse');
    expect(testSrc).not.toContain("from '@forjis/web'");
  });
});

// ---------------------------------------------------------------------------
// 9. Build script structure
// ---------------------------------------------------------------------------

describe('Build script structure', () => {
  let buildSrc: string;

  beforeAll(async () => {
    buildSrc = await readFile(join(runtimeRoot, 'build.mjs'), 'utf-8');
  });

  it('has 5 build steps: shared, resolver, web, facilitator, cli', () => {
    const stepMatches = buildSrc.match(/Step \d+: Build \w+/g) ?? [];
    expect(stepMatches).toEqual([
      'Step 1: Build shared',
      'Step 2: Build resolver',
      'Step 3: Build web',
      'Step 4: Build facilitator',
      'Step 5: Build cli',
    ]);
  });

  it('does not use ignoreErrors parameter', () => {
    expect(buildSrc).not.toContain('ignoreErrors');
  });

  it('does not have a bootstrap pass (facilitator built only once)', () => {
    // Count how many times buildWorkspace('facilitator') is called
    const facilCalls = (buildSrc.match(/buildWorkspace\(['"]facilitator['"]\)/g) ?? []).length;
    expect(facilCalls).toBe(1);
  });

  it('buildWorkspace function exits on error (no error swallowing)', () => {
    expect(buildSrc).toContain('process.exit');
  });

  it('shared is built before all other packages', () => {
    const sharedIdx = buildSrc.indexOf("buildWorkspace('shared')");
    const webIdx = buildSrc.indexOf("buildWorkspace('web')");
    const facilIdx = buildSrc.indexOf("buildWorkspace('facilitator')");
    const cliIdx = buildSrc.indexOf("buildWorkspace('cli')");
    expect(sharedIdx).toBeLessThan(webIdx);
    expect(sharedIdx).toBeLessThan(facilIdx);
    expect(sharedIdx).toBeLessThan(cliIdx);
  });

  it('web is built before facilitator (for runtime dynamic import)', () => {
    const webIdx = buildSrc.indexOf("buildWorkspace('web')");
    const facilIdx = buildSrc.indexOf("buildWorkspace('facilitator')");
    expect(webIdx).toBeLessThan(facilIdx);
  });
});

// ---------------------------------------------------------------------------
// 10. Build output — dist exists for all packages
// ---------------------------------------------------------------------------

describe('Build output exists for all packages', () => {
  it('shared/dist/index.js exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'shared', 'dist', 'index.js'))).toBe(true);
  });

  it('shared/dist/index.d.ts exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'shared', 'dist', 'index.d.ts'))).toBe(true);
  });

  it('shared/dist/types.js exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'shared', 'dist', 'types.js'))).toBe(true);
  });

  it('shared/dist/services.js exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'shared', 'dist', 'services.js'))).toBe(true);
  });

  it('shared/dist/types.d.ts exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'shared', 'dist', 'types.d.ts'))).toBe(true);
  });

  it('shared/dist/services.d.ts exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'shared', 'dist', 'services.d.ts'))).toBe(true);
  });

  it('web/dist/index.js exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'web', 'dist', 'index.js'))).toBe(true);
  });

  it('facilitator/dist/index.js exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'facilitator', 'dist', 'index.js'))).toBe(true);
  });

  it('cli/dist/bin/forjis.js exists', async () => {
    expect(await pathExists(join(runtimeRoot, 'cli', 'dist', 'bin', 'forjis.js'))).toBe(true);
  });
});
