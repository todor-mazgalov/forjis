/**
 * Pure JSON envelope scanner for the Inspector clarifier runner.
 *
 * Clarifier personas frequently emit a short prose preamble
 * (for example `"The intent is clear. No clarifying question is
 * needed."`) before the actual JSON envelope in a single assistant
 * turn. The legacy parser in
 * {@link ./inspector-clarifier-runner.ts} treated the whole line as
 * one JSON document, so any prose on the same line dropped the
 * envelope silently.
 *
 * This module exports {@link extractJsonEnvelopes} — a single-pass
 * character scanner that walks the text tracking brace depth and
 * string-literal state (including escape sequences) and collects
 * every balanced top-level `{...}` substring. Each candidate is then
 * passed through `JSON.parse`; unparseable candidates are skipped
 * rather than throwing, so a caller can treat the return value as an
 * ordered list of best-effort envelopes.
 *
 * The module is intentionally free of side effects, external state,
 * and I/O: it is safe to call from inside a tight event-ingest loop.
 */

/**
 * Extract every balanced top-level `{...}` substring from `text` and
 * return the subset that parses as JSON.
 *
 * The scanner respects:
 *
 * - **Nested braces** — `{"a":{"b":1}}` is returned as a single
 *   envelope, not two.
 * - **String literals** — braces inside `"..."` (including the
 *   quote character itself) are ignored.
 * - **Escape sequences** — `"he said \"hi\""` does not end the
 *   string prematurely.
 * - **Unclosed braces** — a trailing `{...` with no matching `}` is
 *   dropped, not emitted as a candidate.
 *
 * Candidates that are brace-balanced but fail `JSON.parse` (for
 * example `{not json}`) are silently skipped.
 *
 * @param text - Arbitrary assistant-emitted string that may mix prose
 *   and zero or more JSON envelopes.
 * @returns Parsed JSON values in the order their envelopes appeared
 *   in `text`. Empty when `text` contains no balanced candidates or
 *   every candidate fails to parse.
 */
export function extractJsonEnvelopes(text: string): unknown[] {
  const candidates = collectBalancedCandidates(text);
  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    const value = tryParse(candidate);
    if (value.ok) {
      parsed.push(value.value);
    }
  }
  return parsed;
}

/** Per-character scanner state tracked while walking `text`. */
interface ScannerState {
  depth: number;
  inString: boolean;
  escape: boolean;
  start: number;
}

/**
 * Walk `text` once and return every balanced top-level `{...}`
 * substring in order. Does not attempt to parse the candidates.
 *
 * @param text - Input string to scan.
 * @returns Ordered list of balanced substrings.
 */
function collectBalancedCandidates(text: string): string[] {
  const state: ScannerState = {
    depth: 0,
    inString: false,
    escape: false,
    start: -1,
  };
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (state.inString) {
      advanceInString(state, char);
      continue;
    }
    if (char === '"') {
      state.inString = true;
      continue;
    }
    if (char === '{') {
      if (state.depth === 0) {
        state.start = index;
      }
      state.depth += 1;
      continue;
    }
    if (char === '}') {
      advanceClosingBrace(state, text, index, candidates);
    }
  }
  return candidates;
}

/**
 * Advance `state` for a character consumed while inside a string
 * literal. Handles the escape flag and the closing quote.
 *
 * @param state - Scanner state, mutated in place.
 * @param char - Character being processed.
 */
function advanceInString(state: ScannerState, char: string): void {
  if (state.escape) {
    state.escape = false;
    return;
  }
  if (char === '\\') {
    state.escape = true;
    return;
  }
  if (char === '"') {
    state.inString = false;
  }
}

/**
 * Advance `state` for a `}` encountered outside a string literal.
 * When it closes the outermost brace, append the balanced substring
 * to `candidates` and reset the start marker.
 *
 * @param state - Scanner state, mutated in place.
 * @param text - Source string.
 * @param index - Index of the `}` in `text`.
 * @param candidates - Output list, appended to when `depth` returns
 *   to zero.
 */
function advanceClosingBrace(
  state: ScannerState,
  text: string,
  index: number,
  candidates: string[],
): void {
  if (state.depth === 0) return;
  state.depth -= 1;
  if (state.depth === 0 && state.start !== -1) {
    candidates.push(text.slice(state.start, index + 1));
    state.start = -1;
  }
}

/** Result of a `JSON.parse` attempt expressed as a tagged union. */
type ParseResult = { ok: true; value: unknown } | { ok: false };

/**
 * Attempt `JSON.parse(candidate)` without throwing.
 *
 * @param candidate - Brace-balanced substring emitted by
 *   {@link collectBalancedCandidates}.
 * @returns `{ ok: true, value }` when parsing succeeds, otherwise
 *   `{ ok: false }`.
 */
function tryParse(candidate: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}
