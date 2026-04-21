/**
 * Health check config file writer.
 *
 * Generates `.forjis/config/health-check.yaml` with the heartbeat
 * monitoring interval and retry configuration.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { WriterContext, WriteResult } from '../types.js';

/** Cache key used for the health check config file. */
const CACHE_KEY = 'config:health-check';

/** Output filename. */
const FILE_NAME = 'health-check.yaml';

/**
 * Generates .forjis/config/health-check.yaml.
 *
 * Reads from config.healthCheck, which has defaults already applied
 * by composeRuntime().
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeHealthCheckConfig(ctx: WriterContext): Promise<WriteResult> {
  const hc = ctx.config.healthCheck;

  const data = {
    interval: hc.interval,
    max_retries: hc.maxRetries,
  };

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
