/**
 * Pill primitive — monospace uppercase status pill. Six states cover pipeline
 * role statuses from pillars/data.md (`planned | running | done | skipped |
 * failed`) plus a generic `pending` variant. See design.md decision D-6
 * "Pill" (redesign-003).
 */

import type { Component } from 'solid-js';
import styles from './Pill.module.css';

/** Supported states. `planned`/`running`/`done`/`skipped`/`failed` map 1:1 to
 * pipeline role statuses; `pending` is a neutral variant for out-of-band use. */
export type PillState =
  | 'planned'
  | 'running'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'pending';

/** Props for {@link Pill}. */
export interface PillProps {
  /** Current state. Drives both visual variant and default label. */
  state: PillState;
  /** Optional override for the visible text. Defaults to uppercased state. */
  label?: string;
  /** Additional class names merged onto the root element. */
  class?: string;
}

/**
 * Map each pill state to its CSS module class. Declarative rather than
 * template-string interpolation so the set of valid states is explicit.
 */
const STATE_CLASS: Record<PillState, string> = {
  planned: styles.statePlanned,
  running: styles.stateRunning,
  done: styles.stateDone,
  skipped: styles.stateSkipped,
  failed: styles.stateFailed,
  pending: styles.statePending,
};

/** Monospace uppercase status pill. */
export const Pill: Component<PillProps> = (props) => {
  const rootClass = () => {
    const parts = [styles.root, STATE_CLASS[props.state]];
    if (props.class) parts.push(props.class);
    return parts.join(' ');
  };
  const text = () => props.label ?? props.state.toUpperCase();
  return <span class={rootClass()}>{text()}</span>;
};
