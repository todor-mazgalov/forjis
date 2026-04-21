/**
 * Viewport screenshot capture with a visible bbox marker.
 *
 * `captureViewport(markedBbox)` rasterizes the full viewport into a PNG and
 * overlays a conspicuous stroked rectangle at `markedBbox` so that
 * downstream reviewers immediately see which region the pin refers to. The
 * underlying screenshot library is the same `modern-screenshot.domToBlob`
 * adapter used by `captureElement` (design.md §D-004). The inspector overlay
 * is excluded from the raster via both the library filter and the shared
 * `visibility: hidden` toggle (FR-009-009).
 */

import type { Bbox } from '@forjis/shared';
import { domToBlob } from 'modern-screenshot';
import { createFallbackPng } from './fallback-png.js';
import { buildOverlayFilter, withOverlayHidden } from './overlay-hide.js';

/** Marker rectangle stroke color — matches the overlay pending highlight. */
const MARKER_STROKE_COLOR = '#EA580C';

/** Marker rectangle stroke width (canvas pixels). */
const MARKER_STROKE_WIDTH = 3;

/**
 * Draw the marker rectangle onto a 2D canvas already showing the raw
 * viewport screenshot.
 *
 * @param ctx - Canvas 2D rendering context.
 * @param bbox - Pin bbox in viewport-pixel coordinates.
 */
function drawMarkerRect(
  ctx: CanvasRenderingContext2D,
  bbox: Bbox,
): void {
  ctx.strokeStyle = MARKER_STROKE_COLOR;
  ctx.lineWidth = MARKER_STROKE_WIDTH;
  ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
}

/**
 * Promise-wrap `HTMLCanvasElement.toBlob`; a `null` blob rejects.
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
 * Composite the raw viewport PNG onto an off-screen canvas and paint the
 * marker rectangle over it.
 *
 * @param rawBlob - The raw viewport PNG from the screenshot library.
 * @param markedBbox - Pin bbox to stroke.
 * @returns PNG Blob sized to the current viewport.
 */
async function compositeMarkedViewport(
  rawBlob: Blob,
  markedBbox: Bbox,
): Promise<Blob> {
  const bitmap = await createImageBitmap(rawBlob);
  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('captureViewport: 2D canvas context unavailable');
  }
  ctx.drawImage(bitmap, 0, 0);
  drawMarkerRect(ctx, markedBbox);
  return canvasToPngBlob(canvas);
}

/**
 * Rasterize the current viewport to a PNG `Blob` with a conspicuous stroked
 * rectangle painted over `markedBbox`. The inspector overlay is excluded
 * from the output (FR-009-009).
 *
 * On any thrown error the function logs `console.warn` and resolves to a
 * 1×1 transparent PNG from `createFallbackPng` so the Pin pipeline still
 * produces a wire-valid payload (FR-009-001 fallback scenario).
 *
 * @param markedBbox - Pin bbox in viewport-pixel coordinates.
 * @returns Promise resolving to a PNG `Blob` with `type === "image/png"`.
 */
export async function captureViewport(markedBbox: Bbox): Promise<Blob> {
  try {
    const rawBlob = await withOverlayHidden(() =>
      domToBlob(document.documentElement, {
        filter: buildOverlayFilter(),
        width: window.innerWidth,
        height: window.innerHeight,
        type: 'image/png',
        quality: 1,
      }),
    );
    return await compositeMarkedViewport(rawBlob, markedBbox);
  } catch (err) {
    console.warn('forjis-inspector: captureViewport failed', err);
    return createFallbackPng();
  }
}
