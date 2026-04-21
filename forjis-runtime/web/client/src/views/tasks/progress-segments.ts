/**
 * progress-segments — Pure helpers for the TaskCard progress chain.
 *
 * Extracted from `TaskCard.tsx` so the `buildProgressSegments` derivation is
 * unit-testable under plain ts-jest without the Vite / JSX / CSS-module /
 * SolidJS toolchain the component module requires. Every export is a pure
 * function — no Solid reactivity, no DOM, no I/O.
 *
 * Requirements covered (redesign-021 §15, fix-roles-display):
 *   - Fixed-width segments with per-status colours.
 *   - Skipped-era inheritance: past era uses `--progress-done` at 0.25,
 *     future era uses `--progress-planned` at 0.25.
 *   - Four edge cases: all done, running present, no running + planned remain,
 *     first segment skipped with no running.
 *   - `title` attribute payload is built via `formatRoleDisplay` so tooltips
 *     match every other surface's `<role> @ <team>` rendering; historical
 *     progress records without `team` gracefully fall back to the bare role.
 */

import { formatRoleDisplay } from '@forjis/shared';

/**
 * A single step entry in the `progress.steps` array (redesign-021 §15 +
 * `fix-roles-display` contract). The backend populates these fields; the
 * frontend reads them defensively (team is optional so legacy records still
 * render cleanly).
 */
export interface ProgressStep {
  /** Bare role name of the step. */
  role: string;
  /** Team name the role belongs to. Optional: legacy records predating
   *  `fix-roles-display` do not carry it and fall back to bare-role display. */
  team?: string;
  /** Current status of the step in the pipeline. */
  status: 'done' | 'running' | 'planned' | 'skipped';
}

/** CSS module class key driving the colour and animation of one segment. */
export type SegmentClass =
  | 'segmentDone'
  | 'segmentRunning'
  | 'segmentPlanned'
  | 'segmentSkippedPast'
  | 'segmentSkippedFuture';

/** Metadata for a single rendered progress segment. */
export interface ProgressSegment {
  /** CSS module class key driving the segment colour. */
  cls: SegmentClass;
  /**
   * Role label for the accessible title attribute. When the underlying step
   * carries a `team`, this is the `formatRoleDisplay` output (e.g.
   * `"Architect @ Frontend"`); otherwise it's just the bare role name.
   */
  role: string;
  /** Status label for the accessible title attribute. */
  status: string;
}

/**
 * Render the accessible title text for one segment. Uses `formatRoleDisplay`
 * when `team` is a non-empty string so the tooltip matches every other
 * `<role> @ <team>` surface; falls back to the bare role when team is
 * absent (historical records).
 */
export function progressSegmentTitle(step: ProgressStep): string {
  if (typeof step.team === 'string' && step.team.length > 0) {
    return formatRoleDisplay({ role: step.role, team: step.team });
  }
  return step.role;
}

/**
 * Derive the CSS class key for each step in the pipeline, implementing the
 * skipped-era inheritance rule from TASK.md §15:
 *
 * - `done`     → `segmentDone`
 * - `running`  → `segmentRunning`
 * - `planned`  → `segmentPlanned`
 * - `skipped` with `index < runningIndex` → `segmentSkippedPast`
 *   (borrows `--progress-done` at 0.25 — belongs to the already-completed era).
 * - `skipped` with `index >= runningIndex` → `segmentSkippedFuture`
 *   (borrows `--progress-planned` at 0.25 — belongs to the upcoming era).
 * - When no running segment exists and planned steps remain → future era.
 * - When no running segment and no planned steps remain → past era.
 *
 * Pure function — no side effects, no DOM access. Named and exported so it
 * can be unit-tested directly without the SolidJS toolchain.
 *
 * @param steps - Ordered step list from `progress.steps`.
 */
export function buildProgressSegments(steps: readonly ProgressStep[]): ProgressSegment[] {
  const runningIndex = steps.findIndex((step) => step.status === 'running');
  return steps.map((step, index): ProgressSegment => {
    let cls: SegmentClass;
    switch (step.status) {
      case 'done':
        cls = 'segmentDone';
        break;
      case 'running':
        cls = 'segmentRunning';
        break;
      case 'planned':
        cls = 'segmentPlanned';
        break;
      case 'skipped': {
        if (runningIndex >= 0) {
          // Running segment exists — split on its position.
          cls = index < runningIndex ? 'segmentSkippedPast' : 'segmentSkippedFuture';
        } else {
          // No running segment — decide by whether any planned steps exist.
          const hasPlannedAhead = steps.some((s) => s.status === 'planned');
          cls = hasPlannedAhead ? 'segmentSkippedFuture' : 'segmentSkippedPast';
        }
        break;
      }
    }
    return { cls, role: progressSegmentTitle(step), status: step.status };
  });
}
