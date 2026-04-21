/**
 * Strategist command handler for @forjis/facilitator.
 *
 * Provides the `strategistRunCommand` function that delegates scanning
 * to the orchestrator via engine.invoke(). Supports standalone mode
 * (single scan) and looping mode (repeated scan-execute cycles).
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolve as resolveConfig } from '@forjis/resolver';
import type { ConfigResult } from '@forjis/resolver';

import { readEngineFromConfig } from '../config-utils.js';
import { loadEngine } from '../engine.js';
import type { ForjisEngine } from '../engine.js';
import { readYamlFile } from '../state.js';
import { runCommand } from './run.js';

/** Options controlling strategist execution mode. */
export interface StrategistOptions {
  /** Number of scan-execute cycles, or null for standalone mode. */
  loopCount: number | null;
}

/**
 * Executes the strategist command in standalone or looping mode.
 *
 * In standalone mode, performs a single scan by delegating to the orchestrator.
 * In looping mode, performs repeated scan-execute cycles where each cycle
 * delegates to the orchestrator and then runs the pipeline for new tasks.
 *
 * @param cwd - Current working directory (project root).
 * @param buildFilePath - Path to the build.forjis file.
 * @param options - Strategist execution options.
 */
export async function strategistRunCommand(
  cwd: string,
  buildFilePath: string,
  options: StrategistOptions
): Promise<void> {
  const configResult = await resolveConfig(buildFilePath, { projectDir: cwd });

  const tasksConfig = await readYamlFile<{ path: string }>(
    join(configResult.configDir, 'tasks.yaml')
  );
  const tasksDir = tasksConfig ? resolve(cwd, tasksConfig.path) : resolve(cwd, '.forjis', 'tasks');

  const engineName = await readEngineFromConfig(buildFilePath);
  const engine = await loadEngine(engineName);

  if (options.loopCount === null) {
    console.log('[strategist]: delegating standalone scan to orchestrator...');
    await engine.invoke({
      projectDir: cwd,
      taskId: 'strategist',
      taskDescription: 'Strategist standalone scan',
      configDir: configResult.configDir,
      mode: 'strategist',
      modeArgs: { mode: 'standalone' },
      dryRun: false,
    });
    console.log('[strategist]: standalone scan complete');
    return;
  }

  await executeLoopingMode(engine, configResult, tasksDir, cwd, buildFilePath, options.loopCount);
}

// -- Internal helpers --------------------------------------------------------

/**
 * Runs the strategist in looping mode: repeated scan-execute cycles
 * with early exit when no new findings are produced.
 *
 * Each scan cycle delegates to the orchestrator instead of composing prompts.
 * After each scan, new task files are counted and the full pipeline is run.
 *
 * @param engine - The loaded Forjis engine instance.
 * @param configResult - The resolver config result.
 * @param tasksDir - Absolute path to the tasks directory.
 * @param projectDir - Absolute path to the project root.
 * @param buildFilePath - Path to the build.forjis file for pipeline execution.
 * @param loopCount - Maximum number of scan-execute cycles.
 */
async function executeLoopingMode(
  engine: ForjisEngine,
  configResult: ConfigResult,
  tasksDir: string,
  projectDir: string,
  buildFilePath: string,
  loopCount: number
): Promise<void> {
  let completedCycles = 0;

  for (let i = 0; i < loopCount; i++) {
    console.log(`[strategist]: starting cycle ${i + 1} of ${loopCount}...`);

    const previousFiles = await snapshotTaskFiles(tasksDir);

    await engine.invoke({
      projectDir,
      taskId: 'strategist',
      taskDescription: `Strategist loop scan cycle ${i + 1}`,
      configDir: configResult.configDir,
      mode: 'strategist',
      modeArgs: { mode: 'loop' },
      dryRun: false,
    });

    const { count } = await countNewTaskFiles(tasksDir, previousFiles);

    if (count === 0) {
      console.log(
        `[strategist]: no new issues found in cycle ${i + 1}. ` +
        `Completed ${completedCycles + 1} cycle(s). Exiting early.`
      );
      return;
    }

    console.log(`[strategist]: cycle ${i + 1} found ${count} new task(s). Running pipeline...`);

    await runCommand({
      buildFilePath,
      inlineTask: null,
      dryRun: false,
      watch: false,
      noAssess: false,
      web: false,
      port: 4242,
      host: '127.0.0.1',
      webToken: null,
      projectDir,
    });

    completedCycles++;
    console.log(`[strategist]: cycle ${i + 1} pipeline complete`);
  }

  console.log(
    `[strategist]: completed ${completedCycles} cycle(s) of ${loopCount}`
  );
}

/**
 * Counts new task files in a directory compared to a previous snapshot.
 *
 * @param tasksDir - Absolute path to the tasks directory.
 * @param previousFiles - Set of filenames from the previous snapshot.
 * @returns An object with the count of new files and the current file set.
 */
async function countNewTaskFiles(
  tasksDir: string,
  previousFiles: Set<string>
): Promise<{ count: number; currentFiles: Set<string> }> {
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    entries = [];
  }

  const currentFiles = new Set(entries.filter((f) => f.endsWith('.md')));
  let count = 0;

  for (const file of currentFiles) {
    if (!previousFiles.has(file)) {
      count++;
    }
  }

  return { count, currentFiles };
}

/**
 * Snapshots the current set of markdown filenames in the tasks directory.
 *
 * @param tasksDir - Absolute path to the tasks directory.
 * @returns A set of markdown filenames currently in the directory.
 */
async function snapshotTaskFiles(tasksDir: string): Promise<Set<string>> {
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    entries = [];
  }

  return new Set(entries.filter((f) => f.endsWith('.md')));
}
