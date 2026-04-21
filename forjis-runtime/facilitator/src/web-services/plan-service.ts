/**
 * Plan service implementation for the web dashboard backend.
 *
 * Implements the PlanService interface by reading pipeline-plan.yaml files
 * from disk. Each call reads the file fresh, ensuring the response reflects
 * the latest step statuses written by the plan writer module.
 */

import { join } from 'node:path';

import { readYamlFile } from '../state.js';
import type { PlanService } from '@forjis/shared';
import type { PipelinePlanResponse } from '@forjis/shared';

/**
 * Implements PlanService by reading pipeline-plan.yaml files from disk.
 *
 * Each call reads the file fresh, ensuring the response reflects the latest
 * step statuses written by the plan writer.
 */
export class PlanServiceImpl implements PlanService {
  /**
   * Creates a PlanServiceImpl.
   *
   * @param projectDir - The root directory of the target project.
   */
  constructor(private readonly projectDir: string) {}

  /**
   * Returns the pipeline plan for a task.
   *
   * Reads .forjis/tasks/<taskId>/pipeline-plan.yaml. Returns null if
   * the file does not exist (task has no plan yet, e.g., still queued).
   *
   * @param taskId - The task identifier.
   * @returns The plan response, or null if no plan file exists.
   */
  async getPlan(taskId: string): Promise<PipelinePlanResponse | null> {
    const planPath = join(
      this.projectDir,
      '.forjis',
      'tasks',
      taskId,
      'pipeline-plan.yaml',
    );
    return readYamlFile<PipelinePlanResponse>(planPath);
  }
}
