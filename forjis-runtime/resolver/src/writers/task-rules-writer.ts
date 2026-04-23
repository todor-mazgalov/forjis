/**
 * Task rules config file writer.
 *
 * Generates `.forjis/config/task-rules.yaml` from `ctx.resolvedTaskRules`.
 * The writer always emits, even when no rules are included (the file then
 * contains `{ version: 1, rules: [] }`) so that orchestrator Step 5b can
 * read an existing file unconditionally. Order of the `rules:` array is
 * the include order from the build file; a leading header comment
 * documents that first-match-wins ordering is significant.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { ResolvedTaskRule, WriteResult, WriterContext } from '../types.js';

/** Cache key used for the task rules config file. */
export const CACHE_KEY = 'config:task-rules';

/** Output filename inside `.forjis/config/`. */
export const FILE_NAME = 'task-rules.yaml';

/**
 * Header comment prepended to the emitted YAML. Mitigates R-004 by
 * reminding the reader that include order is significant.
 */
const HEADER_COMMENT = '# Machine-generated. Order is significant (first-match-wins).\n';

/**
 * Generates `.forjis/config/task-rules.yaml`.
 *
 * Builds the emitted object from `ctx.resolvedTaskRules`. When the array
 * is empty, still emits `{ version: 1, rules: [] }` so downstream
 * orchestrator steps can assume the file's presence.
 *
 * @param ctx - The shared writer context containing `resolvedTaskRules`.
 * @returns A {@link WriteResult} indicating whether the file was written
 *   (true) or skipped because its checksum is unchanged (false).
 * @throws {Error} When the underlying atomic filesystem write fails.
 */
export async function writeTaskRulesConfig(ctx: WriterContext): Promise<WriteResult> {
  const data = buildTaskRulesOutput(ctx.resolvedTaskRules);
  const content = HEADER_COMMENT + stringifyYaml(data, { indent: 2 });
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
 * Shapes the resolved rules into the wire format written to disk.
 *
 * The returned object preserves include order (first-match-wins) and
 * strips away any transient resolver-side fields. When the input array
 * is empty, returns `{ version: 1, rules: [] }`.
 */
function buildTaskRulesOutput(
  resolved: ResolvedTaskRule[]
): { version: 1; rules: ResolvedTaskRule[] } {
  const rules = resolved.map(rule => ({
    name: rule.name,
    plugin: rule.plugin,
    matches: { ...rule.matches },
    skip: [...rule.skip],
    prompt_prepends: { ...rule.prompt_prepends },
  }));
  return { version: 1, rules };
}
