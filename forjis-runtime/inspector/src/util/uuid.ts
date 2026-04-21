/**
 * Shared RFC 4122 v4 UUID generator used by `pipeline.ts` (pin id),
 * `transport.ts` (client id), and `queue/batch-state.ts` (batch id).
 *
 * Prefers the standardised `crypto.randomUUID()` when available (modern
 * browsers and jsdom >= 22). Falls back to a `Math.random`-based v4 UUID so
 * the SDK never emits an empty identifier (the facilitator's validator
 * rejects it). Extracted per design.md §D-014 so the three call sites share
 * a single implementation instead of triplicating the fallback.
 */

/**
 * Generate a fresh RFC 4122 v4 UUID string.
 *
 * @returns Non-empty UUID string matching
 *   `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
 */
export function generateUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
