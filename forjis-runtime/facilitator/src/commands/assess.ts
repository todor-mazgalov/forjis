/**
 * Assess command for @forjis/cli.
 *
 * Re-runs outcome assessment on a completed or failed task by delegating
 * to the orchestrator via engine.invoke() with mode 'assess'. All scoring
 * logic lives in the orchestrator; this command validates task state and
 * invokes the engine.
 */

import { resolve as resolveConfig } from '@forjis/resolver';

import { readEngineFromConfig } from '../config-utils.js';
import { loadEngine } from '../engine.js';
import { TaskNotFoundError, TaskInvalidStateError } from '../errors.js';
import { TaskQueue } from '../task-queue.js';

/**
 * Handles the `forjis assess <task-id>` command.
 *
 * Validates the task state, resolves configuration via @forjis/resolver,
 * then delegates assessment to the orchestrator via engine.invoke().
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The ID of the task to assess.
 * @param buildFilePath - Path to the build.forjis file.
 * @throws {TaskNotFoundError} If the task does not exist.
 * @throws {TaskInvalidStateError} If the task is not in done/failed state.
 */
export async function assessCommand(
  projectDir: string,
  taskId: string,
  buildFilePath: string
): Promise<void> {
  const queue = new TaskQueue(projectDir, null);
  const state = await queue.getState(taskId);

  if (!state) {
    throw new TaskNotFoundError(taskId);
  }

  if (state.status !== 'done' && state.status !== 'failed') {
    throw new TaskInvalidStateError(taskId, state.status);
  }

  const configResult = await resolveConfig(buildFilePath, { projectDir });

  const engineName = await readEngineFromConfig(buildFilePath);
  const engine = await loadEngine(engineName);
  await engine.checkPrerequisites();

  console.log(`[assess]: delegating assessment for task "${taskId}" to orchestrator...`);
  await engine.invoke({
    projectDir,
    taskId,
    taskDescription: state.description,
    configDir: configResult.configDir,
    mode: 'assess',
    dryRun: false,
  });
}

