/**
 * Shared types for inline-SVG icon components. Every icon in this directory
 * accepts the same prop surface so consumers can treat them interchangeably.
 * See design.md decision D-5 (redesign-003).
 */

/**
 * Common prop shape for every icon component.
 *
 * - `size` — one number applied to both width and height; default 14 px.
 * - `class` — passed through to the underlying `<svg>` element (Solid uses
 *   `class`, not React's `className`).
 * - `title` — optional `<title>` element rendered inside the svg for tooltip
 *   support. Present purely as a nice-to-have; accessibility is out of scope
 *   for redesign-003.
 */
export interface IconProps {
  size?: number;
  class?: string;
  title?: string;
}

/** Default square dimension (in px) used when a caller omits `size`. */
export const DEFAULT_ICON_SIZE = 14;
