/**
 * Task service implementation for the web dashboard backend.
 *
 * Implements the TaskService interface by reading from the live TaskQueue.
 * Provides task listing with dashboard-friendly sorting and existence checks
 * for the API layer's 404 validation. For running tasks, also computes a
 * lightweight progress summary by reading pipeline-plan.yaml on demand.
 */

import { join } from 'node:path';

import { readYamlFile } from '../state.js';
import type { TaskPriority, TaskStatus } from '../types.js';
import { priorityToNumeric } from '../task-queue.js';
import type { TaskQueue } from '../task-queue.js';
import type { TaskService } from '@forjis/shared';
import type { TaskListItem, PipelinePlanResponse } from '@forjis/shared';

/**
 * Status sort order for dashboard display.
 *
 * Running tasks appear first, followed by queued, pending,
 * needs_clarification, done, and failed.
 */
const STATUS_ORDER: Record<TaskStatus, number> = {
  running: 0,
  queued: 1,
  pending: 2,
  needs_clarification: 3,
  done: 4,
  failed: 5,
};

/**
 * Implements TaskService by reading from the live TaskQueue.
 *
 * Receives the TaskQueue instance by reference. Each method call reads
 * fresh data from disk (via TaskQueue's file-backed state), so results
 * always reflect the current queue state.
 */
export class TaskServiceImpl implements TaskService {
  /**
   * Creates a TaskServiceImpl.
   *
   * @param queue - The live TaskQueue instance from the run command.
   * @param projectDir - Absolute project root, used to locate pipeline-plan.yaml
   *   when computing progress for running tasks.
   */
  constructor(
    private readonly queue: TaskQueue,
    private readonly projectDir: string,
  ) {}

  /**
   * Returns all tasks sorted for dashboard display.
   *
   * Sort order: running > queued > pending > needs_clarification > done > failed.
   * Within the same status group: higher priority first, then earliest created first.
   * Maps each TaskState to a TaskListItem, converting optional fields to null.
   * Running tasks are augmented with a progress summary computed from
   * pipeline-plan.yaml (excludes the synthetic orchestrator step).
   *
   * @returns Array of TaskListItem sorted for display.
   */
  async listTasks(): Promise<TaskListItem[]> {
    const states = await this.queue.listAll();

    const items: TaskListItem[] = await Promise.all(states.map(async (state) => {
      const item: TaskListItem = {
        id: state.id,
        status: state.status,
        priority: state.priority,
        description: state.description,
        currentStage: state.currentStage ?? null,
        created: state.created,
        started: state.started ?? null,
        completed: state.completed ?? null,
        branches: state.branches,
      };

      if (state.status === 'running') {
        const progress = await computeProgress(this.projectDir, state.id);
        if (progress !== null) {
          item.progress = progress;
        }
      }

      return item;
    }));

    items.sort((a, b) => {
      const statusDiff = STATUS_ORDER[a.status as TaskStatus] - STATUS_ORDER[b.status as TaskStatus];
      if (statusDiff !== 0) return statusDiff;

      const priorityDiff =
        priorityToNumeric(b.priority as TaskPriority | number) -
        priorityToNumeric(a.priority as TaskPriority | number);
      if (priorityDiff !== 0) return priorityDiff;

      return a.created.localeCompare(b.created);
    });

    return items;
  }

  /**
   * Checks whether a task exists in the queue.
   *
   * @param taskId - The task identifier to check.
   * @returns True if getState returns a non-null value.
   */
  async taskExists(taskId: string): Promise<boolean> {
    const state = await this.queue.getState(taskId);
    return state !== null;
  }
}

/**
 * Computes a pipeline progress summary for a running task.
 *
 * Reads `pipeline-plan.yaml` for the task and counts non-orchestrator steps.
 * The synthetic orchestrator pseudo-step is excluded from `total`, `done`,
 * and the `steps` array. Returns null when the plan file is missing
 * (graceful degradation: callers should treat this as "no progress available").
 *
 * @param projectDir - Absolute project root.
 * @param taskId - Task identifier.
 * @returns Progress summary or null when no plan is available.
 */
async function computeProgress(
  projectDir: string,
  taskId: string,
): Promise<{
  total: number;
  done: number;
  current: string | null;
  steps: {
    role: string;
    team?: string;
    status: 'done' | 'running' | 'planned' | 'skipped';
  }[];
} | null> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const plan = await readYamlFile<PipelinePlanResponse>(planPath);
  if (!plan?.steps) return null;

  const roleSteps = plan.steps.filter((s) => s.kind !== 'orchestrator');
  if (roleSteps.length === 0) {
    return { total: 0, done: 0, current: null, steps: [] };
  }

  const total = roleSteps.length;
  const done = roleSteps.filter(
    (s) => s.status === 'done' || s.status === 'skipped',
  ).length;
  const running = roleSteps.find((s) => s.status === 'running');
  const fallback = roleSteps.find(
    (s) => s.status !== 'done' && s.status !== 'skipped',
  );
  const current = running?.role ?? fallback?.role ?? null;
  // Emit `team` alongside `role` so the client can render the `role @ team`
  // two-tone label (see progress-segments.ts). Historical plans without
  // structured identity fields still round-trip via the optional team field.
  const steps = roleSteps.map((s) => {
    const entry: {
      role: string;
      team?: string;
      status: 'done' | 'running' | 'planned' | 'skipped';
    } = { role: s.role, status: s.status };
    if (typeof s.team === 'string' && s.team.length > 0) entry.team = s.team;
    return entry;
  });

  return { total, done, current, steps };
}
