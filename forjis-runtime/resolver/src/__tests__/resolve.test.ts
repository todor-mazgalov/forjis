/**
 * Unit tests for resolve.ts — the entry point.
 *
 * Tests the happy path, missing build file, and invalid YAML scenarios.
 * These are isolated unit tests that mock the repository resolution layer.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuildFileNotFoundError, BuildFileValidationError } from '../errors.js';
import { loadBuildFile, parseBuildFile } from '../build-file.js';

describe('resolve entry point — build file loading', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'resolve-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws BuildFileNotFoundError for missing build file', async () => {
    const missingPath = join(tmpDir, 'nonexistent.forjis');
    await expect(loadBuildFile(missingPath)).rejects.toThrow(BuildFileNotFoundError);
  });

  it('throws BuildFileValidationError for invalid YAML content', async () => {
    const buildPath = join(tmpDir, 'build.forjis');
    await writeFile(buildPath, ': invalid yaml [[[');

    const content = await loadBuildFile(buildPath);
    expect(() => parseBuildFile(content)).toThrow(BuildFileValidationError);
  });

  it('successfully parses a valid build file', async () => {
    const buildPath = join(tmpDir, 'build.forjis');
    const yaml = [
      'version: 1',
      'repositories:',
      '  - type: git',
      '    url: "https://github.com/org/repo.git"',
      '    ref: v1',
    ].join('\n');
    await writeFile(buildPath, yaml);

    const content = await loadBuildFile(buildPath);
    const config = parseBuildFile(content);

    expect(config.version).toBe(1);
    expect(config.repositories).toHaveLength(1);
  });

  it('parseBuildFile returns ConfigResult-compatible structure', async () => {
    const buildPath = join(tmpDir, 'build.forjis');
    const yaml = [
      'version: 1',
      'repositories:',
      '  - type: git',
      '    url: "https://github.com/org/repo.git"',
      '    ref: v1',
      'orgs:',
      '  - name: my-org',
      '    roles:',
      '      - name: Developer',
      '        agent: dev-agent',
    ].join('\n');
    await writeFile(buildPath, yaml);

    const content = await loadBuildFile(buildPath);
    const config = parseBuildFile(content);

    expect(config.orgs).toHaveLength(1);
    expect(config.orgs[0].name).toBe('my-org');
    expect(config.orgs[0].roles[0].name).toBe('Developer');
  });
});
