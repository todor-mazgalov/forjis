/**
 * decision-pill-state — Pure helpers for {@link DecisionPill}.
 *
 * Extracted from `DecisionPill.tsx` so the three-state enum, label rule,
 * and state-list constant can be covered by unit tests that run under
 * plain ts-jest without the Vite / JSX / CSS-module toolchain the component
 * module requires.
 */

/** Supported decision states surfaced by the orchestrator. */
export type DecisionPillState = 'started' | 'skipped' | 'pending';

/**
 * Authoritative list of decision states. Exported so tests can verify the
 * set is exhaustive (no drift between this module and the pill's CSS map).
 */
export const DECISION_PILL_STATES: readonly DecisionPillState[] = [
  'started',
  'skipped',
  'pending',
];

/**
 * Compute the visible pill label for a decision state. Pure; trivial
 * upper-casing rule, isolated so the component JSX reads as a single
 * expression and tests can assert the rule in one place.
 */
export function decisionLabel(state: DecisionPillState): string {
  return state.toUpperCase();
}
