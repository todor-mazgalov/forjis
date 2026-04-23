/**
 * Unit tests for the role-visuals resolver surface.
 *
 * Covers:
 *   - `validateVisuals` / `validateVisualEntry` in build-file.ts
 *     (scheme allowlist, tool regex, credentials path checks).
 *   - `validateVisualsPaths` post-compose pass in plugin-compositor.ts
 *     (containment, git-tracked warning).
 *   - Propagation through `mergePluginOrgs` / override pathways.
 *   - Writer emission in orgs-writer.ts.
 *
 * All tests use in-memory helpers or `mkdtemp` fixtures — no network,
 * no external filesystem beyond the temp directory.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

import { parseBuildFile, parseDuration as _parseDuration } from '../build-file.js';
import { parsePlugin, validateVisualsPaths } from '../plugin-compositor.js';
import { BuildFileValidationError, PluginValidationError, ResolverError } from '../errors.js';
import type { RuntimeOrg, RuntimeRole } from '../types.js';
import { writeOrgsConfig } from '../writers/orgs-writer.js';
import { createTestContext } from './writers/helpers.js';
import { readFile } from 'node:fs/promises';

void _parseDuration;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Builds a build-file YAML string with a single role plus the supplied visuals list. */
function buildFileWithVisuals(visualsBlock: string): string {
  return [
    `version: 1`,
    `repositories:`,
    `  - type: git`,
    `    url: https://example.com/r.git`,
    `    ref: v1`,
    `orgs:`,
    `  - name: acme`,
    `    roles:`,
    `      - name: Developer`,
    `        agent: dev-agent`,
    visualsBlock,
  ].join('\n');
}

/** Builds a plugin YAML string with a single role and the supplied visuals block. */
function pluginFileWithVisuals(visualsBlock: string, pluginName = 'viz-plugin'): string {
  return [
    `name: ${pluginName}`,
    `version: 1.0.0`,
    `orgs:`,
    `  - name: acme`,
    `    teams:`,
    `      - name: eng`,
    `        roles:`,
    `          - name: Developer`,
    `            agent: dev-agent`,
    visualsBlock,
  ].join('\n');
}

/**
 * Builds a minimal `RuntimeOrg[]` tree with a single role carrying the
 * supplied visuals list. Used by the post-compose validation tests.
 */
function orgsWithRoleVisuals(
  visuals: RuntimeRole['visuals']
): RuntimeOrg[] {
  const role: RuntimeRole = {
    name: 'Developer',
    org: 'acme',
    team: 'default',
    agent: 'dev-agent',
    skills: [],
    hooks: { pre: [], validation: [], post: [] },
    ...(visuals ? { visuals } : {}),
  };
  return [
    {
      name: 'acme',
      teams: [{ name: 'default', roles: [role] }],
    },
  ];
}

// --------------------------------------------------------------------------
// Build-file shape validation
// --------------------------------------------------------------------------

describe('validateVisuals (build-file)', () => {
  it('accepts a role with all four visuals fields', () => {
    const yaml = buildFileWithVisuals(
      [
        `        visuals:`,
        `          - location: http://localhost:5173`,
        `            command: npm run dev`,
        `            tool: playwright@./ui/web`,
        `            credentials: .forjis/secrets/local.env`,
      ].join('\n')
    );
    const cfg = parseBuildFile(yaml);
    expect(cfg.orgs[0].roles[0].visuals).toEqual([
      {
        location: 'http://localhost:5173',
        command: 'npm run dev',
        tool: 'playwright@./ui/web',
        credentials: '.forjis/secrets/local.env',
      },
    ]);
  });

  it('accepts a role with visuals: []', () => {
    const yaml = buildFileWithVisuals(`        visuals: []`);
    const cfg = parseBuildFile(yaml);
    expect(cfg.orgs[0].roles[0].visuals).toEqual([]);
  });

  it('leaves visuals undefined when key is absent', () => {
    const yaml = [
      `version: 1`,
      `repositories:`,
      `  - type: git`,
      `    url: https://example.com/r.git`,
      `    ref: v1`,
      `orgs:`,
      `  - name: acme`,
      `    roles:`,
      `      - name: Developer`,
      `        agent: dev-agent`,
    ].join('\n');
    const cfg = parseBuildFile(yaml);
    expect(cfg.orgs[0].roles[0].visuals).toBeUndefined();
  });

  it('rejects unknown scheme with an indexed error path', () => {
    const yaml = buildFileWithVisuals(
      [`        visuals:`, `          - location: git+ssh://example.com/repo`].join('\n')
    );
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as Error).message).toMatch(
        /orgs\[0\]\.roles\[0\]\.visuals\[0\]\.location/
      );
      expect((err as Error).message).toMatch(/git\+ssh/);
    }
  });

  it('rejects uppercase scheme', () => {
    const yaml = buildFileWithVisuals(
      [`        visuals:`, `          - location: FILE://./design/a.png`].join('\n')
    );
    expect(() => parseBuildFile(yaml)).toThrow(
      /orgs\[0\]\.roles\[0\]\.visuals\[0\]\.location/
    );
  });

  it('rejects tool without @path (missing @)', () => {
    const yaml = buildFileWithVisuals(
      [
        `        visuals:`,
        `          - location: http://localhost:5173`,
        `            tool: playwright`,
      ].join('\n')
    );
    expect(() => parseBuildFile(yaml)).toThrow(
      /orgs\[0\]\.roles\[0\]\.visuals\[0\]\.tool/
    );
  });

  it('rejects tool with empty path (playwright@)', () => {
    const yaml = buildFileWithVisuals(
      [
        `        visuals:`,
        `          - location: http://localhost:5173`,
        `            tool: playwright@`,
      ].join('\n')
    );
    expect(() => parseBuildFile(yaml)).toThrow(
      /orgs\[0\]\.roles\[0\]\.visuals\[0\]\.tool/
    );
  });

  it('accepts tool with valid <name>@<path>', () => {
    const yaml = buildFileWithVisuals(
      [
        `        visuals:`,
        `          - location: http://localhost:5173`,
        `            tool: playwright@./ui/web`,
      ].join('\n')
    );
    const cfg = parseBuildFile(yaml);
    expect(cfg.orgs[0].roles[0].visuals?.[0].tool).toBe('playwright@./ui/web');
  });

  it('rejects credentials path with ".." escape at shape level', () => {
    const yaml = buildFileWithVisuals(
      [
        `        visuals:`,
        `          - location: https://staging.internal`,
        `            credentials: ../../etc/passwd`,
      ].join('\n')
    );
    expect(() => parseBuildFile(yaml)).toThrow(
      /orgs\[0\]\.roles\[0\]\.visuals\[0\]\.credentials/
    );
  });

  it('produces index path orgs[0].roles[2].visuals[1].tool for the third role', () => {
    const yaml = [
      `version: 1`,
      `repositories:`,
      `  - type: git`,
      `    url: https://example.com/r.git`,
      `    ref: v1`,
      `orgs:`,
      `  - name: acme`,
      `    roles:`,
      `      - name: First`,
      `        agent: a`,
      `      - name: Second`,
      `        agent: a`,
      `      - name: Third`,
      `        agent: a`,
      `        visuals:`,
      `          - location: http://ok.example.com`,
      `          - location: http://localhost:5173`,
      `            tool: bad-tool`,
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(
      /orgs\[0\]\.roles\[2\]\.visuals\[1\]\.tool/
    );
  });
});

// --------------------------------------------------------------------------
// Plugin-side parsing
// --------------------------------------------------------------------------

describe('parsePlugin — visuals parsing', () => {
  it('parses plugin-defined visuals on a role', () => {
    const yaml = pluginFileWithVisuals(
      [
        `            visuals:`,
        `              - location: http://localhost:5173`,
        `                command: npm run dev`,
      ].join('\n')
    );
    const plugin = parsePlugin(yaml);
    expect(plugin.orgs[0].teams[0].roles[0].visuals).toEqual([
      { location: 'http://localhost:5173', command: 'npm run dev' },
    ]);
  });

  it('throws PluginValidationError on malformed tool spec', () => {
    const yaml = pluginFileWithVisuals(
      [
        `            visuals:`,
        `              - location: http://localhost:5173`,
        `                tool: playwright`,
      ].join('\n')
    );
    expect(() => parsePlugin(yaml)).toThrow(PluginValidationError);
  });

  it('throws PluginValidationError on unknown scheme', () => {
    const yaml = pluginFileWithVisuals(
      [
        `            visuals:`,
        `              - location: gopher://legacy`,
      ].join('\n')
    );
    expect(() => parsePlugin(yaml)).toThrow(/invalid scheme/);
  });
});

// --------------------------------------------------------------------------
// Post-compose containment / git warning
// --------------------------------------------------------------------------

describe('validateVisualsPaths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-paths-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts a credentials path inside projectDir', async () => {
    await mkdir(join(tmpDir, '.forjis', 'secrets'), { recursive: true });
    await writeFile(
      join(tmpDir, '.forjis', 'secrets', 'staging.env'),
      'TOKEN=ignored',
      'utf-8'
    );
    const orgs = orgsWithRoleVisuals([
      { location: 'https://staging.example', credentials: '.forjis/secrets/staging.env' },
    ]);
    const warnings: string[] = [];
    await expect(
      validateVisualsPaths(orgs, tmpDir, (m) => warnings.push(m))
    ).resolves.toBeUndefined();
  });

  it('throws on credentials path with raw ".." even when file does not exist', async () => {
    const orgs = orgsWithRoleVisuals([
      { location: 'https://staging.example', credentials: '../../etc/passwd' },
    ]);
    await expect(
      validateVisualsPaths(orgs, tmpDir, () => {})
    ).rejects.toThrow(ResolverError);
  });

  it('throws on absolute credentials path outside projectDir', async () => {
    const orgs = orgsWithRoleVisuals([
      { location: 'https://staging.example', credentials: '/tmp/secrets.env' },
    ]);
    await expect(
      validateVisualsPaths(orgs, tmpDir, () => {})
    ).rejects.toThrow(/escapes projectDir/);
  });

  it('emits a warning when a credentials file is tracked by git', async () => {
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await mkdir(join(tmpDir, 'secrets'), { recursive: true });
    await writeFile(join(tmpDir, 'secrets', 'tracked.env'), 'FOO=bar', 'utf-8');
    spawnSync('git', ['add', 'secrets/tracked.env'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir });

    const warnings: string[] = [];
    const orgs = orgsWithRoleVisuals([
      { location: 'https://staging.example', credentials: 'secrets/tracked.env' },
    ]);
    await validateVisualsPaths(orgs, tmpDir, (m) => warnings.push(m));
    expect(warnings.some((w) => w.includes('[role-visuals]:'))).toBe(true);
    expect(warnings.some((w) => w.includes('secrets/tracked.env'))).toBe(true);
  });

  it('emits no warning when credentials file is untracked', async () => {
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    await mkdir(join(tmpDir, 'secrets'), { recursive: true });
    await writeFile(join(tmpDir, 'secrets', 'untracked.env'), 'FOO=bar', 'utf-8');

    const warnings: string[] = [];
    const orgs = orgsWithRoleVisuals([
      { location: 'https://staging.example', credentials: 'secrets/untracked.env' },
    ]);
    await validateVisualsPaths(orgs, tmpDir, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it('emits no warning and no error in a non-git project', async () => {
    await mkdir(join(tmpDir, 'secrets'), { recursive: true });
    await writeFile(join(tmpDir, 'secrets', 'free.env'), 'FOO=bar', 'utf-8');

    const warnings: string[] = [];
    const orgs = orgsWithRoleVisuals([
      { location: 'https://staging.example', credentials: 'secrets/free.env' },
    ]);
    await expect(
      validateVisualsPaths(orgs, tmpDir, (m) => warnings.push(m))
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('rejects file:// location with ".." escape', async () => {
    const orgs = orgsWithRoleVisuals([{ location: 'file://../../etc/*.png' }]);
    await expect(
      validateVisualsPaths(orgs, tmpDir, () => {})
    ).rejects.toThrow(/escapes projectDir/);
  });

  it('rejects tool install path with ".." escape', async () => {
    const orgs = orgsWithRoleVisuals([
      { location: 'http://localhost', tool: 'playwright@../../outside' },
    ]);
    await expect(
      validateVisualsPaths(orgs, tmpDir, () => {})
    ).rejects.toThrow(/escapes projectDir/);
  });
});

// --------------------------------------------------------------------------
// Orgs writer emission
// --------------------------------------------------------------------------

describe('orgs-writer — visuals emission', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orgs-writer-visuals-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('emits visuals for a non-empty role', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.orgs[0].teams[0].roles[0].visuals = [
      { location: 'http://localhost:5173', tool: 'playwright@./ui/web' },
    ];
    const result = await writeOrgsConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'orgs.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const orgs = parsed['orgs'] as Array<Record<string, unknown>>;
    const teams = orgs[0]['teams'] as Array<Record<string, unknown>>;
    const roles = teams[0]['roles'] as Array<Record<string, unknown>>;
    expect(roles[0]['visuals']).toEqual([
      { location: 'http://localhost:5173', tool: 'playwright@./ui/web' },
    ]);
  });

  it('omits visuals key when empty', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.orgs[0].teams[0].roles[0].visuals = [];
    const result = await writeOrgsConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'orgs.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const orgs = parsed['orgs'] as Array<Record<string, unknown>>;
    const teams = orgs[0]['teams'] as Array<Record<string, unknown>>;
    const roles = teams[0]['roles'] as Array<Record<string, unknown>>;
    expect('visuals' in roles[0]).toBe(false);
  });

  it('omits visuals key when absent', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeOrgsConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'orgs.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const orgs = parsed['orgs'] as Array<Record<string, unknown>>;
    const teams = orgs[0]['teams'] as Array<Record<string, unknown>>;
    const roles = teams[0]['roles'] as Array<Record<string, unknown>>;
    expect('visuals' in roles[0]).toBe(false);
  });
});
