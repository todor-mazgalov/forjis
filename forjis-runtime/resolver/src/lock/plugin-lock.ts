/**
 * Plugin lock file writer.
 *
 * Writes `.forjis/resolved/plugins.lock.yaml` with the resolved state
 * of all plugins including their versions, source paths, and content checksums.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { PluginDef, PluginLockEntry, PluginLockFile } from '../types.js';
import type { ResourceRegistry } from '../repo/index.js';

/** The resolver version used in the lock file. */
const RESOLVER_VERSION = '0.5.0';

/**
 * Writes .forjis/resolved/plugins.lock.yaml with the resolved state
 * of all plugins including their versions, source paths, and checksums.
 *
 * @param projectDir - Absolute path to the project directory.
 * @param plugins - The loaded plugin definitions.
 * @param registry - The resource registry for resolving plugin file paths.
 * @param rawContents - Map from plugin name to raw YAML content, as read by loadPlugins.
 */
export async function writePluginLock(
  projectDir: string,
  plugins: PluginDef[],
  registry: ResourceRegistry,
  rawContents: Map<string, string>
): Promise<void> {
  const entries = await buildLockEntries(plugins, registry, rawContents);

  const lockFile: PluginLockFile = {
    resolvedAt: new Date().toISOString(),
    resolverVersion: RESOLVER_VERSION,
    plugins: entries,
  };

  const lockDir = join(projectDir, '.forjis', 'resolved');
  await ensureDir(lockDir);

  const content = stringifyYaml(lockFile, { indent: 2 });
  await atomicWriteFile(join(lockDir, 'plugins.lock.yaml'), content);
}

/**
 * Builds lock entries for all plugins using already-read raw content strings.
 *
 * @param plugins - The loaded plugin definitions.
 * @param registry - The resource registry for resolving file paths.
 * @param rawContents - Map from plugin name to raw YAML content.
 * @returns An array of PluginLockEntry objects.
 */
async function buildLockEntries(
  plugins: PluginDef[],
  registry: ResourceRegistry,
  rawContents: Map<string, string>
): Promise<PluginLockEntry[]> {
  const entries: PluginLockEntry[] = [];

  for (const plugin of plugins) {
    const entry = registry.resolve('plugin', plugin.name);
    const content = rawContents.get(plugin.name) ?? '';
    const checksum = computeHash(content);

    entries.push({
      name: plugin.name,
      version: plugin.version,
      source: entry.filePath,
      checksum,
    });
  }

  return entries;
}
