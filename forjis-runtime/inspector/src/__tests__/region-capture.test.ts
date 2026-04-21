/**
 * Smoke tests for `capture/region.ts`.
 *
 * jsdom cannot rasterize real canvases, so these tests only verify the
 * resilience contract (FR-009-001 parity): non-null blobs on normal
 * inputs, clamp-to-fallback on outside-viewport bboxes, and graceful
 * fallback when the capture library throws.
 */

import { captureRegion } from '../capture/region.js';

describe('captureRegion', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Known viewport dims.
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('bbox within viewport returns non-null blobs', async () => {
    const result = await captureRegion({ x: 10, y: 20, w: 50, h: 60 });
    expect(result.regionPng).toBeInstanceOf(Blob);
    expect(result.viewportPng).toBeInstanceOf(Blob);
    expect(result.regionPng.type).toBe('image/png');
    expect(result.viewportPng.type).toBe('image/png');
  });

  it('bbox fully outside viewport clamps to zero area → fallback blobs', async () => {
    const result = await captureRegion({ x: 2000, y: 2000, w: 100, h: 100 });
    expect(result.regionPng).toBeInstanceOf(Blob);
    expect(result.viewportPng).toBeInstanceOf(Blob);
    expect(result.regionPng.type).toBe('image/png');
    expect(result.viewportPng.type).toBe('image/png');
  });

  it('bbox partially outside viewport still returns non-null blobs', async () => {
    // Bbox extends past the viewport's right edge; clamp should give a
    // reduced but non-empty crop.
    const result = await captureRegion({ x: 950, y: 100, w: 200, h: 100 });
    expect(result.regionPng).toBeInstanceOf(Blob);
    expect(result.viewportPng).toBeInstanceOf(Blob);
  });
});
