/**
 * Shared process utilities for the facilitator package.
 *
 * Provides cross-platform process tree termination and PID-file I/O
 * helpers used by health-check, run, and stop commands.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Builds the absolute path to the PID file for a task.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @returns Absolute path to `.forjis/tasks/<taskId>/pid`.
 */
export function pidFilePath(projectDir: string, taskId: string): string {
  return join(projectDir, '.forjis', 'tasks', taskId, 'pid');
}

/**
 * Kills a subprocess and its children cross-platform.
 *
 * On Windows uses `taskkill /F /PID /T` for process tree kill.
 * On Unix attempts `process.kill(-pid, 'SIGTERM')` for process group,
 * falling back to `process.kill(pid, 'SIGTERM')` for single-process termination.
 *
 * @param pid - The process ID to terminate.
 */
export function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/PID', String(pid), '/T']);
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Process already dead */
      }
    }
  }
}

/**
 * Reads the PID from the task's pid file asynchronously.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @returns The parsed PID number, or null if the file does not exist or content is invalid.
 */
export async function readPidFile(
  projectDir: string,
  taskId: string,
): Promise<number | null> {
  const pidPath = pidFilePath(projectDir, taskId);
  try {
    const content = await readFile(pidPath, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Reads the PID from the task's pid file synchronously.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @returns The parsed PID number, or null if the file does not exist or content is invalid.
 */
export function readPidSync(
  projectDir: string,
  taskId: string,
): number | null {
  const pidPath = pidFilePath(projectDir, taskId);
  try {
    const content = readFileSync(pidPath, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}
