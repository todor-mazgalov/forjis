/**
 * Repository resource management barrel export.
 *
 * This module provides the public API for resolving repositories,
 * caching them locally, parsing manifests, and building a resource registry.
 * The primary entry point is `resolveRepositories()`, which orchestrates
 * the full resolution pipeline from repository configs to a queryable registry.
 */

export { CacheManager } from './cache.js';
export { GitResolver } from './git-resolver.js';
export { DirResolver } from './dir-resolver.js';
export { ManifestLoader } from './manifest.js';
export { ResourceRegistry } from './registry.js';
export * from './types.js';
export * from './errors.js';

import { CacheManager } from './cache.js';
import { DirResolver } from './dir-resolver.js';
import { GitResolver } from './git-resolver.js';
import { ManifestLoader } from './manifest.js';
import { ResourceRegistry } from './registry.js';
import type { RepoConfig, ResolvedRepo } from './types.js';

/**
 * Resolves all repository declarations and builds a resource registry.
 *
 * This is the primary entry point for consumers. It takes a list of
 * repository configurations (git or dir), resolves each one to a local
 * cache path, loads their manifests, and constructs a searchable registry
 * of all available resources.
 *
 * @param configs - The list of repository configurations to resolve.
 * @param cacheRoot - Optional override for the cache root directory.
 * @returns An object containing the resource registry and the list of resolved repos.
 * @throws {GitCloneError} If a git clone operation fails.
 * @throws {DirNotFoundError} If a local directory does not exist.
 * @throws {ManifestNotFoundError} If a repository lacks manifest.yaml.
 * @throws {ManifestValidationError} If a manifest has invalid fields.
 */
export async function resolveRepositories(
  configs: RepoConfig[],
  cacheRoot?: string
): Promise<{ registry: ResourceRegistry; resolved: ResolvedRepo[] }> {
  const cache = new CacheManager(cacheRoot);
  const gitResolver = new GitResolver(cache);
  const dirResolver = new DirResolver(cache);
  const manifestLoader = new ManifestLoader();

  const resolved: ResolvedRepo[] = [];

  for (const config of configs) {
    const repoRef = config.type === 'dir' ? config.path : config.url;
    console.log(`[registry]: resolving ${config.type} repository ${repoRef}...`);
    const cachePath = await resolveConfig(config, gitResolver, dirResolver);
    console.log(`[registry]: resolved -> cached at ${cachePath}`);
    const manifest = await manifestLoader.load(cachePath);
    console.log(`[registry]: manifest "${manifest.name}" — ${manifest.contents.agents.length} agents, ${manifest.contents.skills.length} skills, ${manifest.contents.hooks.length} hooks, ${manifest.contents.plugins.length} plugins`);
    resolved.push({ config, cachePath, manifest });
  }

  const registry = new ResourceRegistry(resolved);
  console.log(`[registry]: registry built — ${registry.listAll().length} total resources indexed`);
  return { registry, resolved };
}

/**
 * Dispatches a repository config to the appropriate resolver.
 *
 * @param config - The repository configuration (git or dir).
 * @param gitResolver - The git resolver instance.
 * @param dirResolver - The directory resolver instance.
 * @returns The absolute path to the cached repository.
 */
async function resolveConfig(
  config: RepoConfig,
  gitResolver: GitResolver,
  dirResolver: DirResolver
): Promise<string> {
  if (config.type === 'git') {
    return gitResolver.resolve(config);
  }
  return dirResolver.resolve(config);
}
