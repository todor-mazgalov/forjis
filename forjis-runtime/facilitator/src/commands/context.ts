/**
 * `forjis context refresh` command handler.
 *
 * Resolves the build file to obtain the project root and the configured
 * context engine name, lazily loads that engine, and then drives the
 * incremental `refreshTreeYaml` pipeline with a wired-up summariser. When
 * the engine is unavailable (binary missing on PATH, registry miss, spawn
 * failure) the adapter falls through cleanly so the refresh pipeline still
 * writes its byproducts with empty summaries — preserving the FR-011
 * "degrade cleanly" contract.
 */

import { resolve as resolvePath } from 'node:path';

import { resolve as resolveConfig } from '@forjis/resolver';

import {
  refreshTreeYaml,
  summarizeFile,
  type SummarizeOptions,
} from '../context-cache/index.js';
import { loadEngine } from '../engine.js';
import { PromptOptions } from '../types.js';

/** Default engine name when `context.engine` is omitted from the build file. */
const DEFAULT_CONTEXT_ENGINE = 'claude';

/** Warning-line prefix shared with the rest of the context-cache module. */
const WARN_PREFIX = '[context-cache]:';

/**
 * Adapter shape accepted by {@link summarizeFile}'s `engineInvokeImpl`
 * seam. Combines the static system prompt and the per-file user prompt
 * into a single delegated engine call.
 */
type EngineInvokeImpl = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

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

  const engineName = await readContextEngineName(absBuildFile);
  const engineImpl = await tryLoadEngineImpl(engineName);

  const result = await refreshTreeYaml({
    repoRoot: projectDir,
    summarizeImpl: engineImpl
      ? (input, opts) =>
          summarizeFile(input, {
            ...(opts as SummarizeOptions | undefined),
            engineInvokeImpl: engineImpl,
          })
      : undefined,
  });
  console.log(
    `context refresh: ${result.summarizedCount} summarized, ${result.keptCount} kept, ${result.droppedCount} dropped`,
  );
}

/**
 * Reads the resolved `context.engine` name straight from the build file.
 *
 * Returns the explicit value when set, otherwise falls back to the
 * default registered engine name. The build file has already been
 * shape-validated by the time this helper runs.
 *
 * @param buildFilePath - Absolute path to the build file.
 * @returns The engine name to feed into {@link loadEngine}.
 */
async function readContextEngineName(buildFilePath: string): Promise<string> {
  const { loadBuildFile, parseBuildFile } = await import('@forjis/resolver');
  const content = await loadBuildFile(buildFilePath);
  const config = parseBuildFile(content);
  return config.context.engine ?? DEFAULT_CONTEXT_ENGINE;
}

/**
 * Lazily loads the named engine and wraps it in a summariser-shaped
 * adapter compatible with `summarize.ts`'s `engineInvokeImpl` seam.
 *
 * The adapter combines the static system prompt and the per-file user
 * prompt with a `\n\n---\n\n` separator before delegating to the
 * engine's single-string `prompt()` method. This preserves the cache-
 * friendly system/user split inside the prompt body even when the
 * underlying engine takes a single string.
 *
 * Engine-load failures (`EngineNotFoundError`, spawn failure, any other
 * thrown error) are caught, logged exactly once with a fixed message,
 * and translated into `undefined` so the caller can fall through to the
 * existing no-engine short-circuit. Error messages never echo prompt
 * content or engine output.
 *
 * @param engineName - Engine name read from the resolved configuration.
 * @returns A summariser-shaped adapter, or `undefined` when the engine
 *   cannot be loaded for any reason.
 */
export async function tryLoadEngineImpl(
  engineName: string,
): Promise<EngineInvokeImpl | undefined> {
  let engine;
  try {
    engine = await loadEngine(engineName);
  } catch {
    console.warn(
      `${WARN_PREFIX} engine "${engineName}" unavailable — summaries will be empty`,
    );
    return undefined;
  }

  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
    const opts = new PromptOptions();
    opts.returnOutput = true;
    return engine.prompt(combined, opts);
  };
}
