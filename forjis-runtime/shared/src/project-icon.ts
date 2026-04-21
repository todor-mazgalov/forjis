/**
 * project-icon — shared helpers for the per-project visual icon.
 *
 * Exposes a deterministic color derivation from an absolute project path
 * (`stringToColor`) and a first-letter extractor (`firstLetter`). The
 * TopBar `ProjectIcon` component, the server-side `/favicon.svg` handler,
 * and any future icon consumer all call the same two functions so the
 * browser-tab favicon and in-app icon can never visually drift apart.
 *
 * The hash algorithm is a djb2-style variant ported verbatim from the
 * legacy pre-redesign `dashboard.html` so existing project icons keep
 * their historical colors after the redesign.
 */

/**
 * Deterministic color from a string.
 *
 * Uses a djb2-style rolling hash (`hash = charCode + (hash << 5) - hash`)
 * over the input, folds the absolute value into the 360-degree hue wheel,
 * and returns an `hsl()` string with fixed saturation (70%) and lightness
 * (60%) so every project icon shares a consistent visual weight.
 *
 * Input is treated as opaque — the caller is expected to pass the full
 * absolute project directory path so two projects sharing a last segment
 * under different parents still resolve to distinct hues.
 *
 * @param str - Source string. An empty string resolves to hue 0 (red-ish).
 * @returns A CSS `hsl(<hue>, 70%, 60%)` color literal.
 */
export function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

/**
 * Extract the uppercase first character of a string.
 *
 * Returns the empty string when the input is empty so callers can skip
 * rendering the icon text entirely rather than showing a stray glyph.
 * Uses the default-locale `toUpperCase`; project names are expected to
 * be ASCII path segments so locale-specific casing is not a concern.
 *
 * @param str - Source string; typically the last segment of a project path.
 * @returns The first character uppercased, or `''` for an empty input.
 */
export function firstLetter(str: string): string {
  if (str.length === 0) {
    return '';
  }
  return str.charAt(0).toUpperCase();
}
