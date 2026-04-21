/**
 * ScoreBar primitive — 0-100 horizontal progress bar. No threshold tick; see
 * design.md decision D-6 "ScoreBar" (redesign-003).
 */

import type { Component } from 'solid-js';
import styles from './ScoreBar.module.css';

/** Fill colour tone. */
export type ScoreBarTone = 'accent' | 'skipped';

/** Props for {@link ScoreBar}. */
export interface ScoreBarProps {
  /** Fill percentage. Clamped to [0, 100]. */
  value: number;
  /** Fill colour. Default: `'accent'`. */
  tone?: ScoreBarTone;
  /** Additional class names merged onto the root element. */
  class?: string;
}

/** Clamp `n` into the inclusive interval [0, 100]. Separated so the rule is
 * named rather than inlined in the template. */
function clampPercent(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Map tone to its CSS module class. */
const TONE_CLASS: Record<ScoreBarTone, string> = {
  accent: styles.toneAccent,
  skipped: styles.toneSkipped,
};

/** Horizontal fill bar. No threshold marker. */
export const ScoreBar: Component<ScoreBarProps> = (props) => {
  const clamped = () => clampPercent(props.value);
  const rootClass = () => (props.class ? `${styles.root} ${props.class}` : styles.root);
  const fillClass = () => `${styles.fill} ${TONE_CLASS[props.tone ?? 'accent']}`;
  return (
    <div class={rootClass()}>
      <div class={fillClass()} style={{ width: `${clamped()}%` }} />
    </div>
  );
};
