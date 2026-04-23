/**
 * Unit tests for plugin-lock.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { parse as parseYaml } from 'yaml';

import { writePluginLock } from '../../lock/plugin-lock.js';
import { computeHash } from '../../checksum-cache.js';
import type { PluginDef, PluginLockFile } from '../../types.js';
import type { ResourceRegistry } from '../../repo/index.js';

describe('writePluginLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-lock-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Creates a minimal PluginDef for testing. */
  function createPlugin(name: string, version: string): PluginDef {
    return {
      name,
      version,
      requires: { agents: [], skills: [], hooks: [] },
      orgs: [],
      pipeline: null,
      outcome: null,
      metrics: new Map(),
      constraints: [],
      rules: [],
    };
  }

  /** Creates a mock registry that returns predictable paths. */
  function createMockRegistry(pluginContents: Map<string, string>): ResourceRegistry {
    return {
      resolve: jest.fn().mockImplementation((_type: string, name: string) => ({
        type: 'plugin',
        name,
        repoName: 'test-repo',
        filePath: join(tmpDir, `${name}.forjis.yaml`),
      })),
    } as unknown as ResourceRegistry;
  }

  it('creates lock file with correct structure for two plugins', async () => {
    const plugins = [
      createPlugin('plugin-a', '1.0.0'),
      createPlugin('plugin-b', '2.0.0'),
    ];

    // Write plugin files to disk so writePluginLock can read them
    const { writeFile } = await import('node:fs/promises');
    const contentA = 'name: plugin-a\nversion: 1.0.0';
    const contentB = 'name: plugin-b\nversion: 2.0.0';
    await writeFile(join(tmpDir, 'plugin-a.forjis.yaml'), contentA);
    await writeFile(join(tmpDir, 'plugin-b.forjis.yaml'), contentB);

    const registry = createMockRegistry(new Map());
    await writePluginLock(tmpDir, plugins, registry);

    const lockPath = join(tmpDir, '.forjis', 'resolved', 'plugins.lock.yaml');
    const content = await readFile(lockPath, 'utf-8');
    const parsed = parseYaml(content) as PluginLockFile;

    expect(parsed.resolverVersion).toBe('0.5.1');
    expect(parsed.resolvedAt).toBeTruthy();
    expect(parsed.plugins).toHaveLength(2);
    expect(parsed.plugins[0].name).toBe('plugin-a');
    expect(parsed.plugins[0].version).toBe('1.0.0');
    expect(parsed.plugins[1].name).toBe('plugin-b');
    expect(parsed.plugins[1].version).toBe('2.0.0');
  });

  it('lock file contains checksums matching SHA-256 of plugin content', async () => {
    const plugins = [createPlugin('test-plugin', '1.0.0')];

    const { writeFile } = await import('node:fs/promises');
    const pluginContent = 'name: test-plugin\nversion: 1.0.0';
    await writeFile(join(tmpDir, 'test-plugin.forjis.yaml'), pluginContent);

    const registry = createMockRegistry(new Map());
    await writePluginLock(tmpDir, plugins, registry);

    const lockPath = join(tmpDir, '.forjis', 'resolved', 'plugins.lock.yaml');
    const content = await readFile(lockPath, 'utf-8');
    const parsed = parseYaml(content) as PluginLockFile;

    const expectedHash = computeHash(pluginContent);
    expect(parsed.plugins[0].checksum).toBe(expectedHash);
  });
});
