/**
 * Tasks config file writer.
 *
 * Generates `.forjis/config/tasks.yaml` containing static task configuration
 * extracted from the build file.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { formatDuration } from '../build-file.js';
import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { WriterContext, WriteResult } from '../types.js';

/** Cache key used for the tasks config file. */
const CACHE_KEY = 'config:tasks';

/** Output filename. */
const FILE_NAME = 'tasks.yaml';

/**
 * Generates .forjis/config/tasks.yaml.
 *
 * Extracts static task configuration from BuildConfig. The poll_interval
 * is formatted back to a human-readable duration string.
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeTasksConfig(ctx: WriterContext): Promise<WriteResult> {
  const tasks = ctx.buildConfig.tasks;

  const tasksData: Record<string, unknown> = {};
  if (tasks) {
    if (tasks.source) tasksData['source'] = tasks.source;
    if (tasks.path) tasksData['path'] = tasks.path;
    tasksData['poll_interval'] = formatDuration(tasks.pollIntervalMs);
    if (tasks.maxConcurrent !== undefined) tasksData['max_concurrent'] = tasks.maxConcurrent;
    tasksData['auto_dependencies'] = tasks.autoDependencies;
  }

  const content = stringifyYaml(tasksData, { indent: 2 });
  const hash = computeHash(content);

  if (!isChanged(CACHE_KEY, hash, ctx.previousCache)) {
    return { file: FILE_NAME, written: false };
  }

  await ensureDir(ctx.configDir);
  await atomicWriteFile(join(ctx.configDir, FILE_NAME), content);

  ctx.cacheEntries[CACHE_KEY] = {
    sourceHash: hash,
    targetPaths: [FILE_NAME],
    generatedAt: new Date().toISOString(),
  };

  return { file: FILE_NAME, written: true };
}
