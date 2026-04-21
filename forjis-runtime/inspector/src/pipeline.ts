/**
 * Pin assembly pipeline: takes the captured bundle (element PNG, viewport
 * PNG, curated computed-styles record, annotations, comment) and produces a
 * `Pin` that conforms exactly to the frozen `@forjis/shared` wire shape.
 *
 * `computedStyles` is PASSED IN, not recomputed here — design.md §D-008
 * explains why: the element reference belongs to the overlay's `onPick`
 * closure, but `buildPin` runs inside the comment-sheet Send handler after
 * the user has had time to scroll or the host app has had time to re-render.
 * Capturing styles synchronously at pick time and threading the snapshot
 * through the comment-sheet context keeps the styles aligned with the
 * screenshots.
 */

import type { Annotation, Pin, PinCapture, PinTarget } from '@forjis/shared';
import { getCurrentScreen } from './queue/screen-tracker.js';
import { generateUuid } from './util/uuid.js';

/** Blob + computed-styles bundle consumed by {@link buildPin}. */
export interface BuildPinBlobs {
  /** Cropped element screenshot. */
  readonly elementPng: Blob;
  /** Full viewport screenshot with the pin bbox marked. */
  readonly viewportPng: Blob;
  /** Curated computed-style record for the picked element. */
  readonly computedStyles: Record<string, string>;
}

/**
 * Read a Blob's contents as a `data:image/png;base64,…` URL via
 * `FileReader.readAsDataURL`. The reader's result already carries the
 * `data:image/png;base64,` prefix — we assign the full result directly; we
 * do NOT strip and re-add the prefix (FR-009-006 "Screenshot fields are
 * base64 data URLs").
 *
 * @param blob - Blob to encode.
 * @returns Promise resolving to the data URL string.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
        return;
      }
      reject(new Error('FileReader.readAsDataURL returned non-string'));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader failed'));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Optional caller-supplied overrides threaded through {@link buildPin}.
 *
 * `commentGroupId` defaults to `null` when omitted; the comment-sheet
 * populates it with a shared v4 UUID when pins are collected under the
 * "Add another pin" multi-pin flow. `screen` defaults to the screen
 * tracker's `getCurrentScreen()` value captured at pick time (not at Send
 * time) — the sheet threads the pick-time screen through on Send so the
 * pin's `screen` reflects the route the user was on when the pin was
 * drawn, even if the user navigated before pressing Send.
 */
export interface BuildPinOptions {
  /** Shared multi-pin group identifier, or `null` for solo pins. */
  readonly commentGroupId?: string | null;
  /** Screen pathname captured at pick time; falls back to the tracker. */
  readonly screen?: string | null;
  /**
   * Parent pin identifier set by the reply flow. `null` / `undefined`
   * preserves the pre-task-011 default; explicit string values thread
   * through to `pin.parentPinId` unchanged (FR-011-024).
   */
  readonly parentPinId?: string | null;
}

/**
 * Resolve the `pin.screen` value, preferring explicit caller overrides.
 *
 * Precedence: `opts.screen` (supplied explicitly) → `getCurrentScreen()`
 * from the screen tracker → `window.location.pathname`. The final fallback
 * fires only when the tracker was never initialized (test environments;
 * FR-010-031 "If the tracker is not initialized, `pin.screen` MUST equal
 * `window.location.pathname`").
 *
 * @param opts - Optional override bag.
 * @returns The resolved screen pathname or `null`.
 */
function resolveScreen(opts: BuildPinOptions | undefined): string | null {
  if (opts && opts.screen !== undefined) {
    return opts.screen;
  }
  const tracked = getCurrentScreen();
  if (tracked !== null) {
    return tracked;
  }
  return window.location.pathname;
}

/**
 * Build a `Pin` from the captured evidence bundle. Fixed fields are:
 * `platform = "web"`, `parentPinId = null`,
 * `createdAt = new Date().toISOString()`, and `id = generateUuid()`. The
 * two PNG blobs are base64-encoded via FileReader. The computed-styles
 * record is JSON-stringified. Annotations are shallow-copied so a later
 * mutation of the caller's array cannot corrupt the pin. `screen` and
 * `commentGroupId` come from `opts` (see {@link BuildPinOptions}) and
 * default to the screen tracker's value and `null` respectively.
 *
 * @param target - `PinTarget` produced by the overlay at pick time.
 * @param comment - Free-text comment from the sheet's textarea.
 * @param annotations - Annotations drawn on the viewport thumbnail.
 * @param blobs - Element/viewport PNG blobs and the computed-styles snapshot.
 * @param opts - Optional overrides for `commentGroupId` and `screen`.
 * @returns Promise resolving to a wire-valid `Pin`.
 */
export async function buildPin(
  target: PinTarget,
  comment: string,
  annotations: Annotation[],
  blobs: BuildPinBlobs,
  opts?: BuildPinOptions,
): Promise<Pin> {
  const elementScreenshot = await blobToDataUrl(blobs.elementPng);
  const viewportScreenshot = await blobToDataUrl(blobs.viewportPng);
  const capture: PinCapture = {
    elementScreenshot,
    viewportScreenshot,
    computedStyles: JSON.stringify(blobs.computedStyles),
    annotations: annotations.slice(),
  };
  const pin: Pin = {
    id: generateUuid(),
    platform: 'web',
    screen: resolveScreen(opts),
    target,
    capture,
    comment,
    createdAt: new Date().toISOString(),
    parentPinId: opts?.parentPinId ?? null,
    commentGroupId: opts?.commentGroupId ?? null,
  };
  return pin;
}
