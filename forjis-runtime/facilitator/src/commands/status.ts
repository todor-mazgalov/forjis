/**
 * Status command for @forjis/cli.
 *
 * Displays the current queue state with task counts, individual
 * task statuses, and assessment scores for completed tasks.
 */

import { join } from 'node:path';

import { renderStatus } from '../display.js';
import { readYamlFile } from '../state.js';
import { TaskQueue } from '../task-queue.js';
import type { AssessmentResult } from '../types.js';

/**
 * Handles the `forjis status` command.
 *
 * Loads all task states and assessments, then renders and prints
 * the status board to stdout.
 *
 * @param projectDir - The root directory of the target project.
 */
export async function statusCommand(projectDir: string): Promise<void> {
  const queue = new TaskQueue(projectDir, null);
  const tasks = await queue.listAll();

  const assessments = new Map<string, AssessmentResult>();
  for (const task of tasks) {
    const assessment = await readYamlFile<AssessmentResult>(
      join(projectDir, '.forjis', 'tasks', task.id, 'assessment.yaml')
    );
    if (assessment) {
      assessments.set(task.id, assessment);
    }
  }

  const output = renderStatus(tasks, assessments);
  console.log(output);
}
