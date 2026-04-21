/**
 * 1×1 transparent PNG fallback blob used by `captureElement` and
 * `captureViewport` when the underlying screenshot library throws. Shipping a
 * wire-valid but blank capture keeps the Pin shape correct and surfaces the
 * problem to the clarifier/reviewer downstream rather than dead-ending the
 * SDK (design.md §D-003 step 7; FR-009-001 "Capture failure returns a
 * fallback blob").
 */

/** Base64-encoded 1×1 fully transparent PNG (67 bytes before encoding). */
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

/**
 * Decode a base64 string into a fresh `ArrayBuffer`. Uses the built-in `atob`
 * binding available in browsers and jsdom; no Buffer dependency. Returning a
 * plain `ArrayBuffer` (not `Uint8Array`) sidesteps the
 * `ArrayBufferLike | SharedArrayBuffer` widening that newer TypeScript lib
 * definitions apply to `TypedArray.buffer`.
 *
 * @param base64 - Plain (non-data-URL) base64 string.
 * @returns Freshly-allocated buffer holding the decoded bytes.
 */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Build a fresh fallback PNG `Blob`.
 *
 * @returns A `Blob` whose `type === "image/png"` and whose payload is a
 *   1×1 fully transparent PNG.
 */
export function createFallbackPng(): Blob {
  return new Blob([base64ToBuffer(TRANSPARENT_PNG_BASE64)], {
    type: 'image/png',
  });
}
