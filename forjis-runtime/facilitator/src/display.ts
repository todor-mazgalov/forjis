/**
 * Terminal status display for @forjis/cli.
 *
 * Renders a formatted status board showing the task queue state,
 * including task counts, individual task lines with status icons,
 * and assessment scores for completed tasks.
 */

import type { AssessmentResult, TaskState } from './types.js';

/** Width of the separator line in the status display. */
const SEPARATOR_WIDTH = 53;

/** Status icons for each task status. */
const STATUS_ICONS: Record<string, string> = {
  running: '>',
  queued: '~',
  pending: '~',
  needs_clarification: '!',
  done: '*',
  failed: 'x',
};

/**
 * Renders the full queue status board as a formatted string.
 *
 * Tasks are sorted: running first, then queued/pending, then
 * needs_clarification, then done, then failed.
 *
 * @param tasks - All tasks in the queue.
 * @param assessments - Map of task IDs to their assessment results.
 * @returns The complete status board string ready for printing.
 */
export function renderStatus(
  tasks: TaskState[],
  assessments: Map<string, AssessmentResult>
): string {
  const lines: string[] = [];
  const separator = 'FORJIS ' + '-'.repeat(SEPARATOR_WIDTH - 7);

  lines.push(separator);
  lines.push(renderSummary(tasks));
  lines.push('');

  const sorted = sortForDisplay(tasks);

  for (const task of sorted) {
    const assessment = assessments.get(task.id) ?? null;
    lines.push(renderTaskLine(task, assessment));
  }

  lines.push('-'.repeat(SEPARATOR_WIDTH));

  return lines.join('\n');
}

/**
 * Renders a single task line for the status board.
 *
 * Shows the status icon, task ID, status label, truncated description,
 * and a suffix (stage for running, scores for done, INPUT PENDING for blocked).
 *
 * @param task - The task state to render.
 * @param assessment - The assessment result if available.
 * @returns A formatted single line for the task.
 */
export function renderTaskLine(
  task: TaskState,
  assessment: AssessmentResult | null
): string {
  const icon = STATUS_ICONS[task.status] ?? '?';
  const statusLabel = task.status === 'needs_clarification' ? 'blocked' : task.status;
  const desc = truncateDescription(task.description, 30);

  let suffix = '';

  if (task.status === 'running' && task.currentStage) {
    suffix = `  [${task.currentStage}]`;
  } else if (task.status === 'needs_clarification') {
    suffix = '  INPUT PENDING';
  } else if ((task.status === 'done' || task.status === 'failed') && assessment) {
    const c = assessment.scores['completeness'] ?? 0;
    const s = assessment.scores['speculation'] ?? 0;
    const h = assessment.scores['hallucination'] ?? 0;
    suffix = `  ${c}/${s}/${h}`;
  }

  return `${icon} ${padRight(task.id, 10)}  ${padRight(statusLabel, 10)}  "${desc}"${suffix}`;
}

/**
 * Renders the summary header line showing task counts by status category.
 *
 * @param tasks - All tasks in the queue.
 * @returns The formatted summary line.
 */
export function renderSummary(tasks: TaskState[]): string {
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'queued').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const blocked = tasks.filter(t => t.status === 'needs_clarification').length;

  return `Queue: ${pending} pending | ${running} running | ${done} done | ${blocked} blocked`;
}

// -- Internal helpers -------------------------------------------------------

/** Sorts tasks for display: running, queued/pending, blocked, done, failed. */
function sortForDisplay(tasks: TaskState[]): TaskState[] {
  const order: Record<string, number> = {
    running: 0,
    queued: 1,
    pending: 2,
    needs_clarification: 3,
    done: 4,
    failed: 5,
  };

  return [...tasks].sort((a, b) => {
    return (order[a.status] ?? 6) - (order[b.status] ?? 6);
  });
}

/** Truncates a description to a max length with ellipsis. */
function truncateDescription(desc: string, maxLen: number): string {
  const firstLine = desc.split('\n')[0].trim();
  if (firstLine.length <= maxLen) {
    return firstLine;
  }
  return firstLine.substring(0, maxLen - 3) + '...';
}

/** Pads a string to the right with spaces. */
function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}
