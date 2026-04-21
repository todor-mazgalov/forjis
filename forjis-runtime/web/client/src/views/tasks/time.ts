/**
 * time.ts — Small duration formatting helpers for the Tasks view.
 *
 * Extracted so `TaskCard` keeps its body short and the formatting rules are
 * independently testable. Output is compact: seconds below 60, then
 * `Xm Ys`, then `Xh Ym`. Never returns the literal strings `"done"` or
 * `"stopped"` and never returns an ETA — see TASK.md for the rationale.
 */

/** Fallback glyph returned when the task has no `started` timestamp. */
export const ELAPSED_FALLBACK = '\u2014';

/**
 * Format the elapsed span between two ISO-8601 timestamps as a compact
 * human-readable string (e.g. `"45s"`, `"8m 12s"`, `"2h 15m"`).
 *
 * Returns {@link ELAPSED_FALLBACK} when `startIso` is absent or parses to an
 * invalid date. When `endIso` is absent, the current `now` is used so the
 * label keeps ticking for running tasks. Negative spans collapse to
 * {@link ELAPSED_FALLBACK} to avoid showing `"-1s"` during clock skew.
 *
 * @param startIso - ISO-8601 timestamp the span starts at, or null.
 * @param endIso - ISO-8601 timestamp the span ends at, or null for "now".
 * @param now - Epoch-ms "current time" used when `endIso` is null. Explicit
 *   so callers can refresh the label by passing a reactive accessor.
 */
export function formatElapsed(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: number,
): string {
  if (!startIso) return ELAPSED_FALLBACK;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return ELAPSED_FALLBACK;
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(end)) return ELAPSED_FALLBACK;
  const ms = end - start;
  if (ms < 0) return ELAPSED_FALLBACK;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
