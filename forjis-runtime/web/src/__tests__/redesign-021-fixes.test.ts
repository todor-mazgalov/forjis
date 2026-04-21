/**
 * Unit tests for redesign-021-fixes frontend changes, updated for
 * fix-roles-display structural identity (PipelineStep now carries
 * `{org, team, role}` and the client uses the triple for selection and
 * equality rather than composite strings).
 *
 * Covers:
 *   - `formatPriorityLabel` — single-letter output for High/Medium/Low.
 *   - `tokensForStep` — bare-role key + forjis-<role> engine-slug fallback.
 *   - `isOpenSpecEntry` (FilesTouchedTab) — openspec filter predicate.
 *   - `openSpecManifestPaths` (OpenSpecTab) — manifest path extraction.
 *   - `buildOpenSpecUnion` (OpenSpecTab) — union of task-dir + manifest entries.
 *   - `pickAutoSelectStep` (DetailPane) — returns structured identity triple.
 *   - `computeVisibleFilesCount` (DetailPane) — files badge count derivation.
 *   - `computeVisibleOpenSpecCount` (DetailPane) — openspec badge count derivation.
 *   - `buildProgressSegments` — four edge-case skipped era inheritance rules.
 *
 * All helpers are pure TypeScript (no Solid / DOM / fetch) — safe under
 * ts-jest without the Vite / JSX / CSS-module toolchain.
 */

import type {
  ManifestFileEntry,
  ManifestResponse,
  PipelinePlanResponse,
  PipelineStep,
  RoleIdentity,
  TokenUsageResponse,
} from '../../../shared/src/types.js';
import {
  tokensForStep,
} from '../../client/src/views/tasks/step-header-derivations.js';
import { ELAPSED_FALLBACK } from '../../client/src/views/tasks/time.js';
import {
  buildProgressSegments,
  type ProgressStep,
} from '../../client/src/views/tasks/progress-segments.js';
import { isOpenSpecEntry } from '../../client/src/views/tasks/openspec-filter.js';
import {
  openSpecManifestPaths,
  buildOpenSpecUnion,
} from '../../client/src/views/tasks/openspec-tab-utils.js';
import {
  pickAutoSelectStep,
  computeVisibleFilesCount,
  computeVisibleOpenSpecCount,
} from '../../client/src/views/tasks/detail-pane-utils.js';
import { formatPriorityLabel } from '../../client/src/views/tasks/task-card-format.js';

// ---------------------------------------------------------------------------
// formatPriorityLabel — imported from the real source (redesign-021 §11)
// ---------------------------------------------------------------------------

describe('formatPriorityLabel (redesign-021 §11)', () => {
  test('numeric priority renders as P<n>', () => {
    expect(formatPriorityLabel(1)).toBe('P1');
    expect(formatPriorityLabel(42)).toBe('P42');
  });

  test('High (any case) renders as H', () => {
    expect(formatPriorityLabel('High')).toBe('H');
    expect(formatPriorityLabel('high')).toBe('H');
    expect(formatPriorityLabel('HIGH')).toBe('H');
    expect(formatPriorityLabel('  High  ')).toBe('H');
  });

  test('Medium (any case) renders as M', () => {
    expect(formatPriorityLabel('Medium')).toBe('M');
    expect(formatPriorityLabel('medium')).toBe('M');
    expect(formatPriorityLabel('MEDIUM')).toBe('M');
  });

  test('Low (any case) renders as L', () => {
    expect(formatPriorityLabel('Low')).toBe('L');
    expect(formatPriorityLabel('low')).toBe('L');
    expect(formatPriorityLabel('LOW')).toBe('L');
  });

  test('unknown string falls back to first uppercased character', () => {
    expect(formatPriorityLabel('critical')).toBe('C');
    expect(formatPriorityLabel('p1')).toBe('P');
  });
});

// ---------------------------------------------------------------------------
// tokensForStep — forjis-slug fallback (fix-roles-display: bare role is primary)
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    org: 'software-dev',
    team: 'core',
    role: 'Developer',
    agent: 'forjis-developer',
    status: 'planned',
    description: 'build it',
    ...overrides,
  };
}

function makeUsage(
  perRole: Record<string, { totalTokens: number }>,
): TokenUsageResponse {
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

describe('tokensForStep forjis-slug fallback (fix-roles-display)', () => {
  test('hits via the forjis-<role-lowercase> slug when bare role misses', () => {
    const usage = makeUsage({ 'forjis-developer': { totalTokens: 7777 } });
    expect(tokensForStep(makeStep(), 'task-1', usage)).toBe('7777');
  });

  test('returns em-dash when neither bare role nor slug match', () => {
    const usage = makeUsage({ 'some-other-key': { totalTokens: 100 } });
    expect(tokensForStep(makeStep(), 'task-1', usage)).toBe(ELAPSED_FALLBACK);
  });

  test('bare role key wins over slug when both are present', () => {
    const usage = makeUsage({
      Developer: { totalTokens: 500 },
      'forjis-developer': { totalTokens: 7777 },
    });
    expect(tokensForStep(makeStep(), 'task-1', usage)).toBe('500');
  });

  test('orchestrator step does NOT use the slug fallback', () => {
    const usage = makeUsage({ 'forjis-orchestrator': { totalTokens: 9999 } });
    expect(tokensForStep(
      makeStep({ org: '', team: '', role: 'orchestrator', kind: 'orchestrator' }),
      'task-1',
      usage,
    )).toBe(ELAPSED_FALLBACK);
  });
});

// ---------------------------------------------------------------------------
// isOpenSpecEntry (FilesTouchedTab) — openspec filter predicate (redesign-021 §8/9)
// ---------------------------------------------------------------------------

describe('isOpenSpecEntry (redesign-021 §8/9)', () => {
  test('returns true for a path under openspec/changes/<taskId>/', () => {
    expect(isOpenSpecEntry('openspec/changes/my-task/design.md', 'my-task')).toBe(true);
  });

  test('returns true for a nested path', () => {
    expect(isOpenSpecEntry('openspec/changes/my-task/roles/frontend/qa.md', 'my-task')).toBe(true);
  });

  test('returns false for a different task id', () => {
    expect(isOpenSpecEntry('openspec/changes/other-task/design.md', 'my-task')).toBe(false);
  });

  test('returns false for an arbitrary project file', () => {
    expect(isOpenSpecEntry('forjis-runtime/web/client/src/App.tsx', 'my-task')).toBe(false);
  });

  test('returns false for the openspec dir root (no taskId segment)', () => {
    expect(isOpenSpecEntry('openspec/design.md', 'my-task')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openSpecManifestPaths — OpenSpecTab union logic (redesign-021 §8)
// ---------------------------------------------------------------------------

function makeManifest(paths: Array<{ path: string; role?: string }>): ManifestResponse {
  return {
    files: paths.map(({ path, role = 'some-role' }): ManifestFileEntry => ({
      path,
      role,
      label: path.split('/').pop() ?? path,
    })),
  };
}

describe('openSpecManifestPaths (redesign-021 §8)', () => {
  test('empty manifest returns empty array', () => {
    expect(openSpecManifestPaths(makeManifest([]), 'my-task')).toEqual([]);
  });

  test('null manifest returns empty array', () => {
    expect(openSpecManifestPaths(null, 'my-task')).toEqual([]);
  });

  test('paths matching the openspec/<taskId>/ prefix are returned', () => {
    const manifest = makeManifest([
      { path: 'openspec/changes/my-task/design.md' },
      { path: 'openspec/changes/my-task/roles/frontend/qa.md' },
    ]);
    expect(openSpecManifestPaths(manifest, 'my-task')).toEqual([
      'openspec/changes/my-task/design.md',
      'openspec/changes/my-task/roles/frontend/qa.md',
    ]);
  });

  test('paths from other tasks are excluded', () => {
    const manifest = makeManifest([
      { path: 'openspec/changes/other-task/design.md' },
      { path: 'openspec/changes/my-task/design.md' },
    ]);
    expect(openSpecManifestPaths(manifest, 'my-task')).toEqual([
      'openspec/changes/my-task/design.md',
    ]);
  });

  test('non-openspec project files are excluded', () => {
    const manifest = makeManifest([
      { path: 'forjis-runtime/web/client/src/App.tsx' },
      { path: 'openspec/changes/my-task/tasks.md' },
    ]);
    expect(openSpecManifestPaths(manifest, 'my-task')).toEqual([
      'openspec/changes/my-task/tasks.md',
    ]);
  });
});

describe('buildOpenSpecUnion (redesign-021 §8)', () => {
  test('merges task-dir files and manifest openspec entries', () => {
    const manifest = makeManifest([
      { path: 'openspec/changes/my-task/design.md' },
      { path: 'forjis-runtime/web/client/src/App.tsx' },
    ]);
    const union = buildOpenSpecUnion(
      ['TASK.md', 'notes.md'],
      manifest,
      'my-task',
    );
    expect(union).toEqual([
      { path: 'TASK.md', source: 'task' },
      { path: 'notes.md', source: 'task' },
      { path: 'openspec/changes/my-task/design.md', source: 'project' },
    ]);
  });

  test('null taskFiles treated as empty', () => {
    const manifest = makeManifest([
      { path: 'openspec/changes/my-task/design.md' },
    ]);
    const union = buildOpenSpecUnion(null, manifest, 'my-task');
    expect(union).toEqual([
      { path: 'openspec/changes/my-task/design.md', source: 'project' },
    ]);
  });

  test('null manifest produces only task entries', () => {
    const union = buildOpenSpecUnion(['TASK.md'], null, 'my-task');
    expect(union).toEqual([{ path: 'TASK.md', source: 'task' }]);
  });
});

// ---------------------------------------------------------------------------
// pickAutoSelectStep — returns RoleIdentity (fix-roles-display)
// ---------------------------------------------------------------------------

function makePlan(
  steps: Array<{ role: string; status: PipelineStep['status']; team?: string }>,
): PipelinePlanResponse {
  return {
    taskId: 't',
    orgName: 'software-dev',
    teamName: 'core',
    steps: steps.map(({ role, status, team }) => ({
      org: 'software-dev',
      team: team ?? 'core',
      role,
      agent: `forjis-${role.toLowerCase()}`,
      status,
      description: role,
    })),
  };
}

describe('pickAutoSelectStep (redesign-021 §6, fix-roles-display)', () => {
  test('running step → returns its identity triple', () => {
    const plan = makePlan([
      { role: 'developer', status: 'done' },
      { role: 'reviewer', status: 'running' },
      { role: 'qa', status: 'planned' },
    ]);
    expect(pickAutoSelectStep(plan)).toEqual({
      org: 'software-dev',
      team: 'core',
      role: 'reviewer',
    });
  });

  test('no running but non-done → first non-done identity', () => {
    const plan = makePlan([
      { role: 'developer', status: 'done' },
      { role: 'reviewer', status: 'planned' },
      { role: 'qa', status: 'planned' },
    ]);
    expect(pickAutoSelectStep(plan)).toEqual({
      org: 'software-dev',
      team: 'core',
      role: 'reviewer',
    });
  });

  test('all done → null', () => {
    const plan = makePlan([
      { role: 'developer', status: 'done' },
      { role: 'reviewer', status: 'done' },
    ]);
    expect(pickAutoSelectStep(plan)).toBeNull();
  });

  test('empty plan → null', () => {
    expect(pickAutoSelectStep(makePlan([]))).toBeNull();
  });

  test('skipped steps are not selected as auto-select target', () => {
    const plan = makePlan([
      { role: 'developer', status: 'done' },
      { role: 'designer', status: 'skipped' },
      { role: 'qa', status: 'planned' },
    ]);
    expect(pickAutoSelectStep(plan)).toEqual({
      org: 'software-dev',
      team: 'core',
      role: 'qa',
    });
  });
});

// ---------------------------------------------------------------------------
// computeVisibleFilesCount — Files-touched badge count (redesign-021 §13)
// ---------------------------------------------------------------------------

function identity(role: string, team = 'core', org = 'software-dev'): RoleIdentity {
  return { org, team, role };
}

describe('computeVisibleFilesCount (redesign-021 §13, fix-roles-display)', () => {
  test('null manifest → 0', () => {
    expect(computeVisibleFilesCount(null, 'my-task', null)).toBe(0);
  });

  test('null taskId → 0', () => {
    const manifest = makeManifest([{ path: 'src/App.tsx', role: 'developer' }]);
    expect(computeVisibleFilesCount(manifest, null, null)).toBe(0);
  });

  test('no step filter → full non-openspec file count', () => {
    const manifest = makeManifest([
      { path: 'src/App.tsx', role: 'developer' },
      { path: 'src/main.tsx', role: 'developer' },
    ]);
    expect(computeVisibleFilesCount(manifest, 'my-task', null)).toBe(2);
  });

  test('openspec entries stripped from files count', () => {
    const manifest = makeManifest([
      { path: 'src/App.tsx', role: 'developer' },
      { path: 'openspec/changes/my-task/design.md', role: 'developer' },
    ]);
    expect(computeVisibleFilesCount(manifest, 'my-task', null)).toBe(1);
  });

  test('step filter matches on bare role equality', () => {
    const manifest = makeManifest([
      { path: 'src/App.tsx', role: 'Developer' },
      { path: 'src/review.md', role: 'Reviewer' },
    ]);
    expect(
      computeVisibleFilesCount(manifest, 'my-task', identity('Developer')),
    ).toBe(1);
  });

  test('manifest entries with composite role strings do NOT match (fix-roles-display strictness)', () => {
    const manifest = makeManifest([
      { path: 'src/App.tsx', role: 'software-dev:core:Developer' },
      { path: 'src/other.tsx', role: 'Developer' },
    ]);
    // Only the bare-role manifest entry matches the structured identity.
    expect(
      computeVisibleFilesCount(manifest, 'my-task', identity('Developer')),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeVisibleOpenSpecCount — OpenSpec badge count (redesign-021 §13)
// ---------------------------------------------------------------------------

describe('computeVisibleOpenSpecCount (redesign-021 §13)', () => {
  test('null taskId → 0', () => {
    expect(computeVisibleOpenSpecCount(null, null, null)).toBe(0);
  });

  test('null manifest and null taskFiles → 0', () => {
    expect(computeVisibleOpenSpecCount(null, null, 'my-task')).toBe(0);
  });

  test('no openspec-prefix entry in manifest → task file count only', () => {
    const manifest = makeManifest([
      { path: 'src/App.tsx', role: 'developer' },
    ]);
    expect(computeVisibleOpenSpecCount(manifest, ['TASK.md', 'notes.md'], 'my-task')).toBe(2);
  });

  test('manifest openspec entries added to task file count', () => {
    const manifest = makeManifest([
      { path: 'src/App.tsx', role: 'developer' },
      { path: 'openspec/changes/my-task/design.md', role: 'developer' },
    ]);
    expect(computeVisibleOpenSpecCount(manifest, ['TASK.md'], 'my-task')).toBe(2);
  });

  test('other-task openspec entries are not counted', () => {
    const manifest = makeManifest([
      { path: 'openspec/changes/other-task/design.md', role: 'developer' },
      { path: 'openspec/changes/my-task/tasks.md', role: 'developer' },
    ]);
    expect(computeVisibleOpenSpecCount(manifest, [], 'my-task')).toBe(1);
  });

  test('null taskFiles treated as empty', () => {
    const manifest = makeManifest([
      { path: 'openspec/changes/my-task/design.md', role: 'developer' },
    ]);
    expect(computeVisibleOpenSpecCount(manifest, null, 'my-task')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildProgressSegments — skipped era inheritance edge cases (redesign-021 §15)
// ---------------------------------------------------------------------------

function step(status: ProgressStep['status'], role = 'r', team?: string): ProgressStep {
  if (team === undefined) return { role, status };
  return { role, status, team };
}

describe('buildProgressSegments (redesign-021 §15)', () => {
  test('all done — trailing skipped uses past era (done at 0.25)', () => {
    const steps: ProgressStep[] = [
      step('done', 'A'),
      step('done', 'B'),
      step('skipped', 'C'),
    ];
    const segs = buildProgressSegments(steps);
    expect(segs[0].cls).toBe('segmentDone');
    expect(segs[1].cls).toBe('segmentDone');
    expect(segs[2].cls).toBe('segmentSkippedPast');
  });

  test('running exists — skipped before running uses past era', () => {
    const steps: ProgressStep[] = [
      step('skipped', 'A'),
      step('running', 'B'),
      step('planned', 'C'),
    ];
    const segs = buildProgressSegments(steps);
    expect(segs[0].cls).toBe('segmentSkippedPast');
    expect(segs[1].cls).toBe('segmentRunning');
    expect(segs[2].cls).toBe('segmentPlanned');
  });

  test('running exists — skipped after running uses future era', () => {
    const steps: ProgressStep[] = [
      step('done', 'A'),
      step('running', 'B'),
      step('skipped', 'C'),
      step('planned', 'D'),
    ];
    const segs = buildProgressSegments(steps);
    expect(segs[0].cls).toBe('segmentDone');
    expect(segs[1].cls).toBe('segmentRunning');
    expect(segs[2].cls).toBe('segmentSkippedFuture');
    expect(segs[3].cls).toBe('segmentPlanned');
  });

  test('no running segment and all remaining are planned — skipped uses future era', () => {
    const steps: ProgressStep[] = [
      step('done', 'A'),
      step('skipped', 'B'),
      step('planned', 'C'),
    ];
    const segs = buildProgressSegments(steps);
    expect(segs[0].cls).toBe('segmentDone');
    expect(segs[1].cls).toBe('segmentSkippedFuture');
    expect(segs[2].cls).toBe('segmentPlanned');
  });

  test('first segment is skipped with no running yet — future era', () => {
    const steps: ProgressStep[] = [
      step('skipped', 'A'),
      step('planned', 'B'),
    ];
    const segs = buildProgressSegments(steps);
    expect(segs[0].cls).toBe('segmentSkippedFuture');
    expect(segs[1].cls).toBe('segmentPlanned');
  });

  test('segment titles use bare role when team is absent', () => {
    const steps: ProgressStep[] = [step('done', 'Architect')];
    const segs = buildProgressSegments(steps);
    expect(segs[0].role).toBe('Architect');
    expect(segs[0].status).toBe('done');
  });

  test('segment titles render `<role> @ <team>` when team is present (fix-roles-display)', () => {
    const steps: ProgressStep[] = [step('running', 'Architect', 'Frontend')];
    const segs = buildProgressSegments(steps);
    expect(segs[0].role).toBe('Architect @ Frontend');
    expect(segs[0].status).toBe('running');
  });
});
