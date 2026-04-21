/**
 * Region capture (design.md §D-006, FR-010-015).
 *
 * Rasterizes the full viewport via `modern-screenshot`, clamps the
 * caller-supplied document-coord bbox to the current viewport rectangle,
 * and crops the viewport PNG to the clamped region. Returns both the
 * cropped region PNG and the full-viewport PNG so the comment sheet can
 * populate the element preview with the region crop while using the
 * viewport raster as the annotation-canvas background.
 *
 * On any thrown error (or zero-area clamp) the function logs `console.warn`
 * and returns wire-valid fallback PNGs via `createFallbackPng()`
 * (FR-009-001 parity).
 */

import { domToBlob } from 'modern-screenshot';
import type { Bbox } from '@forjis/shared';
import { createFallbackPng } from './fallback-png.js';
import { buildOverlayFilter, withOverlayHidden } from './overlay-hide.js';

/** Region capture result bundle. */
export interface RegionCaptureResult {
  /** Cropped PNG for the region inside the viewport. */
  readonly regionPng: Blob;
  /** Full-viewport PNG (overlay filtered out). */
  readonly viewportPng: Blob;
}

/**
 * Target crop region in viewport pixel space after document→viewport
 * translation and clamping.
 */
interface ViewportCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Translate `bboxDoc` (document coordinates) into viewport coordinates and
 * clamp to the current viewport rectangle. Returns `null` when the clamp
 * yields a zero-area crop.
 *
 * @param bboxDoc - Document-coord bbox from the region picker.
 * @returns Viewport-coord crop region or `null` when fully outside.
 */
function translateAndClamp(bboxDoc: Bbox): ViewportCrop | null {
  const scrollX = typeof window.scrollX === 'number' ? window.scrollX : 0;
  const scrollY = typeof window.scrollY === 'number' ? window.scrollY : 0;
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const vx = bboxDoc.x - scrollX;
  const vy = bboxDoc.y - scrollY;
  const left = Math.max(0, Math.floor(vx));
  const top = Math.max(0, Math.floor(vy));
  const right = Math.min(viewportW, Math.ceil(vx + bboxDoc.w));
  const bottom = Math.min(viewportH, Math.ceil(vy + bboxDoc.h));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x: left, y: top, width, height };
}

/**
 * Promise-wrap `HTMLCanvasElement.toBlob` so failures reject instead of
 * silently returning `null`.
 *
 * @param canvas - Canvas to serialize.
 * @returns Promise resolving to a PNG `Blob`.
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
 * Crop the viewport PNG to the supplied viewport-space region via an
 * off-screen 2D canvas.
 *
 * @param viewportBlob - Full-viewport PNG.
 * @param region - Clamped viewport crop.
 * @returns PNG `Blob` sized `region.width × region.height`.
 */
async function cropViewport(
  viewportBlob: Blob,
  region: ViewportCrop,
): Promise<Blob> {
  const bitmap = await createImageBitmap(viewportBlob);
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = region.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('captureRegion: 2D canvas context unavailable');
  }
  ctx.drawImage(bitmap, -region.x, -region.y);
  return canvasToPngBlob(canvas);
}

/**
 * Build a `{ regionPng, viewportPng }` result using fallback PNGs for both
 * slots. Used when the capture path throws or the bbox clamps to an empty
 * rect.
 *
 * @returns Region-capture result populated with 1×1 transparent PNGs.
 */
function fallbackResult(): RegionCaptureResult {
  return {
    regionPng: createFallbackPng(),
    viewportPng: createFallbackPng(),
  };
}

/**
 * Capture a region screenshot bundle. Uses `withOverlayHidden` to exclude
 * the inspector overlay from the raster, translates the document-coord
 * bbox back to viewport coords at capture time, clamps to the viewport,
 * and crops the viewport PNG.
 *
 * @param bboxDoc - Document-coord bbox from the region picker.
 * @returns Promise resolving to the region + viewport PNG blobs.
 */
export async function captureRegion(
  bboxDoc: Bbox,
): Promise<RegionCaptureResult> {
  try {
    const region = translateAndClamp(bboxDoc);
    if (region === null) {
      return fallbackResult();
    }
    const viewportBlob = await withOverlayHidden(() =>
      domToBlob(document.documentElement, {
        filter: buildOverlayFilter(),
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        type: 'image/png',
        quality: 1,
      }),
    );
    const regionBlob = await cropViewport(viewportBlob, region);
    return { regionPng: regionBlob, viewportPng: viewportBlob };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('forjis-inspector: captureRegion failed', err);
    return fallbackResult();
  }
}
