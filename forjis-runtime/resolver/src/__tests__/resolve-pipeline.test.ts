/**
 * Unit tests for the full resolve() pipeline (FR-002, FR-012, FR-028, FR-029, NFR-003).
 *
 * These tests cover QA sections 13.1–13.6:
 *   - Happy path: resolve() returns ConfigResult with 7 generated files (QA 13.1)
 *   - All 7 config files exist after resolve() (QA 13.2)
 *   - Plugin lock file exists after resolve() (QA 13.3)
 *   - Missing build file throws BuildFileNotFoundError (QA 13.4)
 *   - Invalid YAML throws BuildFileValidationError (QA 13.5)
 *   - Idempotent second run skips all writes (QA 13.6 / FR-028)
 *
 * A real dir-type repository is used so resolveRepositories() works without
 * network access — the tmpDir itself acts as the resources directory, and a
 * minimal manifest.yaml is placed there so the ManifestLoader succeeds.
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { resolve } from '../resolve.js';
import { BuildFileNotFoundError, BuildFileValidationError } from '../errors.js';
import type { ConfigResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Writes the minimal file-system structure needed for resolve() to succeed:
 *  - build.forjis pointing to a local dir repository
 *  - resources/ directory with an empty manifest.yaml
 */
async function setupMinimalProject(projectDir: string): Promise<string> {
  const resourcesDir = join(projectDir, 'resources');
  await mkdir(resourcesDir, { recursive: true });

  // Minimal manifest recognised by ManifestLoader
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
  ].join('\n'));

  return buildPath;
}

const EXPECTED_CONFIG_FILES = [
  'orgs.yaml',
  'tasks.yaml',
  'personas.yaml',
  'outcomes.yaml',
  'constraints.yaml',
  'token-budget.yaml',
  'health-check.yaml',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolve() — full pipeline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'resolve-pipeline-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // QA 13.4: Missing build file
  it('throws BuildFileNotFoundError when build file does not exist', async () => {
    const missingPath = join(tmpDir, 'no-such-file.forjis');
    await expect(resolve(missingPath)).rejects.toThrow(BuildFileNotFoundError);
  });

  // QA 13.5: Invalid YAML
  it('throws BuildFileValidationError for invalid YAML content', async () => {
    const buildPath = join(tmpDir, 'build.forjis');
    await writeFile(buildPath, ': invalid yaml {{{');
    await expect(resolve(buildPath)).rejects.toThrow(BuildFileValidationError);
  });

  // QA 13.1: Happy path — returns ConfigResult with correct shape
  it('happy path: returns ConfigResult with generated list and configDir', async () => {
    const buildPath = await setupMinimalProject(tmpDir);

    const result: ConfigResult = await resolve(buildPath, { projectDir: tmpDir });

    expect(result).toBeDefined();
    expect(result.configDir).toBe(join(tmpDir, '.forjis', 'config'));
    expect(Array.isArray(result.generated)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(typeof result.summary.orgCount).toBe('number');
    expect(typeof result.summary.pluginCount).toBe('number');
    expect(typeof result.summary.roleCount).toBe('number');
  });

  // QA 13.1 (continued): All 7 file names appear in generated on first run
  it('happy path: all 7 config file names appear in generated on first run', async () => {
    const buildPath = await setupMinimalProject(tmpDir);

    const result: ConfigResult = await resolve(buildPath, { projectDir: tmpDir });

    for (const fileName of EXPECTED_CONFIG_FILES) {
      expect(result.generated).toContain(fileName);
    }
    expect(result.skipped).toHaveLength(0);
  });

  // QA 13.2: All 7 config files exist on disk after resolve()
  it('all 7 config files exist on disk after resolve()', async () => {
    const buildPath = await setupMinimalProject(tmpDir);

    await resolve(buildPath, { projectDir: tmpDir });

    const configDir = join(tmpDir, '.forjis', 'config');
    for (const fileName of EXPECTED_CONFIG_FILES) {
      const filePath = join(configDir, fileName);
      await expect(access(filePath)).resolves.toBeUndefined();
    }
  });

  // QA 13.3: Plugin lock file exists after resolve()
  it('plugin lock file exists at .forjis/resolved/plugins.lock.yaml after resolve()', async () => {
    const buildPath = await setupMinimalProject(tmpDir);

    await resolve(buildPath, { projectDir: tmpDir });

    const lockPath = join(tmpDir, '.forjis', 'resolved', 'plugins.lock.yaml');
    await expect(access(lockPath)).resolves.toBeUndefined();

    const content = await readFile(lockPath, 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed['resolvedAt']).toBeTruthy();
    expect(parsed['resolverVersion']).toBeTruthy();
    expect(Array.isArray(parsed['plugins'])).toBe(true);
  });

  // QA 13.6: Idempotent second run (FR-028)
  it('second run with unchanged inputs skips all config files', async () => {
    const buildPath = await setupMinimalProject(tmpDir);

    // First run — should generate everything
    const first: ConfigResult = await resolve(buildPath, { projectDir: tmpDir });
    expect(first.generated.length).toBeGreaterThan(0);

    // Second run — all files should be skipped
    const second: ConfigResult = await resolve(buildPath, { projectDir: tmpDir });
    expect(second.skipped.sort()).toEqual([...EXPECTED_CONFIG_FILES].sort());
    expect(second.generated).toHaveLength(0);
  });
});
