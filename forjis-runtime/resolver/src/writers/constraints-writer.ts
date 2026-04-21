/**
 * Constraints config file writer.
 *
 * Generates `.forjis/config/constraints.yaml` with fully merged mandatory
 * and optional constraint text. Plugin constraints are merged by the
 * plugin-compositor into RuntimeConfig.resolvedConstraints; this writer
 * simply serializes the final result.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { WriterContext, WriteResult } from '../types.js';

/** Cache key used for the constraints config file. */
const CACHE_KEY = 'config:constraints';

/** Output filename. */
const FILE_NAME = 'constraints.yaml';

/**
 * Generates .forjis/config/constraints.yaml.
 *
 * Outputs the fully merged mandatory and optional constraint text from
 * RuntimeConfig.resolvedConstraints. Plugin constraints have already been
 * merged by the plugin-compositor.
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeConstraintsConfig(ctx: WriterContext): Promise<WriteResult> {
  const constraintsData: Record<string, unknown> = {
    mandatory: ctx.config.resolvedConstraints.mandatory,
    optional: ctx.config.resolvedConstraints.optional,
  };

  if (ctx.config.resolvedConstraints.pillars.length > 0) {
    constraintsData.pillars = ctx.config.resolvedConstraints.pillars;
  }
  const content = stringifyYaml(constraintsData, { indent: 2 });
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
