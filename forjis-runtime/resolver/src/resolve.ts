/**
 * Resolver entry point for @forjis/resolver.
 *
 * Orchestrates the full configuration resolution pipeline: parse the build file,
 * resolve repositories, load plugins, compose runtime config, call all config
 * writers, write the plugin lock file, and return a ConfigResult.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { loadBuildFile, parseBuildFile } from './build-file.js';
import { readChecksumCache, writeChecksumCache } from './checksum-cache.js';
import { writePluginLock } from './lock/plugin-lock.js';
import { composeRuntime, loadPlugins, resolveTaskRuleIncludes } from './plugin-compositor.js';
import { resolveRepositories } from './repo/index.js';
import {
  writeConstraintsConfig,
  writeHealthCheckConfig,
  writeOrgsConfig,
  writeOutcomesConfig,
  writePersonasConfig,
  writeTaskRulesConfig,
  writeTasksConfig,
  writeTokenBudgetConfig,
} from './writers/index.js';
import type {
  ChecksumEntry,
  ConfigResult,
  PillarEntry,
  ResolveOptions,
  WriterContext,
} from './types.js';

/**
 * Resolves a build.forjis file into normalized config files.
 *
 * Orchestrates the full pipeline: parse build file, resolve repositories,
 * load plugins, compose runtime config, write all config files, and
 * write the plugin lock file.
 *
 * @param buildFilePath - Absolute path to the build.forjis file.
 * @param options - Optional overrides (projectDir defaults to dirname of buildFilePath).
 * @returns ConfigResult indicating what was generated.
 * @throws {BuildFileNotFoundError} If the build file does not exist.
 * @throws {BuildFileValidationError} If the build file is invalid YAML/schema.
 */
export async function resolve(
  buildFilePath: string,
  options?: ResolveOptions
): Promise<ConfigResult> {
  const projectDir = options?.projectDir ?? dirname(buildFilePath);
  const configDir = join(projectDir, '.forjis', 'config');

  const content = await loadBuildFile(buildFilePath);
  const buildConfig = parseBuildFile(content);

  const { registry } = await resolveRepositories(
    buildConfig.repositories,
    options?.cacheRoot
  );

  const { plugins, rawContents } = await loadPlugins(buildConfig, registry);
  const pillarPaths = buildConfig.constraints?.pillars ?? [];
  const loadedPillars = await loadPillars(pillarPaths, projectDir);
  const config = composeRuntime(buildConfig, plugins, registry, loadedPillars);
  const resolvedTaskRules = resolveTaskRuleIncludes(buildConfig, plugins, config.orgs);

  const previousCache = await readChecksumCache(projectDir);
  const cacheEntries: Record<string, ChecksumEntry> = {};

  const ctx: WriterContext = {
    projectDir,
    configDir,
    config,
    buildConfig,
    registry,
    cacheEntries,
    previousCache,
    plugins,
    resolvedTaskRules,
  };

  const results = await runAllWriters(ctx);

  await writePluginLock(projectDir, plugins, registry, rawContents);

  await writeChecksumCache(projectDir, {
    owner: 'resolver',
    version: '1',
    entries: cacheEntries,
  });

  const generated = results.filter(r => r.written).map(r => r.file);
  const skipped = results.filter(r => !r.written).map(r => r.file);

  const roleCount = config.orgs.reduce(
    (sum, org) => sum + org.teams.reduce(
      (tSum, team) => tSum + team.roles.length, 0
    ), 0
  );

  return {
    generated,
    skipped,
    configDir,
    runtimeConfig: config,
    registry,
    summary: {
      orgCount: config.orgs.length,
      pluginCount: plugins.length,
      roleCount,
    },
  };
}

/**
 * Runs all config writers and collects their results.
 *
 * @param ctx - The shared writer context.
 * @returns An array of WriteResult objects from all writers.
 */
async function runAllWriters(ctx: WriterContext) {
  return [
    await writeOrgsConfig(ctx),
    await writeTasksConfig(ctx),
    await writeTaskRulesConfig(ctx),
    await writePersonasConfig(ctx),
    await writeOutcomesConfig(ctx),
    await writeConstraintsConfig(ctx),
    await writeTokenBudgetConfig(ctx),
    await writeHealthCheckConfig(ctx),
  ];
}

/**
 * Loads pillar files from disk and returns their content.
 *
 * Resolves relative paths against the project directory. Absolute paths
 * are used as-is. Throws on the first file that cannot be read.
 *
 * @param pillarPaths - Array of declared pillar file paths.
 * @param projectDir - Absolute path to the project root for relative resolution.
 * @returns An array of PillarEntry objects with original path and loaded content.
 * @throws {Error} If any pillar file does not exist or is not readable.
 */
async function loadPillars(
  pillarPaths: string[],
  projectDir: string
): Promise<PillarEntry[]> {
  const entries: PillarEntry[] = [];

  for (const p of pillarPaths) {
    const absPath = isAbsolute(p) ? p : join(projectDir, p);
    try {
      const content = await readFile(absPath, 'utf-8');
      entries.push({ path: p, content });
    } catch {
      throw new Error(
        `Pillar file not found: "${p}" (resolved to "${absPath}")`
      );
    }
  }

  return entries;
}
