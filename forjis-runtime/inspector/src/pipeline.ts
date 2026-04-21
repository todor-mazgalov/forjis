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
 * Produce a fresh identifier for the pin.
 *
 * Mirrors `transport.ts`'s `generateClientId` pattern (design.md §D-008):
 * prefer `crypto.randomUUID()` when available, otherwise fall back to an
 * RFC4122 v4 UUID built from `Math.random`. Duplicate inlined rather than
 * extracted to a shared util until a third caller appears.
 *
 * @returns Non-empty UUID string.
 */
function generateId(): string {
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

/**
 * Build a `Pin` from the captured evidence bundle. Fixed fields are:
 * `platform = "web"`, `screen = location.pathname` (read at call time),
 * `parentPinId = null`, `createdAt = new Date().toISOString()`, and
 * `id = generateId()`. The two PNG blobs are base64-encoded via FileReader.
 * The computed-styles record is JSON-stringified. Annotations are shallow-
 * copied so a later mutation of the caller's array cannot corrupt the pin.
 *
 * @param target - `PinTarget` produced by the overlay at pick time.
 * @param comment - Free-text comment from the sheet's textarea.
 * @param annotations - Annotations drawn on the viewport thumbnail.
 * @param blobs - Element/viewport PNG blobs and the computed-styles snapshot.
 * @returns Promise resolving to a wire-valid `Pin`.
 */
export async function buildPin(
  target: PinTarget,
  comment: string,
  annotations: Annotation[],
  blobs: BuildPinBlobs,
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
    id: generateId(),
    platform: 'web',
    screen: window.location.pathname,
    target,
    capture,
    comment,
    createdAt: new Date().toISOString(),
    parentPinId: null,
  };
  return pin;
}
