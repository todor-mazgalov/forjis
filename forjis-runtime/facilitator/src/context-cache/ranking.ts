/**
 * Deterministic fuzzy ranker for `tree.yaml` rows against a task
 * description.
 *
 * Scoring components (all case-insensitive):
 *   (a) substring match count of tokens in `path`         × 1.0
 *   (b) substring match count of tokens in `summary`      × 1.0
 *   (c) basename match — prefix-3 / substring-1 per token × 2.0
 *
 * Sort: score DESC, then `path` ASC (deterministic tie-break). No
 * embeddings, no AST, no external dependencies.
 */

import type { TreeEntry } from './tree-yaml.js';

/** A ranked row — ordering key exposed for tests only. */
export interface RankedRow {
  path: string;
  summary: string;
  /** Composite score — opaque to consumers other than tests. */
  score: number;
}

/** Weight applied to path-substring matches. */
const PATH_WEIGHT = 1.0;

/** Weight applied to summary-substring matches. */
const SUMMARY_WEIGHT = 1.0;

/** Weight applied to basename fuzzy component. */
const BASENAME_WEIGHT = 2.0;

/** Per-token score when the basename starts with the token. */
const BASENAME_PREFIX_SCORE = 3;

/** Per-token score when the basename merely contains the token (not prefix). */
const BASENAME_SUBSTRING_SCORE = 1;

/**
 * Ranks `rows` against `taskDescription` using the scoring rules
 * above. Returns a sorted slice — pure function, deterministic.
 *
 * @param rows - Entries from `tree.yaml`.
 * @param taskDescription - Free-form task description.
 * @param limit - Optional max rows to return (after sorting).
 * @returns Ranked rows, score descending, path ascending on ties.
 */
export function rankByTask(
  rows: TreeEntry[],
  taskDescription: string,
  limit?: number,
): RankedRow[] {
  const tokens = tokenise(taskDescription);
  const scored: RankedRow[] = [];

  for (const row of rows) {
    const score = computeScore(row, tokens);
    scored.push({ path: row.path, summary: row.summary, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  if (typeof limit === 'number' && limit >= 0 && limit < scored.length) {
    return scored.slice(0, limit);
  }
  return scored;
}

/**
 * Splits the task description on any non-alphanumeric run, lowercases,
 * and drops zero-length tokens.
 */
function tokenise(taskDescription: string): string[] {
  return taskDescription
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Computes the composite score for a single row. */
function computeScore(row: TreeEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const pathLc = row.path.toLowerCase();
  const summaryLc = row.summary.toLowerCase();
  const base = basename(pathLc);

  let total = 0;
  for (const tk of tokens) {
    total += substringCount(pathLc, tk) * PATH_WEIGHT;
    total += substringCount(summaryLc, tk) * SUMMARY_WEIGHT;
    total += basenameScore(base, tk) * BASENAME_WEIGHT;
  }
  return total;
}

/** Case-sensitive (after prior lowercasing) substring occurrence count. */
function substringCount(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Per-token basename score:
 *   - 3 when basename starts with the token (prefix match)
 *   - 1 when basename merely contains the token (non-prefix)
 *   - 0 otherwise
 */
function basenameScore(base: string, token: string): number {
  if (token.length === 0) return 0;
  if (base.startsWith(token)) return BASENAME_PREFIX_SCORE;
  if (base.includes(token)) return BASENAME_SUBSTRING_SCORE;
  return 0;
}

/** Returns the basename of a POSIX path. */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}
