/**
 * Token budget config file writer.
 *
 * Generates `.forjis/config/token-budget.yaml` with the configured
 * token budget limits and reset window.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { formatDuration } from '../build-file.js';
import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { WriterContext, WriteResult } from '../types.js';

/** Cache key used for the token budget config file. */
const CACHE_KEY = 'config:token-budget';

/** Output filename. */
const FILE_NAME = 'token-budget.yaml';

/**
 * Generates .forjis/config/token-budget.yaml.
 *
 * Reads from buildConfig.tokenBudget. The reset_window is formatted
 * back to a human-readable duration string.
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeTokenBudgetConfig(ctx: WriterContext): Promise<WriteResult> {
  const budget = ctx.buildConfig.tokenBudget;

  const data: Record<string, unknown> = {};
  if (budget) {
    data['max_tokens'] = budget.maxTokens;
    if (budget.resetWindowMs) {
      data['reset_window'] = formatDuration(budget.resetWindowMs);
    }
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
