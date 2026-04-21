/**
 * Popover primitive — click-to-open overlay anchored to a trigger element.
 * Closes on outside click and Escape. Internal state only; controlled mode
 * is intentionally out of scope. See design.md decisions D-6 and D-7
 * (redesign-003).
 */

import type { Component, JSX } from 'solid-js';
import { Show, createSignal, createEffect, onCleanup } from 'solid-js';
import styles from './Popover.module.css';

/** Fixed anchor position relative to the trigger's bounding box. */
export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

/** Props for {@link Popover}. */
export interface PopoverProps {
  /** Element rendered as the trigger. Clicking it toggles the popover. */
  trigger: JSX.Element;
  /** Popover body. */
  children: JSX.Element;
  /** Anchor position. Default: `'bottom-start'`. */
  placement?: PopoverPlacement;
  /** Additional class names merged onto the root wrapper. */
  class?: string;
}

/** Map placement values to their CSS module classes. */
const PLACEMENT_CLASS: Record<PopoverPlacement, string> = {
  'bottom-start': styles.placeBottomStart,
  'bottom-end': styles.placeBottomEnd,
  'top-start': styles.placeTopStart,
  'top-end': styles.placeTopEnd,
};

/**
 * Attach window-level `click` and `keydown` listeners that close the popover
 * on outside-click and Escape respectively. Returns a cleanup fn the caller
 * registers with `onCleanup`. Isolated so the lifecycle rule is named.
 */
function attachDismissListeners(options: {
  rootEl: HTMLElement;
  close: () => void;
}): () => void {
  const onDocumentClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (options.rootEl.contains(target)) return;
    options.close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') options.close();
  };
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeyDown);
  };
}

/** Click-to-open overlay with Escape + outside-click dismissal. */
export const Popover: Component<PopoverProps> = (props) => {
  const [isOpen, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;

  // Attach dismissal listeners only while open; cleanup runs when the signal
  // transitions back to closed or the component unmounts.
  createEffect(() => {
    if (!isOpen()) return;
    if (!rootEl) return;
    const detach = attachDismissListeners({
      rootEl,
      close: () => setOpen(false),
    });
    onCleanup(detach);
  });

  const rootClass = () => (props.class ? `${styles.root} ${props.class}` : styles.root);
  const contentClass = () =>
    `${styles.content} ${PLACEMENT_CLASS[props.placement ?? 'bottom-start']}`;

  const onTriggerClick = (event: MouseEvent) => {
    // Prevent the document-click handler from seeing this click and
    // immediately re-closing the popover we just opened.
    event.stopPropagation();
    setOpen((prev) => !prev);
  };

  return (
    <div class={rootClass()} ref={rootEl}>
      <div class={styles.trigger} onClick={onTriggerClick}>
        {props.trigger}
      </div>
      <Show when={isOpen()}>
        <div class={contentClass()}>{props.children}</div>
      </Show>
    </div>
  );
};
