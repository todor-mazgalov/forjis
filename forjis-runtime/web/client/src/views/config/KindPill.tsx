/**
 * KindPill — purpose-built pill for constraint `kind` (`mandatory` /
 * `optional` / `pillar`). Distinct from the shared `Pill` primitive whose
 * state enum represents pipeline-step status. See design.md § D-5 for why
 * this is kept local to `views/config/` and not added to the primitive.
 */

import type { Component } from 'solid-js';
import type { ConstraintKind } from './catalog';
import styles from './KindPill.module.css';

/** Props for {@link KindPill}. */
export interface KindPillProps {
  /** Constraint classification. Drives the variant class + label. */
  kind: ConstraintKind;
}

/**
 * Map each kind to its CSS module variant class. Kept as an object so the
 * full variant set is audit-able at a glance and `noUncheckedIndexedAccess`
 * cannot produce an `undefined` class.
 */
const KIND_CLASS: Record<ConstraintKind, string> = {
  pillar: styles.pillar,
  mandatory: styles.mandatory,
  optional: styles.optional,
};

/** Coloured pill showing the constraint kind. */
export const KindPill: Component<KindPillProps> = (props) => {
  const rootClass = (): string => `${styles.kindPill} ${KIND_CLASS[props.kind]}`;
  return <span class={rootClass()}>{props.kind}</span>;
};
