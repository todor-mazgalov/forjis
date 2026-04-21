/**
 * Curated computed-style snapshot extractor.
 *
 * The inspector ships a curated subset of `getComputedStyle(el)` with every
 * pin (the full dump carries ~400 noisy properties). The constant
 * {@link CURATED_CSS_PROPERTIES} fixes the property list at compile time so
 * the cardinality is stable (the Pin spec requires 20–40 keys — see
 * `design.md` §D-005 and `specs/inspector-sdk/spec.md` FR-009-010). The pure
 * function {@link captureComputedStyles} reads each property with
 * `getPropertyValue` and returns a fresh flat `Record<string, string>`.
 */

/**
 * The curated CSS property names captured for every pin.
 *
 * Total length: 33 — comfortably inside the spec's [20, 40] inclusive range.
 * The list is grouped for maintainer readability; grouping has no runtime
 * effect.
 *
 * @see design.md §D-005 for the rationale behind each group and each shorthand
 *   vs. longhand choice.
 */
export const CURATED_CSS_PROPERTIES: readonly string[] = [
  // Color / typography (9).
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  // Box model — shorthands (2). Browsers resolve these to 4-value strings.
  'padding',
  'margin',
  // Border — shorthand-of-shorthands (3).
  'border-width',
  'border-style',
  'border-color',
  // Display / layout (8).
  'display',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'grid-template-columns',
  'grid-template-rows',
  // Positioning (5).
  'position',
  'top',
  'right',
  'bottom',
  'left',
  // Sizing (2).
  'width',
  'height',
  // Miscellaneous visual (4).
  'z-index',
  'opacity',
  'cursor',
  'gap',
];

/**
 * Read the browser-resolved values of {@link CURATED_CSS_PROPERTIES} for `el`
 * and return them in a fresh plain object.
 *
 * Pure: no DOM mutation, no listeners. The keys of the returned object are
 * exactly those in {@link CURATED_CSS_PROPERTIES}, in the same order. Values
 * are whatever `getPropertyValue` returned — possibly the empty string for a
 * shorthand the browser could not resolve uniformly.
 *
 * @param el - Element whose computed styles to snapshot.
 * @returns Plain `Record<string, string>` with 20–40 keys.
 */
export function captureComputedStyles(el: Element): Record<string, string> {
  const computed = window.getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const name of CURATED_CSS_PROPERTIES) {
    out[name] = computed.getPropertyValue(name);
  }
  return out;
}
