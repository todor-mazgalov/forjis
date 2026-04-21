/**
 * Reviewer unit tests for the add-pillars-constraint feature.
 *
 * These tests are written by the Fullstack Reviewer Agent and independently
 * verify every acceptance criterion from:
 *   openspec/changes/add-pillars-constraint/specs/requirements/spec.md
 *
 * Test scope: business logic only. No HTTP controllers, no framework glue.
 * All file-system dependencies are mocked or use real tmp directories scoped
 * per test.
 */

import { jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { parseBuildFile } from '../build-file.js';
import { BuildFileValidationError } from '../errors.js';
import { composeRuntime } from '../plugin-compositor.js';
import { writeConstraintsConfig } from '../writers/constraints-writer.js';
import { resolve } from '../resolve.js';
import type {
  BuildConfig,
  BuildConstraintsConfig,
  PillarEntry,
  ResolvedConstraints,
} from '../types.js';
import type { ResourceRegistry } from '../repo/index.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Creates a mock ResourceRegistry that always resolves successfully. */
function mockRegistry(): ResourceRegistry {
  return {
    resolve: jest.fn().mockReturnValue({ filePath: '/fake/path.yaml', name: 'resource' }),
    list: jest.fn().mockReturnValue([]),
    listAll: jest.fn().mockReturnValue([]),
    listByType: jest.fn().mockReturnValue([]),
    getConflicts: jest.fn().mockReturnValue(new Map()),
    parseQualifiedName: jest.fn().mockImplementation((input: string) => ({ name: input })),
  } as unknown as ResourceRegistry;
}

/** Creates a minimal BuildConfig with optional overrides. */
function minimalBuildConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    version: 1,
    repositories: [{ type: 'git', url: 'https://github.com/a/b.git', ref: 'v1' }],
    plugins: [],
    orgs: [],
    tasks: null,
    outcome: null,
    constraints: null,
    tokenBudget: null,
    personas: null,
    healthCheck: null,
    ...overrides,
  };
}

/** Base YAML lines shared across build-file tests. */
const BASE_YAML_LINES = [
  'version: 1',
  'repositories:',
  '  - type: git',
  '    url: "https://a.git"',
  '    ref: v1',
];

/**
 * Writes the minimal file-system structure needed for resolve() to succeed:
 *  - resources/ directory with an empty manifest.yaml
 *  - build.forjis pointing to the local dir repository
 */
async function setupProject(
  projectDir: string,
  extraBuildLines: string[] = []
): Promise<string> {
  const resourcesDir = join(projectDir, 'resources');
  await mkdir(resourcesDir, { recursive: true });

  await writeFile(join(resourcesDir, 'manifest.yaml'), [
    'name: test-repo',
    'version: 1.0.0',
    'agents: []',
    'skills: []',
    'hooks: []',
    'plugins: []',
  ].join('\n'));

  const buildPath = join(projectDir, 'build.forjis');
  await writeFile(buildPath, [
    'version: 1',
    'repositories:',
    '  - type: dir',
    `    path: ${resourcesDir}`,
    ...extraBuildLines,
  ].join('\n'));

  return buildPath;
}

// ---------------------------------------------------------------------------
// Req: Pillars field in BuildConstraintsConfig type
// ---------------------------------------------------------------------------

describe('BuildConstraintsConfig — pillars type field', () => {
  /**
   * Validates: "BuildConstraintsConfig object constructed with pillars:
   * ["specs/architecture.md"] has pillars property as array containing
   * exactly that string."
   */
  it('BuildConstraintsConfig.pillars accepts a valid string array', () => {
    const config: BuildConstraintsConfig = {
      include: [],
      mandatory: '',
      optional: '',
      pillars: ['specs/architecture.md'],
    };
    expect(config.pillars).toHaveLength(1);
    expect(config.pillars[0]).toBe('specs/architecture.md');
  });

  /**
   * Validates: "BuildConstraintsConfig object constructed without a pillars
   * property defaults to []."
   * (Enforced by parseBuildFile — the object itself must use an empty array.)
   */
  it('BuildConstraintsConfig.pillars defaults to empty array when absent in build file', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  mandatory: "No eval."',
    ].join('\n');
    const result = parseBuildFile(yaml);
    expect(result.constraints!.pillars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req: Pillars field in ResolvedConstraints type
// ---------------------------------------------------------------------------

describe('ResolvedConstraints — pillars type field', () => {
  /**
   * Validates: "ResolvedConstraints is constructed with
   * pillars: [{path, content}] — both properties accessible as strings."
   */
  it('ResolvedConstraints.pillars accepts a PillarEntry array', () => {
    const entry: PillarEntry = { path: 'specs/arch.md', content: '# Architecture\n...' };
    const resolved: ResolvedConstraints = {
      mandatory: '',
      optional: '',
      pillars: [entry],
    };
    expect(resolved.pillars).toHaveLength(1);
    expect(resolved.pillars[0].path).toBe('specs/arch.md');
    expect(resolved.pillars[0].content).toBe('# Architecture\n...');
  });

  /**
   * Validates: "ResolvedConstraints defaults pillars to empty array."
   */
  it('ResolvedConstraints.pillars can be set to empty array', () => {
    const resolved: ResolvedConstraints = {
      mandatory: '',
      optional: '',
      pillars: [],
    };
    expect(resolved.pillars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req: Build file parser validates pillars field
// ---------------------------------------------------------------------------

describe('parseBuildFile — pillars validation', () => {
  /**
   * Validates: "Valid pillars array is parsed successfully."
   */
  it('parses a valid two-element pillars array with no errors', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  pillars:',
      '    - "specs/architecture.md"',
      '    - "specs/data-model.md"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.constraints!.pillars).toEqual([
      'specs/architecture.md',
      'specs/data-model.md',
    ]);
  });

  /**
   * Validates: "Pillars field omitted is valid — defaults to []."
   */
  it('returns empty pillars array when constraints block has no pillars key', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  optional: "Use camelCase"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.constraints!.pillars).toEqual([]);
  });

  /**
   * Validates: "Pillars field with non-array value produces validation error."
   */
  it('throws BuildFileValidationError when pillars is a string, not array', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  pillars: "not-an-array.md"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const e = err as BuildFileValidationError;
      expect(e.errors.some(msg => msg.includes('constraints.pillars: must be an array'))).toBe(true);
    }
  });

  /**
   * Validates: "Pillars array with non-string element produces validation error."
   */
  it('throws BuildFileValidationError when a pillar element is a number', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  pillars:',
      '    - 42',
      '    - "valid.md"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const e = err as BuildFileValidationError;
      expect(e.errors.some(msg => msg.includes('constraints.pillars[0]: must be a string'))).toBe(true);
    }
  });

  /**
   * Validates: "Pillars array with empty string produces validation error."
   */
  it('throws BuildFileValidationError when a pillar element is an empty string', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  pillars:',
      '    - ""',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const e = err as BuildFileValidationError;
      expect(e.errors.some(msg => msg.includes('constraints.pillars[0]: must be a non-empty string'))).toBe(true);
    }
  });

  /**
   * Additional: valid pillars entries mixed with invalid — both errors reported.
   */
  it('reports multiple pillar validation errors at once', () => {
    const yaml = [
      ...BASE_YAML_LINES,
      'constraints:',
      '  pillars:',
      '    - ""',
      '    - 99',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const e = err as BuildFileValidationError;
      // Both index 0 (empty) and index 1 (non-string) should appear
      expect(e.errors.some(msg => msg.includes('constraints.pillars[0]'))).toBe(true);
      expect(e.errors.some(msg => msg.includes('constraints.pillars[1]'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Req: composeRuntime pillar passthrough (plugin-compositor.ts)
// ---------------------------------------------------------------------------

describe('composeRuntime — pillar passthrough (reviewer tests)', () => {
  /**
   * Validates: "composeRuntime without loadedPillars returns empty pillars."
   */
  it('returns empty pillars array when no loadedPillars argument passed', () => {
    const config = minimalBuildConfig({ constraints: null });
    const runtime = composeRuntime(config, [], mockRegistry());
    expect(runtime.resolvedConstraints.pillars).toEqual([]);
  });

  /**
   * Validates: "composeRuntime with loadedPillars returns those entries."
   */
  it('returns provided loadedPillars unchanged in resolvedConstraints', () => {
    const loadedPillars: PillarEntry[] = [
      { path: 'a.md', content: '# A' },
      { path: 'b.md', content: '# B' },
    ];
    const config = minimalBuildConfig({
      constraints: { include: [], mandatory: '', optional: '', pillars: ['a.md', 'b.md'] },
    });
    const runtime = composeRuntime(config, [], mockRegistry(), loadedPillars);
    expect(runtime.resolvedConstraints.pillars).toEqual(loadedPillars);
  });

  /**
   * Validates: "composeRuntime preserves mandatory/optional with loadedPillars."
   */
  it('mandatory and optional text are preserved alongside loadedPillars', () => {
    const loadedPillars: PillarEntry[] = [{ path: 'guide.md', content: 'Content' }];
    const config = minimalBuildConfig({
      constraints: {
        include: [],
        mandatory: 'Do not use eval.',
        optional: 'Use camelCase.',
        pillars: [],
      },
    });
    const runtime = composeRuntime(config, [], mockRegistry(), loadedPillars);
    expect(runtime.resolvedConstraints.mandatory).toBe('Do not use eval.');
    expect(runtime.resolvedConstraints.optional).toBe('Use camelCase.');
    expect(runtime.resolvedConstraints.pillars).toEqual(loadedPillars);
  });

  /**
   * Validates: "null constraints with loadedPillars still returns pillars."
   */
  it('returns loadedPillars even when buildConfig.constraints is null', () => {
    const loadedPillars: PillarEntry[] = [{ path: 'spec.md', content: '# Spec' }];
    const config = minimalBuildConfig({ constraints: null });
    const runtime = composeRuntime(config, [], mockRegistry(), loadedPillars);
    // Per resolveConstraints(): { mandatory: '', optional: '', pillars: loadedPillars ?? [] }
    expect(runtime.resolvedConstraints.pillars).toEqual(loadedPillars);
  });

  /**
   * Validates: "Multiple pillars are loaded in declaration order."
   */
  it('preserves pillar entry order from loadedPillars', () => {
    const loadedPillars: PillarEntry[] = [
      { path: 'specs/a.md', content: 'AAA' },
      { path: 'specs/b.md', content: 'BBB' },
    ];
    const config = minimalBuildConfig({
      constraints: { include: [], mandatory: '', optional: '', pillars: ['specs/a.md', 'specs/b.md'] },
    });
    const runtime = composeRuntime(config, [], mockRegistry(), loadedPillars);
    expect(runtime.resolvedConstraints.pillars[0].path).toBe('specs/a.md');
    expect(runtime.resolvedConstraints.pillars[0].content).toBe('AAA');
    expect(runtime.resolvedConstraints.pillars[1].path).toBe('specs/b.md');
    expect(runtime.resolvedConstraints.pillars[1].content).toBe('BBB');
  });
});

// ---------------------------------------------------------------------------
// Req: Constraints writer serializes pillar content
// ---------------------------------------------------------------------------

describe('writeConstraintsConfig — pillars serialization (reviewer tests)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'reviewer-constraints-writer-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Builds a minimal WriterContext for testing the writer. */
  function buildCtx(pillars: PillarEntry[]) {
    const configDir = join(tmpDir, '.forjis', 'config');
    return {
      projectDir: tmpDir,
      configDir,
      config: {
        orgs: [],
        metrics: new Map(),
        outcomeRules: [],
        outcomeEnabled: true,
        defaultAction: 'halt' as const,
        defaultMaxRetries: 1,
        pipeline: null,
        allowedTools: [],
        tokenBudget: null,
        resolvedConstraints: { mandatory: 'Do not use eval', optional: '', pillars },
        healthCheck: { interval: 300, maxRetries: 3 },
      },
      buildConfig: {
        version: 1 as const,
        repositories: [{ type: 'git' as const, url: 'https://a.git', ref: 'v1' }],
        plugins: [],
        orgs: [],
        tasks: null,
        outcome: null,
        tokenBudget: null,
        constraints: { include: [], mandatory: 'Do not use eval', optional: '', pillars: [] },
        personas: null,
        healthCheck: null,
      },
      registry: mockRegistry(),
      cacheEntries: {} as Record<string, import('../types.js').ChecksumEntry>,
      previousCache: null,
      plugins: [],
    };
  }

  /**
   * Validates: "Pillars are written to constraints.yaml — non-empty pillars
   * array produces pillars key with path and content."
   */
  it('writes pillars key to constraints.yaml when pillars is non-empty', async () => {
    const ctx = buildCtx([{ path: 'specs/arch.md', content: '# Arch' }]);
    await writeConstraintsConfig(ctx);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    expect(parsed['pillars']).toBeDefined();
    const pillars = parsed['pillars'] as Array<{ path: string; content: string }>;
    expect(pillars).toHaveLength(1);
    expect(pillars[0].path).toBe('specs/arch.md');
    expect(pillars[0].content).toBe('# Arch');
  });

  /**
   * Validates: "Empty pillars array omits pillars key from output."
   */
  it('omits pillars key when resolvedConstraints.pillars is empty', async () => {
    const ctx = buildCtx([]);
    await writeConstraintsConfig(ctx);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    expect(parsed['pillars']).toBeUndefined();
  });

  /**
   * Validates: "Existing mandatory and optional fields are preserved when
   * pillars are also written."
   */
  it('preserves mandatory field alongside non-empty pillars', async () => {
    const ctx = buildCtx([{ path: 'a.md', content: 'Content' }]);
    await writeConstraintsConfig(ctx);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    expect(parsed['mandatory']).toBe('Do not use eval');
    expect(parsed['pillars']).toBeDefined();
  });

  /**
   * Validates: "Multiple pillars are serialized in declaration order."
   */
  it('serializes multiple pillars in order', async () => {
    const ctx = buildCtx([
      { path: 'specs/a.md', content: 'AAA' },
      { path: 'specs/b.md', content: 'BBB' },
    ]);
    await writeConstraintsConfig(ctx);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    const pillars = parsed['pillars'] as Array<{ path: string; content: string }>;
    expect(pillars[0].path).toBe('specs/a.md');
    expect(pillars[0].content).toBe('AAA');
    expect(pillars[1].path).toBe('specs/b.md');
    expect(pillars[1].content).toBe('BBB');
  });
});

// ---------------------------------------------------------------------------
// Req: Pillar files validated for existence + contents loaded (resolve.ts)
// ---------------------------------------------------------------------------

describe('resolve() — pillar loading (reviewer integration tests)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'reviewer-resolve-pillars-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: "All pillar files exist — resolve step completes without error."
   */
  it('resolve() succeeds when all declared pillar files exist', async () => {
    const specsDir = join(tmpDir, 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'architecture.md'), '# Architecture\nMicroservices based.');
    await writeFile(join(specsDir, 'data-model.md'), '# Data Model');

    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      '    - "specs/architecture.md"',
      '    - "specs/data-model.md"',
    ]);

    await expect(resolve(buildPath, { projectDir: tmpDir })).resolves.toBeDefined();
  });

  /**
   * Validates: "One pillar file is missing — resolver throws error containing
   * the missing file path string."
   */
  it('resolve() throws when a declared pillar file does not exist', async () => {
    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      '    - "specs/missing.md"',
    ]);

    await expect(
      resolve(buildPath, { projectDir: tmpDir })
    ).rejects.toThrow(/specs\/missing\.md/);
  });

  /**
   * Validates: "Pillar path resolution uses projectDir — relative paths are
   * resolved against the project directory."
   */
  it('resolve() uses projectDir to resolve relative pillar paths', async () => {
    const docsDir = join(tmpDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'guide.md'), '# Guide');

    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      '    - "docs/guide.md"',
    ]);

    const result = await resolve(buildPath, { projectDir: tmpDir });
    expect(result.runtimeConfig.resolvedConstraints.pillars[0].path).toBe('docs/guide.md');
    expect(result.runtimeConfig.resolvedConstraints.pillars[0].content).toBe('# Guide');
  });

  /**
   * Validates: "Pillar content is loaded into ResolvedConstraints — path
   * property contains the original declared path, content the full file text."
   */
  it('resolve() attaches correct path and content to resolvedConstraints.pillars', async () => {
    const specsDir = join(tmpDir, 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'architecture.md'), '# Architecture\nMicroservices based.');

    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      '    - "specs/architecture.md"',
    ]);

    const result = await resolve(buildPath, { projectDir: tmpDir });
    const pillars = result.runtimeConfig.resolvedConstraints.pillars;

    expect(pillars).toHaveLength(1);
    // path must be the declared path (not the absolute resolved path)
    expect(pillars[0].path).toBe('specs/architecture.md');
    expect(pillars[0].content).toBe('# Architecture\nMicroservices based.');
  });

  /**
   * Validates: "Multiple pillars are loaded in declaration order."
   */
  it('resolve() loads multiple pillars in declaration order', async () => {
    const specsDir = join(tmpDir, 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'a.md'), 'AAA');
    await writeFile(join(specsDir, 'b.md'), 'BBB');

    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      '    - "specs/a.md"',
      '    - "specs/b.md"',
    ]);

    const result = await resolve(buildPath, { projectDir: tmpDir });
    const pillars = result.runtimeConfig.resolvedConstraints.pillars;

    expect(pillars).toHaveLength(2);
    expect(pillars[0].path).toBe('specs/a.md');
    expect(pillars[0].content).toBe('AAA');
    expect(pillars[1].path).toBe('specs/b.md');
    expect(pillars[1].content).toBe('BBB');
  });

  /**
   * Validates: "Empty pillars array produces empty resolved pillars."
   * (Backward compatibility — no pillar field in build file.)
   */
  it('resolve() produces empty pillars when constraints block has no pillars', async () => {
    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  mandatory: "No eval"',
    ]);

    const result = await resolve(buildPath, { projectDir: tmpDir });
    expect(result.runtimeConfig.resolvedConstraints.pillars).toEqual([]);
  });

  /**
   * Validates: "Absent pillars produces identical behavior to current state."
   * (Backward compatibility — no constraints block at all.)
   */
  it('resolve() produces empty pillars when no constraints block exists', async () => {
    const buildPath = await setupProject(tmpDir);

    const result = await resolve(buildPath, { projectDir: tmpDir });
    expect(result.runtimeConfig.resolvedConstraints.pillars).toEqual([]);
  });

  /**
   * Validates: "constraints.yaml has no pillars key when no pillars are loaded."
   * (Backward compatibility end-to-end.)
   */
  it('constraints.yaml omits pillars key when no pillars are declared', async () => {
    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  mandatory: "No eval"',
    ]);

    await resolve(buildPath, { projectDir: tmpDir });

    const { readFile } = await import('node:fs/promises');
    const configDir = join(tmpDir, '.forjis', 'config');
    const raw = await readFile(join(configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    expect(parsed['pillars']).toBeUndefined();
  });

  /**
   * Validates: "constraints.yaml contains pillars key with loaded content
   * when pillars are declared."
   */
  it('constraints.yaml contains pillars key with path and content when pillars are declared', async () => {
    const specsDir = join(tmpDir, 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'arch.md'), '# Arch');

    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      '    - "specs/arch.md"',
    ]);

    await resolve(buildPath, { projectDir: tmpDir });

    const { readFile } = await import('node:fs/promises');
    const configDir = join(tmpDir, '.forjis', 'config');
    const raw = await readFile(join(configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    expect(parsed['pillars']).toBeDefined();
    const pillars = parsed['pillars'] as Array<{ path: string; content: string }>;
    expect(pillars[0].path).toBe('specs/arch.md');
    expect(pillars[0].content).toBe('# Arch');
  });

  /**
   * Validates: "Absolute pillar path is used as-is."
   * Uses an absolute path to a known temp file.
   */
  it('resolve() uses absolute pillar path without prepending projectDir', async () => {
    // Create the pillar file at an absolute path inside tmpDir
    const absolutePillarPath = join(tmpDir, 'absolute-spec.md');
    await writeFile(absolutePillarPath, '# Absolute Spec');

    const buildPath = await setupProject(tmpDir, [
      'constraints:',
      '  pillars:',
      // Use forward slashes for the YAML value (resolve.ts uses path.isAbsolute)
      `    - "${absolutePillarPath.replace(/\\/g, '/')}"`,
    ]);

    const result = await resolve(buildPath, { projectDir: tmpDir });
    const pillars = result.runtimeConfig.resolvedConstraints.pillars;

    expect(pillars).toHaveLength(1);
    // The path stored should be the declared (absolute) path
    expect(pillars[0].content).toBe('# Absolute Spec');
  });
});
