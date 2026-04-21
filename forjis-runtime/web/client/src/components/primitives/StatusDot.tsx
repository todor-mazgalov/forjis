/**
 * StatusDot primitive — small coloured dot with optional animation. Two
 * contexts drive the variant system: topbar (pulse) and pipeline role-marker
 * (ring). See design.md decision D-6 "StatusDot" (redesign-003).
 */

import type { Component, JSX } from 'solid-js';
import styles from './StatusDot.module.css';

/** Supported dot states. */
export type StatusDotState = 'idle' | 'running' | 'done' | 'skipped' | 'failed' | 'queued';

/** Animation variants. `pulse` for topbar, `ring` for pipeline role-marker,
 * `static` for non-animated contexts. */
export type StatusDotVariant = 'pulse' | 'ring' | 'static';

/** Props for {@link StatusDot}. */
export interface StatusDotProps {
  /** Current state. Drives colour. */
  state: StatusDotState;
  /** Animation variant. Default: `'pulse'` when state is `'running'`,
   * otherwise `'static'`. */
  variant?: StatusDotVariant;
  /** Square dimension in px. Default: 6. */
  size?: number;
  /** Additional class names merged onto the root element. */
  class?: string;
}

/** Map state names to their CSS module classes. */
const STATE_CLASS: Record<StatusDotState, string> = {
  idle: styles.stateIdle,
  running: styles.stateRunning,
  done: styles.stateDone,
  skipped: styles.stateSkipped,
  failed: styles.stateFailed,
  queued: styles.stateQueued,
};

/** Map variant names to their CSS module classes. */
const VARIANT_CLASS: Record<StatusDotVariant, string> = {
  pulse: styles.variantPulse,
  ring: styles.variantRing,
  static: styles.variantStatic,
};

/**
 * Select the effective variant. Explicit prop always wins; otherwise running
 * defaults to pulse and everything else to static. Separated out so the
 * default-selection rule is named and testable rather than inlined.
 */
function resolveVariant(
  state: StatusDotState,
  variant: StatusDotVariant | undefined,
): StatusDotVariant {
  if (variant !== undefined) return variant;
  return state === 'running' ? 'pulse' : 'static';
}

/** Coloured dot. Running states animate; all others are static. */
export const StatusDot: Component<StatusDotProps> = (props) => {
  const effectiveVariant = () => resolveVariant(props.state, props.variant);
  const rootClass = () => {
    const parts = [styles.root, STATE_CLASS[props.state], VARIANT_CLASS[effectiveVariant()]];
    if (props.class) parts.push(props.class);
    return parts.join(' ');
  };
  const style = (): JSX.CSSProperties => {
    const dimension = `${props.size ?? 6}px`;
    return { width: dimension, height: dimension };
  };
  return <span class={rootClass()} style={style()} />;
};
