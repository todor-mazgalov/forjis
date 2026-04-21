/**
 * SegmentedToggle primitive — horizontal group of mutually exclusive options.
 * Controlled-only: the caller owns the `value`/`onChange` pair; the component
 * never stores state. See design.md decisions D-6 and D-7 (redesign-003).
 */

import type { Component, JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import styles from './SegmentedToggle.module.css';

/** One option in a {@link SegmentedToggle}. */
export interface SegmentedOption {
  /** Stable identifier passed back through `onChange`. */
  value: string;
  /** Visible text. */
  label: string;
  /** Optional leading icon. */
  icon?: JSX.Element;
}

/** Props for {@link SegmentedToggle}. */
export interface SegmentedToggleProps {
  /** Options rendered left-to-right. */
  options: ReadonlyArray<SegmentedOption>;
  /** Currently selected option's `value`. */
  value: string;
  /** Called with the clicked option's `value`. */
  onChange: (value: string) => void;
  /** Additional class names merged onto the root element. */
  class?: string;
}

/** Horizontal mutually-exclusive option group. */
export const SegmentedToggle: Component<SegmentedToggleProps> = (props) => {
  const rootClass = () => (props.class ? `${styles.root} ${props.class}` : styles.root);
  const segmentClass = (isActive: boolean): string =>
    isActive ? `${styles.segment} ${styles.active}` : styles.segment;
  return (
    <div class={rootClass()} role="group">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class={segmentClass(option.value === props.value)}
            onClick={() => props.onChange(option.value)}
          >
            <Show when={option.icon}>{option.icon}</Show>
            <span>{option.label}</span>
          </button>
        )}
      </For>
    </div>
  );
};
