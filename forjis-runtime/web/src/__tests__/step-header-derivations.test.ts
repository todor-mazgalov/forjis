/**
 * Unit tests for the pure derivation helpers backing the redesign-017
 * DetailPane StepHeader stats strip.
 *
 * Module under test:
 *   `forjis-runtime/web/client/src/views/tasks/step-header-derivations.ts`
 *
 * The helpers are pure TypeScript (no Solid / no DOM / no I/O) so they run
 * cleanly under ts-jest. Covers:
 *   - `deriveDecision` — maps step status + decision to the pill state.
 *   - `isSkipped` — combined status/decision skip predicate.
 *   - `tokensForStep` — per-role token lookup using the bare role key
 *     (fix-roles-display) with an engine-slug fallback.
 *   - `countToolCalls` — classified count of tool-call events.
 *   - `countFilesTouched` — manifest file count filtered by structured-equal role.
 *   - `displayScoreOf` — score stringify with em-dash fallback.
 *
 * Requirements covered (redesign-017 + fix-roles-display):
 *   - "Stats strip renders five stats for role steps"
 *   - "Skipped-state fallback collapses counters to em-dash"
 *   - "Orchestrator header variant shows a reduced strip" (tokens key rule)
 *   - Structured role identity on every fixture.
 */

import type {
  ManifestResponse,
  PipelineStep,
  TaskEvent,
  TokenUsageResponse,
} from '../../../shared/src/types.js';
import {
  countFilesTouched,
  countToolCalls,
  deriveDecision,
  displayScoreOf,
  isSkipped,
  tokensForStep,
  type EventBucket,
} from '../../client/src/views/tasks/step-header-derivations.js';
import { ELAPSED_FALLBACK } from '../../client/src/views/tasks/time.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    org: 'software-dev',
    team: 'core',
    role: 'Architect',
    agent: 'architect-agent',
    status: 'planned',
    description: 'design the system',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    timestamp: '2026-04-20T00:00:00.000Z',
    type: 'assistant',
    role: 'Architect',
    content: 'hello',
    ...overrides,
  };
}

/** Classifier that replicates the EventsTab rule without importing the
 *  component module (which pulls CSS). Matches the shape required by
 *  {@link countToolCalls}. */
function classifyFixture(event: TaskEvent): EventBucket {
  if (event.type === 'error') return 'error';
  if (
    event.toolName !== undefined &&
    event.parentId !== undefined &&
    event.type === 'user'
  ) {
    return 'tool-result';
  }
  if (event.toolName !== undefined && event.payload !== undefined) {
    return 'tool-call';
  }
  return 'one-line';
}

// ---------------------------------------------------------------------------
// deriveDecision
// ---------------------------------------------------------------------------

describe('deriveDecision', () => {
  test('returns `started` for a running step', () => {
    expect(deriveDecision(makeStep({ status: 'running' }))).toBe('started');
  });

  test('returns `started` for a done step', () => {
    expect(deriveDecision(makeStep({ status: 'done' }))).toBe('started');
  });

  test('returns `skipped` for a skipped-by-status step', () => {
    expect(deriveDecision(makeStep({ status: 'skipped' }))).toBe('skipped');
  });

  test('returns `started` for a done-but-decision-skipped step (running/done wins)', () => {
    expect(deriveDecision(makeStep({ status: 'done', decision: 'skipped' })))
      .toBe('started');
  });

  test('returns `skipped` for a planned step whose decision is skipped', () => {
    expect(deriveDecision(makeStep({ status: 'planned', decision: 'skipped' })))
      .toBe('skipped');
  });

  test('returns `pending` for a planned step with no decision set', () => {
    expect(deriveDecision(makeStep({ status: 'planned' }))).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// isSkipped
// ---------------------------------------------------------------------------

describe('isSkipped', () => {
  test('returns true when status is `skipped`', () => {
    expect(isSkipped(makeStep({ status: 'skipped' }))).toBe(true);
  });

  test('returns true when decision is `skipped` on a non-skipped status', () => {
    expect(isSkipped(makeStep({ status: 'done', decision: 'skipped' }))).toBe(true);
  });

  test('returns false when neither flag is set to skipped', () => {
    expect(isSkipped(makeStep({ status: 'running', decision: 'started' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tokensForStep
// ---------------------------------------------------------------------------

function makeUsage(perRole: Record<string, { totalTokens: number }>): TokenUsageResponse {
  const entries: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> = {};
  for (const key of Object.keys(perRole)) {
    const row = perRole[key];
    if (row === undefined) continue;
    entries[key] = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: row.totalTokens,
    };
  }
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    windowStartedAt: '2026-04-20T00:00:00.000Z',
    lastUpdatedAt: '2026-04-20T00:00:01.000Z',
    budget: null,
    perTask: {
      'task-1': {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        perRole: entries,
      },
    },
  };
}

describe('tokensForStep', () => {
  test('returns the em-dash when usage is null', () => {
    expect(tokensForStep(makeStep(), 'task-1', null)).toBe(ELAPSED_FALLBACK);
  });

  test('returns the em-dash when `perTask` is missing the selected task', () => {
    const usage = makeUsage({ Architect: { totalTokens: 500 } });
    expect(tokensForStep(makeStep(), 'task-OTHER', usage)).toBe(ELAPSED_FALLBACK);
  });

  test('returns the em-dash when `perRole` has neither the bare role nor the slug key', () => {
    const usage = makeUsage({ Tester: { totalTokens: 42 } });
    expect(tokensForStep(makeStep(), 'task-1', usage)).toBe(ELAPSED_FALLBACK);
  });

  test('resolves the value via the bare role name (step.role)', () => {
    const usage = makeUsage({ Architect: { totalTokens: 1450 } });
    expect(tokensForStep(makeStep(), 'task-1', usage)).toBe('1450');
  });

  test('falls back to the engine agent slug when the bare role misses', () => {
    const usage = makeUsage({ 'forjis-architect': { totalTokens: 900 } });
    expect(tokensForStep(makeStep(), 'task-1', usage)).toBe('900');
  });

  test('uses the literal `orchestrator` key for the orchestrator pseudo-step', () => {
    const usage = makeUsage({ orchestrator: { totalTokens: 920 } });
    expect(tokensForStep(
      makeStep({ org: '', team: '', role: 'orchestrator', kind: 'orchestrator' }),
      'task-1',
      usage,
    )).toBe('920');
  });

  test('does not fall back to a slug key for the orchestrator variant', () => {
    const usage = makeUsage({ 'forjis-orchestrator': { totalTokens: 99 } });
    expect(tokensForStep(
      makeStep({ org: '', team: '', role: 'orchestrator', kind: 'orchestrator' }),
      'task-1',
      usage,
    )).toBe(ELAPSED_FALLBACK);
  });
});

// ---------------------------------------------------------------------------
// countToolCalls
// ---------------------------------------------------------------------------

describe('countToolCalls', () => {
  test('counts only events that classify as `tool-call`', () => {
    const events: TaskEvent[] = [
      makeEvent({ type: 'assistant', content: 'one-liner' }),
      makeEvent({ type: 'assistant', toolName: 'Read', payload: { path: '/a' } }),
      makeEvent({ type: 'user', toolName: 'Read', parentId: 'x' }),
      makeEvent({ type: 'error', content: 'boom' }),
      makeEvent({ type: 'assistant', toolName: 'Write', payload: { path: '/b' } }),
    ];
    expect(countToolCalls(events, classifyFixture)).toBe(2);
  });

  test('returns 0 for an empty list', () => {
    expect(countToolCalls([], classifyFixture)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// countFilesTouched
// ---------------------------------------------------------------------------

function makeManifest(files: Array<{ role: string; path: string }>): ManifestResponse {
  return {
    files: files.map((file) => ({
      role: file.role,
      path: file.path,
      label: file.path,
    })),
  };
}

describe('countFilesTouched', () => {
  test('returns 0 when the manifest is null', () => {
    expect(countFilesTouched(null, 'Architect')).toBe(0);
  });

  test('counts entries whose role matches the bare role name exactly', () => {
    const manifest = makeManifest([
      { role: 'Architect', path: 'a.md' },
      { role: 'Architect', path: 'b.md' },
      { role: 'Tester', path: 'c.md' },
    ]);
    expect(countFilesTouched(manifest, 'Architect')).toBe(2);
  });

  test('does NOT match scoped/composite role strings (fix-roles-display strictness)', () => {
    const manifest = makeManifest([
      { role: 'software-dev:core:Architect', path: 'a.md' },
      { role: 'Architect', path: 'b.md' },
      { role: 'Tester', path: 'c.md' },
    ]);
    expect(countFilesTouched(manifest, 'Architect')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// displayScoreOf
// ---------------------------------------------------------------------------

describe('displayScoreOf', () => {
  test('stringifies a numeric score', () => {
    expect(displayScoreOf(makeStep({ score: 72 }))).toBe('72');
  });

  test('returns the em-dash fallback when score is undefined', () => {
    expect(displayScoreOf(makeStep())).toBe(ELAPSED_FALLBACK);
  });

  test('stringifies a zero score (does NOT fall back to em-dash)', () => {
    expect(displayScoreOf(makeStep({ score: 0 }))).toBe('0');
  });
});
