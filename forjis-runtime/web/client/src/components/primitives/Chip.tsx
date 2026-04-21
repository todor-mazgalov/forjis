/**
 * Chip primitive — small inline pill for tags and attached-resource badges.
 * See design.md decision D-6 "Chip" (redesign-003).
 */

import type { Component, JSX } from 'solid-js';
import { Show } from 'solid-js';
import styles from './Chip.module.css';

/** Semantic tone. Selects a colour pairing from the semantic palette. */
export type ChipTone =
  | 'neutral'
  | 'skill'
  | 'hook'
  | 'agent'
  | 'outcome'
  | 'persona'
  | 'constraint';

/** Props for {@link Chip}. */
export interface ChipProps {
  /** Optional leading icon. */
  icon?: JSX.Element;
  /** Chip label text. */
  label: string;
  /** Colour tone. Default: `'neutral'`. */
  tone?: ChipTone;
  /** Additional class names merged onto the root element. */
  class?: string;
}

/**
 * Map each tone name to its CSS module class. Kept as a plain object so the
 * switch stays declarative and the set of tones is trivially audit-able.
 */
const TONE_CLASS: Record<ChipTone, string> = {
  neutral: styles.toneNeutral,
  skill: styles.toneSkill,
  hook: styles.toneHook,
  agent: styles.toneAgent,
  outcome: styles.toneOutcome,
  persona: styles.tonePersona,
  constraint: styles.toneConstraint,
};

/** Small coloured pill with optional icon and label. */
export const Chip: Component<ChipProps> = (props) => {
  const toneClass = () => TONE_CLASS[props.tone ?? 'neutral'];
  const rootClass = () => {
    const parts = [styles.root, toneClass()];
    if (props.class) parts.push(props.class);
    return parts.join(' ');
  };
  return (
    <span class={rootClass()}>
      <Show when={props.icon}>{props.icon}</Show>
      <span>{props.label}</span>
    </span>
  );
};
