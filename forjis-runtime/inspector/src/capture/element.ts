/**
 * Element screenshot capture.
 *
 * `captureElement(el)` rasterizes the picked element's bounding box plus
 * {@link ELEMENT_PADDING_PX} padding (clamped to the viewport) into a PNG
 * `Blob`. It uses `modern-screenshot`'s `domToBlob` to capture the whole
 * viewport, then crops to the target rect on an off-screen canvas.
 *
 * The screenshot library choice (`modern-screenshot`) was made in design.md
 * §D-001: smaller bundle (~30 kB gzipped vs. html2canvas's ~48 kB), built-in
 * shadow-DOM traversal with a `filter` predicate, Blob-returning API that
 * matches this function's signature 1:1. Swapping libraries is a one-file
 * change — only the single `domToBlob` import below points at the adapter.
 */

import { domToBlob } from 'modern-screenshot';
import { createFallbackPng } from './fallback-png.js';
import { buildOverlayFilter, withOverlayHidden } from './overlay-hide.js';

/** Padding (in viewport pixels) added to every side of the element's bbox. */
export const ELEMENT_PADDING_PX = 20;

/** Target crop region in viewport pixel space, clamped to the viewport. */
interface CropRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Compute the inflated, viewport-clamped crop region for an element.
 *
 * @param el - Target element.
 * @returns Crop region with non-negative coords and positive dimensions.
 */
function computeCropRegion(el: Element): CropRegion {
  const rect = el.getBoundingClientRect();
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const rawLeft = rect.left - ELEMENT_PADDING_PX;
  const rawTop = rect.top - ELEMENT_PADDING_PX;
  const rawRight = rect.right + ELEMENT_PADDING_PX;
  const rawBottom = rect.bottom + ELEMENT_PADDING_PX;
  const x = Math.max(0, Math.floor(rawLeft));
  const y = Math.max(0, Math.floor(rawTop));
  const right = Math.min(viewportW, Math.ceil(rawRight));
  const bottom = Math.min(viewportH, Math.ceil(rawBottom));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  return { x, y, width, height };
}

/**
 * Convert a viewport-sized PNG Blob into a cropped PNG Blob by drawing it
 * onto an off-screen 2D canvas at the negative crop origin.
 *
 * @param fullBlob - The full-viewport PNG Blob from the screenshot library.
 * @param region - Target crop region.
 * @returns A PNG Blob sized `region.width × region.height`.
 */
async function cropBlob(fullBlob: Blob, region: CropRegion): Promise<Blob> {
  const bitmap = await createImageBitmap(fullBlob);
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = region.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('captureElement: 2D canvas context unavailable');
  }
  ctx.drawImage(bitmap, -region.x, -region.y);
  return canvasToPngBlob(canvas);
}

/**
 * Promise-wrap `HTMLCanvasElement.toBlob` so failures reject rather than
 * silently producing a `null`.
 *
 * @param canvas - Canvas to serialize.
 * @returns Promise resolving to a non-null PNG Blob.
 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

/**
 * Rasterize `el` to a PNG `Blob` whose pixel rectangle matches
 * `el.getBoundingClientRect()` inflated by {@link ELEMENT_PADDING_PX} on every
 * side (clamped to the viewport). The inspector overlay is hidden during the
 * capture via both the library's `filter` predicate and a
 * `visibility: hidden` toggle on `#forjis-inspector-root` (FR-009-009).
 *
 * On any thrown error the function logs `console.warn` and resolves to a
 * 1×1 transparent PNG from {@link createFallbackPng} — a wire-valid fallback
 * that keeps the Pin shape intact (FR-009-001 "Capture failure returns a
 * fallback blob").
 *
 * @param el - Element to screenshot.
 * @returns Promise resolving to a PNG `Blob` with `type === "image/png"`.
 */
export async function captureElement(el: Element): Promise<Blob> {
  try {
    const region = computeCropRegion(el);
    const fullBlob = await withOverlayHidden(() =>
      domToBlob(document.documentElement, {
        filter: buildOverlayFilter(),
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        type: 'image/png',
        quality: 1,
      }),
    );
    return await cropBlob(fullBlob, region);
  } catch (err) {
    console.warn('forjis-inspector: captureElement failed', err);
    return createFallbackPng();
  }
}
