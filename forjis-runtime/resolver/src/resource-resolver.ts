/**
 * Resource resolution helper for @forjis/resolver.
 *
 * Enriches resource references from a RuntimeConfig with actual file content
 * by reading each file from the registry. Produces ResolvedResource objects
 * ready for engine consumption.
 */

import { readFile } from 'node:fs/promises';

import type { ResourceRegistry } from './repo/index.js';
import type { ResolvedResource, RuntimeConfig } from './types.js';

/**
 * Resolve all resources referenced by a RuntimeConfig from the registry.
 *
 * Iterates over all orgs, teams, and roles in the config, collecting every
 * agent, skill, and hook reference. Each reference is resolved via the
 * registry to get a file path, then the file content is read from disk.
 * Duplicate references (same file path) are deduplicated.
 *
 * @param config - The fully composed runtime configuration.
 * @param registry - The resource registry for resolving file paths.
 * @returns An array of ResolvedResource objects with name, type, path, and content.
 * @throws If a referenced resource cannot be found in the registry.
 */
export async function resolveAllResources(
  config: RuntimeConfig,
  registry: ResourceRegistry
): Promise<ResolvedResource[]> {
  const seenPaths = new Set<string>();
  const resources: ResolvedResource[] = [];

  for (const org of config.orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        await collectResource('agent', role.agent, registry, seenPaths, resources);

        for (const skill of role.skills) {
          await collectResource('skill', skill, registry, seenPaths, resources);
        }

        for (const phase of ['pre', 'validation', 'post'] as const) {
          for (const hook of role.hooks[phase]) {
            await collectResource('hook', hook, registry, seenPaths, resources);
          }
        }
      }
    }
  }

  console.log(`[forjis]: resolved ${resources.length} resource${resources.length === 1 ? '' : 's'}`);
  return resources;
}

/**
 * Resolves a single resource and adds it to the collection if not already seen.
 *
 * @param type - The resource type (agent, skill, or hook).
 * @param name - The resource name to resolve.
 * @param registry - The resource registry for path resolution.
 * @param seenPaths - Set of already-seen file paths for deduplication.
 * @param resources - The accumulator array to push results into.
 */
async function collectResource(
  type: 'agent' | 'skill' | 'hook',
  name: string,
  registry: ResourceRegistry,
  seenPaths: Set<string>,
  resources: ResolvedResource[]
): Promise<void> {
  const entry = registry.resolve(type, name);

  if (seenPaths.has(entry.filePath)) {
    return;
  }

  seenPaths.add(entry.filePath);

  const content = await readFile(entry.filePath, 'utf-8');

  resources.push({
    name,
    type,
    sourcePath: entry.filePath,
    content,
  });
}
