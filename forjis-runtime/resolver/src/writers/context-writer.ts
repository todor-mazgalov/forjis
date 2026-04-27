/**
 * Context config file writer.
 *
 * Generates `.forjis/config/context.yaml` containing the resolved
 * file-level context index configuration (`refresh_on_task`,
 * `inline_top_n`, `concurrency`, optional `engine`, and `model`).
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { ContextConfig, WriterContext, WriteResult } from '../types.js';

/** Cache key used for the context config file. */
const CACHE_KEY = 'config:context';

/** Output filename. */
const FILE_NAME = 'context.yaml';

/**
 * Generates .forjis/config/context.yaml.
 *
 * Reads the resolved {@link ContextConfig} from the build config (the
 * resolver applies defaults for an omitted / null `context:` block).
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeContextConfig(ctx: WriterContext): Promise<WriteResult> {
  const config: ContextConfig = ctx.buildConfig.context;

  const data: Record<string, unknown> = {
    refresh_on_task: config.refresh_on_task,
    inline_top_n: config.inline_top_n,
    concurrency: config.concurrency,
  };
  if (config.engine !== undefined) {
    data['engine'] = config.engine;
  }
  if (config.model !== undefined) {
    data['model'] = config.model;
  }

  const content = stringifyYaml(data, { indent: 2 });
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

/**
 * Writes .forjis/config/context.yaml directly from a {@link ContextConfig}.
 *
 * Thin helper that bypasses the WriterContext pipeline; used where the
 * resolver needs to write the file from a bare config object (e.g. tests
 * or future non-resolver callers). Always writes atomically.
 *
 * @param outDir - Absolute path to `.forjis/config/`.
 * @param config - The resolved context configuration.
 */
export async function writeContextYaml(
  outDir: string,
  config: ContextConfig,
): Promise<void> {
  const data: Record<string, unknown> = {
    refresh_on_task: config.refresh_on_task,
    inline_top_n: config.inline_top_n,
    concurrency: config.concurrency,
  };
  if (config.engine !== undefined) {
    data['engine'] = config.engine;
  }
  if (config.model !== undefined) {
    data['model'] = config.model;
  }
  const content = stringifyYaml(data, { indent: 2 });
  await ensureDir(outDir);
  await atomicWriteFile(join(outDir, FILE_NAME), content);
}
