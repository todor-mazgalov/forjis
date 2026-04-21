/**
 * Factory that builds the absolute-positioned highlight overlay used by the
 * inspector: a tinted box plus an above-target label floater. Both are pure
 * DOM nodes — the caller owns mounting them into a shadow root.
 */

import type { Bbox } from '@forjis/shared';

/** Visual variant the highlight currently reflects. */
export type HighlightVariant = 'hover' | 'pending';

/** Public handle returned by {@link createHighlightBox}. */
export interface HighlightBoxHandle {
  /** Absolute-positioned `<div>` that covers the target's rect. */
  readonly element: HTMLElement;
  /** `<div>` floater shown above the target when a label is supplied. */
  readonly label: HTMLElement;
  /**
   * Position the highlight over the supplied rect and set its visual variant
   * + label text.
   *
   * @param rect - Target bbox in document coordinates.
   * @param variant - Style variant ("hover" or "pending").
   * @param label - Label text to render above the box, or `null` to hide it.
   */
  update(rect: Bbox, variant: HighlightVariant, label: string | null): void;
  /** Hide the highlight and the label floater. */
  hide(): void;
  /** Detach both elements and drop references. */
  destroy(): void;
}

/**
 * Build a fresh highlight box + label floater.
 *
 * @returns A {@link HighlightBoxHandle} whose elements start hidden.
 */
export function createHighlightBox(): HighlightBoxHandle {
  const element = document.createElement('div');
  element.setAttribute('data-forjis-role', 'highlight');
  element.setAttribute('aria-hidden', 'true');
  element.style.position = 'fixed';
  element.style.pointerEvents = 'none';
  element.style.display = 'none';
  element.style.left = '0';
  element.style.top = '0';
  element.style.boxSizing = 'border-box';

  const label = document.createElement('div');
  label.setAttribute('data-forjis-role', 'label');
  label.setAttribute('aria-hidden', 'true');
  label.style.position = 'fixed';
  label.style.pointerEvents = 'none';
  label.style.display = 'none';
  label.style.left = '0';
  label.style.top = '0';

  return {
    element,
    label,
    update(rect: Bbox, variant: HighlightVariant, labelText: string | null) {
      element.style.display = 'block';
      element.style.transform =
        'translate(' + String(rect.x) + 'px,' + String(rect.y) + 'px)';
      element.style.width = String(rect.w) + 'px';
      element.style.height = String(rect.h) + 'px';
      element.setAttribute('data-variant', variant);
      if (labelText === null) {
        label.style.display = 'none';
        return;
      }
      label.textContent = labelText;
      label.setAttribute('data-variant', variant);
      label.style.display = 'block';
      const labelY = rect.y - 24;
      label.style.transform =
        'translate(' + String(rect.x) + 'px,' + String(labelY) + 'px)';
    },
    hide() {
      element.style.display = 'none';
      label.style.display = 'none';
    },
    destroy() {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
      if (label.parentNode) {
        label.parentNode.removeChild(label);
      }
    },
  };
}
