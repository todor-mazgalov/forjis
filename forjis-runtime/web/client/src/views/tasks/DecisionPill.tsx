/**
 * DecisionPill — tiny decision-state pill for the DetailPane title row.
 *
 * Encodes the orchestrator's per-role decision as one of three states
 * (`started | skipped | pending`), each mapped to a dedicated CSS-module
 * class. Distinct from the shared `Pill` primitive whose state enum tracks
 * pipeline-step *status*; the visual rules diverge on size, padding, and
 * letter-spacing, and the dotted-border `pending` variant has no peer in
 * `Pill`'s state set. Follows the `KindPill` precedent (see
 * `views/config/KindPill.tsx`) of co-locating a domain-specific pill next
 * to its only caller.
 *
 * Pure-logic helpers live in {@link ./decision-pill-state} so they can be
 * unit tested without a CSS-module / JSX toolchain in the test runner.
 */

import type { Component } from 'solid-js';
import {
  decisionLabel,
  type DecisionPillState,
} from './decision-pill-state';
import styles from './DecisionPill.module.css';

export type { DecisionPillState };
export { decisionLabel };

/** Props for {@link DecisionPill}. */
export interface DecisionPillProps {
  /** Drives both the CSS variant class and the visible uppercase label. */
  state: DecisionPillState;
}

/**
 * Map each decision state to its CSS-module variant class. Declarative rather
 * than a template-string lookup so the full variant set is audit-able at a
 * glance and `noUncheckedIndexedAccess` cannot produce an `undefined` class.
 */
const STATE_CLASS: Record<DecisionPillState, string> = {
  started: styles.stateStarted,
  skipped: styles.stateSkipped,
  pending: styles.statePending,
};

/** Monospace uppercase decision pill. See file header for rationale. */
export const DecisionPill: Component<DecisionPillProps> = (props) => {
  const rootClass = (): string => `${styles.root} ${STATE_CLASS[props.state]}`;
  return <span class={rootClass()}>{decisionLabel(props.state)}</span>;
};
