/**
 * Additional invariant tests for `pipeline.ts`'s `buildPin`. The existing
 * `pipeline.test.ts` covers the canonical wire-shape assertions; this file
 * drills into the narrow invariants that downstream consumers rely on:
 *
 *   - Both screenshot strings start with the exact `data:image/png;base64,`
 *     prefix (FR-009-006 "Screenshot fields are base64 data URLs").
 *   - `target` is threaded through `buildPin` without mutation — the SDK must
 *     NOT re-read `data-forjis-src` or otherwise rewrite the caller's target
 *     (FR-009-011 "target.source passes through unchanged").
 *   - `pin.capture.annotations` is a fresh array (defensive copy), so a later
 *     mutation of the caller's array cannot corrupt the emitted pin
 *     (FR-009-006 "Annotations pass through unchanged" requires equality;
 *     the defensive-copy invariant is the SDK-side belt-and-braces).
 *   - `pin.screen` is read at call time (`location.pathname`).
 */

import type { Annotation, PinSource, PinTarget } from '@forjis/shared';
import { buildPin } from '../pipeline.js';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

/**
 * Build a minimal PNG Blob for the pipeline tests.
 *
 * @returns PNG `Blob` holding a 1×1 transparent pixel.
 */
function makeStubPng(): Blob {
  const binary = atob(PNG_1X1_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * Construct a deterministic `PinTarget` for the tests.
 *
 * @param source - `PinSource` or `null` to thread through.
 * @returns A fresh `PinTarget` with a stable selector/bbox.
 */
function makeTarget(source: PinSource | null): PinTarget {
  return {
    kind: 'element',
    source,
    selector: 'html > body > div:nth-of-type(1)',
    componentName: 'Widget',
    bbox: { x: 10, y: 20, w: 100, h: 50 },
  };
}

describe('buildPin invariants', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('base64 prefix matches exactly on both screenshot fields (FR-009-006)', async () => {
    // Arrange
    const target = makeTarget(null);
    // Act
    const pin = await buildPin(target, '', [], {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    // Assert — exact literal prefix required by the spec. The tail is the
    // base64 payload returned by FileReader; we only assert the prefix.
    const prefix = 'data:image/png;base64,';
    expect(pin.capture.elementScreenshot.startsWith(prefix)).toBe(true);
    expect(pin.capture.viewportScreenshot.startsWith(prefix)).toBe(true);
    // Prefix must be followed by actual base64 content, not an empty string.
    expect(pin.capture.elementScreenshot.length).toBeGreaterThan(prefix.length);
    expect(pin.capture.viewportScreenshot.length).toBeGreaterThan(prefix.length);
  });

  it('threads target through unchanged — no re-read of data-forjis-src (FR-009-011)', async () => {
    // Arrange — mount an element whose `data-forjis-src` disagrees with the
    // explicit `source` passed in the target. If `buildPin` re-read the
    // attribute, pin.target.source would drift to the attribute value.
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', 'src/Other.tsx:99:9');
    document.body.appendChild(el);
    const target = makeTarget({ file: 'src/App.tsx', line: 12, col: 4 });
    // Act
    const pin = await buildPin(target, '', [], {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    // Assert — the target we passed in is exactly what we get back.
    expect(pin.target.source).toEqual({
      file: 'src/App.tsx',
      line: 12,
      col: 4,
    });
    // And the full target object is deeply equal.
    expect(pin.target).toEqual(target);
  });

  it('copies annotations defensively so later caller mutations do not leak (FR-009-006)', async () => {
    // Arrange
    const target = makeTarget(null);
    const annotations: Annotation[] = [
      { kind: 'box', bbox: { x: 1, y: 2, w: 3, h: 4 } },
    ];
    // Act
    const pin = await buildPin(target, 'c', annotations, {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    // Mutate the caller's array after the pin was produced.
    annotations.push({ kind: 'box', bbox: { x: 9, y: 9, w: 9, h: 9 } });
    // Assert — the pin's copy is untouched.
    expect(pin.capture.annotations).toHaveLength(1);
    expect(pin.capture.annotations[0]).toEqual({
      kind: 'box',
      bbox: { x: 1, y: 2, w: 3, h: 4 },
    });
  });

  it('reads location.pathname at call time for pin.screen', async () => {
    // Arrange
    const target = makeTarget(null);
    // Act
    const pin = await buildPin(target, '', [], {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    // Assert
    expect(pin.screen).toBe(window.location.pathname);
  });

  it('stamps parentPinId = null and platform = "web" (wire invariants)', async () => {
    // Arrange
    const target = makeTarget(null);
    // Act
    const pin = await buildPin(target, '', [], {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    // Assert
    expect(pin.parentPinId).toBeNull();
    expect(pin.platform).toBe('web');
  });
});
