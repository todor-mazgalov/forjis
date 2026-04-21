/**
 * Stop command for @forjis/cli.
 *
 * Stops running tasks by killing their Claude subprocesses and
 * transitioning them to failed status. Reads PID files written
 * by the engine during subprocess spawning.
 */

import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readYamlFile, writeYamlFile } from '../state.js';
import { killProcess, readPidFile, pidFilePath } from '../process-utils.js';
import type { TaskState } from '../types.js';

/**
 * Handles the `forjis stop` command.
 *
 * Stops all running tasks, or a specific task if taskId is provided.
 * Reads PID files from .forjis/tasks/<taskId>/pid, kills the process
 * tree, and transitions the task to failed status.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - Optional specific task ID to stop.
 */
export async function stopCommand(projectDir: string, taskId?: string): Promise<void> {
  const tasksDir = join(projectDir, '.forjis', 'tasks');

  let dirs: string[];
  try {
    dirs = await readdir(tasksDir) as unknown as string[];
  } catch {
    console.log('[forjis]: no tasks directory found');
    return;
  }

  let stopped = 0;

  for (const dir of dirs) {
    if (taskId && dir !== taskId) {
      continue;
    }

    const statePath = join(tasksDir, dir, 'state.yaml');
    const state = await readYamlFile<TaskState>(statePath);
    if (!state || state.status !== 'running') {
      continue;
    }

    const pid = await readPidFile(projectDir, dir);

    if (pid !== null) {
      killProcess(pid);
      console.log(`[forjis]: killed process tree for task "${dir}" (pid: ${pid})`);

      try { await unlink(pidFilePath(projectDir, dir)); } catch { /* ignore */ }
    } else {
      console.log(`[forjis]: no PID file for task "${dir}", marking as failed`);
    }

    state.status = 'failed';
    state.completed = new Date().toISOString();
    await writeYamlFile(statePath, state);
    console.log(`[forjis]: stopped task "${dir}"`);
    stopped++;
  }

  if (stopped === 0) {
    console.log('[forjis]: no running tasks to stop');
  } else {
    console.log(`[forjis]: stopped ${stopped} task(s)`);
  }
}

