/**
 * AttachedChipRow — one row of coloured chip buttons for a role card or the
 * detail drawer's Attached section.
 *
 * Shared between {@link CardGrid} and {@link DetailDrawer} so both surfaces
 * render the same chip affordance. Renders nothing when `names` is empty —
 * the role card and drawer already gate empty attached-resource arrays per
 * design.md § D-1.
 */

import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';
import type { ChipTone } from '../../components/primitives/Chip';
import { Chip } from '../../components/primitives/Chip';
import type { CatalogType } from './catalog';
import styles from './AttachedChipRow.module.css';

/** Props for {@link AttachedChipRow}. */
export interface AttachedChipRowProps {
  /** Display label — e.g. `skills`, `hooks`. */
  label: string;
  /** Chip colour tone. Matches the catalog type colour. */
  tone: ChipTone;
  /** Catalog type cross-linked to on click. */
  type: CatalogType;
  /** Chip labels — one button per entry. */
  names: string[];
  /** Cross-link handler; receives `(type, name)` on chip click. */
  onCrossLink: (type: CatalogType, name: string) => void;
}

/**
 * Row rendered as a label column + wrapping flex of chip buttons. The button
 * wrapper stops click propagation so the outer card click handler does not
 * fire when a chip is clicked.
 */
export const AttachedChipRow: Component<AttachedChipRowProps> = (props) => {
  return (
    <Show when={props.names.length > 0}>
      <div class={styles.attachedRow}>
        <span class={styles.attachedLabel}>{props.label}</span>
        <div class={styles.attachedChips}>
          <For each={props.names}>
            {(name) => (
              <button
                type="button"
                class={styles.chipButton}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCrossLink(props.type, name);
                }}
              >
                <Chip tone={props.tone} label={name} />
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};
