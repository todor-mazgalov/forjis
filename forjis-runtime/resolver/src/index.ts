/**
 * Public API barrel export for @forjis/resolver.
 *
 * Exposes the full resolver pipeline: build file parsing, plugin composition,
 * resource resolution, config file generation, and checksum caching.
 */

// Entry point
export { resolve } from './resolve.js';

// Build file parsing
export { loadBuildFile, parseBuildFile, parseDuration, formatDuration } from './build-file.js';

// Plugin loading and composition
export { loadPlugins, parsePlugin, parsePluginRules, composeRuntime, resolveTaskRuleIncludes, verifyPluginDependencies } from './plugin-compositor.js';
export type { LoadedPlugins } from './plugin-compositor.js';

// Resource resolution
export { resolveAllResources } from './resource-resolver.js';

// Repository management
export { resolveRepositories, ResourceRegistry, CacheManager } from './repo/index.js';
export type * from './repo/types.js';
export * from './repo/errors.js';

// Checksum caching
export { readChecksumCache, writeChecksumCache, computeHash, isChanged } from './checksum-cache.js';

// Types
export * from './types.js';

// Errors
export * from './errors.js';
