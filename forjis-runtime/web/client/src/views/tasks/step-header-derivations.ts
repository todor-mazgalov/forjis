/**
 * step-header-derivations — Pure derivation helpers for the DetailPane
 * StepHeader regions (title-row decision, stats-strip counters).
 *
 * Split out of `DetailPane.tsx` so the rules are unit-testable under plain
 * ts-jest without the Vite / JSX / CSS-module toolchain the component
 * module requires. Every export is a pure function — no Solid reactivity,
 * no DOM, no I/O. The StepHeader wraps each of these in a `createMemo` so
 * Solid's granular reactivity drives the updates.
 *
 * Requirements covered:
 *   redesign-017 — "Stats strip renders five stats for role steps",
 *   "Skipped-state fallback collapses counters to em-dash",
 *   "Orchestrator header variant shows a reduced strip",
 *   fix-roles-display — token-usage lookup uses the bare `step.role` (the
 *   structured identity's role field), manifest files match on bare role.
 */

import type {
  ManifestResponse,
  PipelineStep,
  TaskEvent,
  TokenUsageResponse,
} from '@forjis/shared';
import { ELAPSED_FALLBACK } from './time.js';

/** Shape of a single bucketed event classification; matches `EventsTab`'s. */
export type EventBucket = 'tool-call' | 'tool-result' | 'one-line' | 'error';

/**
 * Derive the decision-pill state from a pipeline step. Mirrors the orchestrator
 * semantics: any step that has started running (or has finished) counts as
 * `started`; any step explicitly skipped (by status or by decision) collapses
 * to `skipped`; everything else is `pending`.
 *
 * Callers decide whether to render the pill at all — this function always
 * returns a state so the `kind === 'orchestrator'` suppression lives at the
 * call site (see design § D-6 / R-004).
 */
export function deriveDecision(
  step: PipelineStep,
): 'started' | 'skipped' | 'pending' {
  if (step.status === 'running' || step.status === 'done') return 'started';
  if (step.status === 'skipped' || step.decision === 'skipped') return 'skipped';
  return 'pending';
}

/**
 * True when the step should collapse counter stats (Tokens / Tool calls /
 * Files touched) to {@link ELAPSED_FALLBACK}. Matches the dual-source rule
 * used by `RoleCard`: either `status === 'skipped'` or `decision === 'skipped'`.
 */
export function isSkipped(step: PipelineStep): boolean {
  return step.status === 'skipped' || step.decision === 'skipped';
}

/**
 * Look up the total tokens attributed to a single step in a token-usage
 * response. Returns {@link ELAPSED_FALLBACK} when any link in the chain is
 * missing (no `perTask` map, no entry for this task, no `perRole` map, no
 * entry matching the step).
 *
 * Orchestrator steps use the literal key `'orchestrator'`. Role steps try
 * the bare `step.role` first (the structured identity — no composite string
 * left in the codebase), then fall back to the Claude-engine agent slug
 * `forjis-<lowercased-role>` which historic runs may still record under.
 */
export function tokensForStep(
  step: PipelineStep,
  taskId: string,
  usage: TokenUsageResponse | null,
): string {
  if (usage === null) return ELAPSED_FALLBACK;
  const perTask = usage.perTask?.[taskId];
  const perRole = perTask?.perRole;
  if (perRole === undefined) return ELAPSED_FALLBACK;
  const isOrchestratorStep = step.kind === 'orchestrator';
  const primaryKey = isOrchestratorStep ? 'orchestrator' : step.role;
  const primary = perRole[primaryKey];
  if (primary !== undefined) return String(primary.totalTokens);
  if (!isOrchestratorStep) {
    // Engine-layer slug fallback — the Claude engine records per-role tokens
    // under the agent slug (`forjis-<role-lowercase>`). Try it before giving up.
    const slugKey = `forjis-${step.role.toLowerCase()}`;
    const slug = perRole[slugKey];
    if (slug !== undefined) return String(slug.totalTokens);
  }
  return ELAPSED_FALLBACK;
}

/**
 * Count the tool-call events inside an event list. The caller passes its
 * own `classify` so the module avoids a circular import with `EventsTab`.
 *
 * For a role step, the event list passed in is already filtered by the
 * SSE subscription to the selected step identity, so no additional role
 * filter is needed here — we just count classified tool-calls.
 */
export function countToolCalls(
  events: readonly TaskEvent[],
  classify: (event: TaskEvent) => EventBucket,
): number {
  let count = 0;
  for (const event of events) {
    if (classify(event) === 'tool-call') count += 1;
  }
  return count;
}

/**
 * Count manifest entries whose `role` matches the bare role name from the
 * selected step's structured identity. The manifest's `role` field is
 * written as the bare role (not a composite string) so an exact-equality
 * match is correct — no trailing-segment fuzz needed.
 *
 * Returns 0 when the manifest has not loaded yet.
 */
export function countFilesTouched(
  manifest: ManifestResponse | null,
  role: string,
): number {
  if (manifest === null) return 0;
  let count = 0;
  for (const file of manifest.files) {
    if (file.role === role) count += 1;
  }
  return count;
}

/**
 * Format the score cell. Numbers stringify; `undefined` collapses to the
 * shared em-dash so the stats strip never renders the literal word `NaN`.
 */
export function displayScoreOf(step: PipelineStep): string {
  return typeof step.score === 'number' ? String(step.score) : ELAPSED_FALLBACK;
}
