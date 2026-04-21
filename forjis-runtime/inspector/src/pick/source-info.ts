/**
 * Pure helpers that extract pin-target inputs (source location, component
 * name, CSS selector, bbox) from a host DOM element. These functions never
 * mutate the DOM; they are unit-testable in isolation from the overlay
 * module.
 */

import type { Bbox, PinSource } from '@forjis/shared';

/**
 * Resolve the nearest ancestor's `data-forjis-src` attribute into a
 * {@link PinSource}.
 *
 * The attribute is expected to be a `file:line:col` triple where `line` and
 * `col` are positive integers. Any other shape (or a missing attribute) yields
 * `null`. This function never throws.
 *
 * @param el - Starting element (walk begins here, including `el` itself).
 * @returns Parsed {@link PinSource} or `null`.
 */
export function readSourceInfo(el: Element): PinSource | null {
  const carrier = el.closest('[data-forjis-src]');
  if (!carrier) {
    return null;
  }
  const raw = carrier.getAttribute('data-forjis-src');
  if (raw === null || raw === '') {
    return null;
  }
  const parts = raw.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [file, lineRaw, colRaw] = parts;
  if (file === '') {
    return null;
  }
  const line = Number.parseInt(lineRaw, 10);
  const col = Number.parseInt(colRaw, 10);
  if (!Number.isInteger(line) || line <= 0) {
    return null;
  }
  if (!Number.isInteger(col) || col <= 0) {
    return null;
  }
  if (String(line) !== lineRaw || String(col) !== colRaw) {
    return null;
  }
  return { file, line, col };
}

/**
 * Resolve the nearest ancestor's `data-forjis-component` attribute.
 *
 * @param el - Starting element.
 * @returns The attribute's string value, or `null` when no ancestor carries it.
 */
export function readComponentName(el: Element): string | null {
  const carrier = el.closest('[data-forjis-component]');
  if (!carrier) {
    return null;
  }
  return carrier.getAttribute('data-forjis-component');
}

/**
 * Apply {@link CSS.escape} when available; otherwise return the literal.
 *
 * @param value - Identifier to escape.
 * @returns Escaped identifier suitable for use in a CSS selector.
 */
function safeCssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value;
}

/**
 * Return the 1-based index of `el` among same-tag siblings of its parent.
 *
 * @param el - Element whose `nth-of-type` index to compute.
 * @returns 1-based index (always ≥ 1).
 */
function nthOfTypeIndex(el: Element): number {
  const parent = el.parentElement;
  if (!parent) {
    return 1;
  }
  let index = 0;
  for (const child of Array.from(parent.children)) {
    if (child.tagName === el.tagName) {
      index += 1;
      if (child === el) {
        return index;
      }
    }
  }
  return index === 0 ? 1 : index;
}

/**
 * Build a stable CSS selector for `el`.
 *
 * Walks ancestors upward appending `tag:nth-of-type(n)` segments. When an
 * id-bearing ancestor is encountered, the walk stops after prepending
 * `#<escaped-id>`. When no id is present, the chain bottoms out at `html`.
 *
 * @param el - Element to describe.
 * @returns Non-empty selector string.
 */
export function computeSelector(el: Element): string {
  const segments: string[] = [];
  let current: Element | null = el;
  while (current) {
    if (current.id && current.id !== '') {
      segments.unshift('#' + safeCssEscape(current.id));
      return segments.join(' > ');
    }
    if (current === current.ownerDocument.documentElement) {
      segments.unshift(current.tagName.toLowerCase());
      return segments.join(' > ');
    }
    const tag = current.tagName.toLowerCase();
    const idx = nthOfTypeIndex(current);
    segments.unshift(tag + ':nth-of-type(' + String(idx) + ')');
    current = current.parentElement;
  }
  return segments.join(' > ');
}

/**
 * Read `el.getBoundingClientRect()` and normalize it to document coordinates.
 *
 * @param el - Element to measure.
 * @returns {@link Bbox} with `x`/`y` offset by `window.scrollX`/`scrollY`.
 */
export function computeBbox(el: Element): Bbox {
  const rect = el.getBoundingClientRect();
  const scrollX = typeof window.scrollX === 'number' ? window.scrollX : 0;
  const scrollY = typeof window.scrollY === 'number' ? window.scrollY : 0;
  return {
    x: rect.left + scrollX,
    y: rect.top + scrollY,
    w: rect.width,
    h: rect.height,
  };
}
