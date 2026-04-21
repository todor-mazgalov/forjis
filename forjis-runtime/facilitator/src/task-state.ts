/**
 * Task state utilities for @forjis/cli.
 *
 * Provides engine-neutral functions for reading task metadata from the
 * .forjis/tasks/ directory. These are not engine-specific and remain
 * part of the public API.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read the current pipeline stage from TASK.md metadata.
 *
 * Parses the TASK.md file for a `stage: <value>` line and returns
 * the stage string. Returns null if the file does not exist or no
 * stage line is found.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task ID to look up.
 * @returns The current stage name, or null if unavailable.
 */
export async function getCurrentStage(
  projectDir: string,
  taskId: string
): Promise<string | null> {
  const taskMdPath = join(projectDir, '.forjis', 'tasks', taskId, 'TASK.md');

  try {
    const content = await readFile(taskMdPath, 'utf-8');
    const stageMatch = content.match(/^stage:\s*(.+)$/m);
    return stageMatch ? stageMatch[1].trim() : null;
  } catch {
    return null;
  }
}
