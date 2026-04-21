/**
 * Reply-detect module (design.md §D-004, FR-011-019..020).
 *
 * Pure functions that compare an element a user just picked against every
 * finalized pin observable in the history store. `matchScore(pin, element)`
 * is a weighted sum of source, component, and text signals, always in
 * `[0, 1]` and never throws on null inputs. `detectReplyCandidate(element,
 * history)` iterates every pin in every entry and returns the
 * highest-scoring candidate whose score meets
 * {@link REPLY_DETECT_THRESHOLD} — or `null` when nothing matches.
 *
 * Module boundaries (NFR-011-002): imports only `@forjis/shared` types and
 * the pure source/component helpers in `../pick/source-info.js`. No
 * transport, no mount, no `new WebSocket`.
 */

import type { Batch, Pin } from '@forjis/shared';
import {
  readComponentName,
  readSourceInfo,
} from '../pick/source-info.js';
import type { HistoryEntry } from '../history/storage.js';

/** Weighted-sum threshold above which a candidate surfaces a banner. */
export const REPLY_DETECT_THRESHOLD = 0.75 as const;

/** Weights per signal; design §D-004. */
const WEIGHT_SOURCE = 0.4;
const WEIGHT_COMPONENT = 0.3;
const WEIGHT_TEXT = 0.3;

/** The best-scoring historic pin plus its stored context. */
export interface ReplyCandidate {
  /** Matching historic pin. */
  readonly pin: Pin;
  /** Batch that contained the pin. */
  readonly batch: Batch;
  /** Task path for the batch. */
  readonly taskPath: string;
  /** Agent diff summary when available, else `null`. */
  readonly summary: string | null;
  /** Computed `matchScore`. */
  readonly score: number;
}

/**
 * Normalize a string for signal comparison: `null`/`undefined` → `""`,
 * otherwise `trim().toLowerCase()`.
 *
 * @param raw - Candidate string.
 * @returns Lowercased, trimmed string (possibly empty).
 */
function normalize(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  return raw.trim().toLowerCase();
}

/** Source signal: 1 when both files are non-null and equal; else 0. */
function sourceSignal(pin: Pin, element: Element): number {
  const elementSrc = readSourceInfo(element);
  const pinSrc = pin.target.source;
  if (elementSrc === null || pinSrc === null) {
    return 0;
  }
  return elementSrc.file === pinSrc.file ? 1 : 0;
}

/** Component signal: case-insensitive equality on trimmed names. */
function componentSignal(pin: Pin, element: Element): number {
  const elComponent = normalize(readComponentName(element));
  const pinComponent = normalize(pin.target.componentName);
  if (elComponent.length === 0 || pinComponent.length === 0) {
    return 0;
  }
  return elComponent === pinComponent ? 1 : 0;
}

/**
 * Text signal: match when `element.textContent` appears as a substring of
 * `pin.comment` OR equals `pin.target.innerText` (when that additive
 * extension field is present). All comparisons null-safe.
 */
function textSignal(pin: Pin, element: Element): number {
  const elText = normalize(element.textContent);
  if (elText.length === 0) {
    return 0;
  }
  const pinComment = normalize(pin.comment);
  if (pinComment.length > 0 && pinComment.includes(elText)) {
    return 1;
  }
  const innerTextField = (pin.target as unknown as {
    innerText?: string | null;
  }).innerText;
  const pinInner = normalize(innerTextField ?? null);
  if (pinInner.length > 0 && pinInner === elText) {
    return 1;
  }
  return 0;
}

/**
 * Compute the match score between a historic pin and a freshly-picked
 * element.
 *
 * @param pin - Historic pin.
 * @param element - Newly-picked element.
 * @returns Weighted sum in `[0, 1]`; deterministic; never throws.
 */
export function matchScore(pin: Pin, element: Element): number {
  if (pin === null || pin === undefined) {
    return 0;
  }
  if (element === null || element === undefined) {
    return 0;
  }
  const score =
    WEIGHT_SOURCE * sourceSignal(pin, element) +
    WEIGHT_COMPONENT * componentSignal(pin, element) +
    WEIGHT_TEXT * textSignal(pin, element);
  // Clamp defensively — weights sum exactly to 1.0 but float math is not
  // perfectly exact, so the [0, 1] closure is guaranteed by construction.
  if (score < 0) {
    return 0;
  }
  if (score > 1) {
    return 1;
  }
  return score;
}

/**
 * Iterate every pin in every history entry, find the highest-scoring
 * candidate, and return it if its score meets {@link REPLY_DETECT_THRESHOLD}.
 *
 * Pure: no DOM writes, no side effects.
 *
 * @param element - Element the user just confirmed.
 * @param history - History store snapshot.
 * @returns Best candidate at or above the threshold, else `null`.
 */
export function detectReplyCandidate(
  element: Element,
  history: readonly HistoryEntry[],
): ReplyCandidate | null {
  let best: ReplyCandidate | null = null;
  for (const entry of history) {
    for (const pin of entry.batch.pins) {
      const score = matchScore(pin, element);
      if (best === null || score > best.score) {
        best = {
          pin,
          batch: entry.batch,
          taskPath: entry.taskPath,
          summary: entry.summary,
          score,
        };
      }
    }
  }
  if (best === null || best.score < REPLY_DETECT_THRESHOLD) {
    return null;
  }
  return best;
}
