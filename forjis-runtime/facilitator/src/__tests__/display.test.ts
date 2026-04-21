/**
 * Unit tests for display.ts — renderStatus, renderTaskLine, renderSummary.
 *
 * Requirements validated:
 *   Status command — renders task counts and per-task details
 *   Status command — running tasks show current stage
 *   Status command — completed tasks show scores
 *   Status command — blocked tasks show INPUT PENDING
 */

import { renderStatus, renderTaskLine, renderSummary } from '../display.js';
import type { AssessmentResult, TaskState } from '../types.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeTask(overrides?: Partial<TaskState>): TaskState {
  return {
    id: 'task-001',
    status: 'queued',
    priority: 'medium',
    created: new Date().toISOString(),
    source: 'cli',
    dependencies: [],
    description: 'Test task description',
    retryCount: 0,
    ...overrides,
  };
}

function makeAssessment(taskId: string, overrides?: Partial<AssessmentResult>): AssessmentResult {
  return {
    task: taskId,
    assessed: new Date().toISOString(),
    scores: { completeness: 92, speculation: 8, hallucination: 0 },
    verdict: 'PASS',
    warnings: [],
    failures: [],
    notes: [],
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// renderStatus
// --------------------------------------------------------------------------

describe('renderStatus', () => {
  /** Validates: Status command — output contains FORJIS header */
  it('contains FORJIS in the output', () => {
    const output = renderStatus([], new Map());
    expect(output).toContain('FORJIS');
  });

  it('shows summary with Queue: prefix', () => {
    const output = renderStatus([], new Map());
    expect(output).toContain('Queue:');
  });

  it('renders multiple tasks without throwing', () => {
    const tasks = [
      makeTask({ id: 'task-1', status: 'running', currentStage: 'architect' }),
      makeTask({ id: 'task-2', status: 'queued' }),
      makeTask({ id: 'task-3', status: 'done' }),
      makeTask({ id: 'task-4', status: 'needs_clarification' }),
    ];
    const assessments = new Map<string, AssessmentResult>([
      ['task-3', makeAssessment('task-3')],
    ]);
    expect(() => renderStatus(tasks, assessments)).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// renderSummary
// --------------------------------------------------------------------------

describe('renderSummary', () => {
  /** Validates: Status command — shows task counts per category */
  it('shows correct counts for each status', () => {
    const tasks = [
      makeTask({ status: 'queued' }),
      makeTask({ status: 'running' }),
      makeTask({ status: 'running' }),
      makeTask({ status: 'done' }),
      makeTask({ status: 'needs_clarification' }),
    ];
    const summary = renderSummary(tasks);
    expect(summary).toContain('1 pending');
    expect(summary).toContain('2 running');
    expect(summary).toContain('1 done');
    expect(summary).toContain('1 blocked');
  });

  it('counts both queued and pending as pending', () => {
    const tasks = [
      makeTask({ status: 'queued' }),
      makeTask({ status: 'pending' }),
    ];
    const summary = renderSummary(tasks);
    expect(summary).toContain('2 pending');
  });
});

// --------------------------------------------------------------------------
// renderTaskLine
// --------------------------------------------------------------------------

describe('renderTaskLine — running task shows stage', () => {
  /** Validates: Status command — running task shows current stage */
  it('shows stage in brackets for running task', () => {
    const task = makeTask({ status: 'running', currentStage: 'architect' });
    const line = renderTaskLine(task, null);
    expect(line).toContain('[architect]');
  });
});

describe('renderTaskLine — done task shows scores', () => {
  /** Validates: Status command — completed task shows completeness/speculation/hallucination */
  it('shows scores as completeness/speculation/hallucination for done task', () => {
    const task = makeTask({ status: 'done' });
    const assessment = makeAssessment(task.id, {
      scores: { completeness: 92, speculation: 8, hallucination: 0 },
    });
    const line = renderTaskLine(task, assessment);
    expect(line).toContain('92/8/0');
  });
});

describe('renderTaskLine — blocked task shows INPUT PENDING', () => {
  /** Validates: Status command — blocked task shows INPUT PENDING */
  it('shows INPUT PENDING for needs_clarification task', () => {
    const task = makeTask({ status: 'needs_clarification' });
    const line = renderTaskLine(task, null);
    expect(line).toContain('INPUT PENDING');
  });
});

describe('renderTaskLine — general format', () => {
  it('includes the task id in the line', () => {
    const task = makeTask({ id: 'my-task-42' });
    const line = renderTaskLine(task, null);
    expect(line).toContain('my-task-42');
  });

  it('shows blocked status label for needs_clarification', () => {
    const task = makeTask({ status: 'needs_clarification' });
    const line = renderTaskLine(task, null);
    expect(line).toContain('blocked');
  });
});
