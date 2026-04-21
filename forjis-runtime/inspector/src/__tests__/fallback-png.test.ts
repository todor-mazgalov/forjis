/**
 * Unit tests for `capture/fallback-png.ts`. The fallback Blob guarantees that
 * `captureElement` / `captureViewport` always resolve to a wire-valid PNG —
 * spec FR-009-001 "Capture failure returns a fallback blob". These tests
 * assert the MIME type, non-zero size, and freshness (each call returns a new
 * Blob so downstream consumers can revoke object URLs without cross-talk).
 */

import { createFallbackPng } from '../capture/fallback-png.js';

describe('createFallbackPng (FR-009-001 fallback)', () => {
  it('returns a Blob whose type is image/png', () => {
    // Arrange + Act
    const blob = createFallbackPng();
    // Assert
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });

  it('returns a non-empty payload', () => {
    // Arrange + Act
    const blob = createFallbackPng();
    // Assert — the 1×1 transparent PNG is ~67 bytes, so any positive size is
    // enough to prove the base64 decoded to real content.
    expect(blob.size).toBeGreaterThan(0);
  });

  it('returns a fresh Blob on each call (no shared object identity)', () => {
    // Arrange + Act
    const a = createFallbackPng();
    const b = createFallbackPng();
    // Assert
    expect(a).not.toBe(b);
  });
});
