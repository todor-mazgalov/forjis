/**
 * `forjis context refresh` command handler.
 *
 * Thin wrapper that resolves the build file to obtain the project root,
 * then calls `refreshTreeYaml` from the local context-cache module.
 * Always exits successfully at the command level — the refresh pipeline
 * already degrades to zero counts on any failure (spec R11).
 */

import { resolve as resolvePath } from 'node:path';

import { resolve as resolveConfig } from '@forjis/resolver';

import { refreshTreeYaml } from '../context-cache/index.js';

/**
 * Refreshes `.forjis/context/tree.yaml` + `.forjis/context/index.md`.
 *
 * Exit code 0 even on partial failure: the underlying
 * `refreshTreeYaml` already logs and returns zero counts when the
 * pipeline cannot run. Exit non-zero only when the build file itself
 * cannot be resolved (`resolve()` throws).
 *
 * @param cwd - Current working directory when the CLI was invoked.
 * @param buildFilePath - Relative or absolute path to the build file.
 */
export async function contextRefreshCommand(
  cwd: string,
  buildFilePath?: string,
): Promise<void> {
  const filePath = buildFilePath ?? 'build.forjis';
  const absBuildFile = resolvePath(cwd, filePath);
  const configResult = await resolveConfig(absBuildFile);
  // `configDir` is always `<projectDir>/.forjis/config` — two parents up.
  const projectDir = resolvePath(configResult.configDir, '..', '..');

  const result = await refreshTreeYaml({ repoRoot: projectDir });
  console.log(
    `context refresh: ${result.summarizedCount} summarized, ${result.keptCount} kept, ${result.droppedCount} dropped`
  );
}
