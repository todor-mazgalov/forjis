/**
 * Panel primitive — bordered card with an optional header slot and optional
 * body padding. See design.md decision D-6 "Panel" (redesign-003).
 */

import type { Component, JSX } from 'solid-js';
import { Show } from 'solid-js';
import styles from './Panel.module.css';

/** Props for {@link Panel}. */
export interface PanelProps {
  /** Optional header slot rendered above a 1px divider. */
  header?: JSX.Element;
  /** Body content. */
  children: JSX.Element;
  /** Additional class names merged onto the root element. */
  class?: string;
  /** When true, the body gets `--space-3` padding. Default: false. */
  padded?: boolean;
}

/** Bordered container primitive. Does not nest any other primitive. */
export const Panel: Component<PanelProps> = (props) => {
  const rootClass = () => (props.class ? `${styles.root} ${props.class}` : styles.root);
  const bodyClass = () => (props.padded ? `${styles.body} ${styles.padded}` : styles.body);
  return (
    <div class={rootClass()}>
      <Show when={props.header}>
        <div class={styles.header}>{props.header}</div>
      </Show>
      <div class={bodyClass()}>{props.children}</div>
    </div>
  );
};
