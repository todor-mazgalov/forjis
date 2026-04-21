/**
 * Unit tests for `pipeline.ts`'s `buildPin`. Feeds hand-crafted PNG blobs so
 * the tests bypass the screenshot library entirely (jsdom cannot render real
 * canvas content — see exploration §R-001). Assertions cover the full wire
 * shape: id format, ISO-8601 round-trip, platform, screen, base64 prefix on
 * both screenshot fields, JSON-parseable computed styles, target
 * pass-through with `data-forjis-src` preservation, annotation equality,
 * comment pass-through, and `parentPinId === null`.
 */

import type { Annotation, PinSource, PinTarget } from '@forjis/shared';
import { readSourceInfo } from '../pick/source-info.js';
import { buildPin } from '../pipeline.js';

/** Base64-encoded 1×1 transparent PNG used as the stub payload. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

/**
 * Build a small PNG Blob for test fixtures.
 *
 * @returns Fresh `Blob` of `image/png` type holding a 1×1 transparent PNG.
 */
function makeStubPng(): Blob {
  const binary = atob(PNG_1X1_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'image/png' });
}

/** Produce a deterministic `PinTarget` for assertions. */
function makeTarget(source: PinSource | null): PinTarget {
  return {
    kind: 'element',
    source,
    selector: 'html > body > div:nth-of-type(1)',
    componentName: 'Widget',
    bbox: { x: 10, y: 20, w: 100, h: 50 },
  };
}

describe('buildPin', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('produces a Pin whose fields match the frozen wire shape', async () => {
    const target = makeTarget({ file: 'src/App.tsx', line: 12, col: 4 });
    const annotations: Annotation[] = [
      { kind: 'box', bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const computedStyles = { color: 'rgb(255, 0, 0)', display: 'block' };
    const pin = await buildPin(target, 'needs padding', annotations, {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles,
    });
    expect(pin.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Date(pin.createdAt).toISOString()).toBe(pin.createdAt);
    expect(pin.platform).toBe('web');
    expect(pin.screen).toBe(window.location.pathname);
    expect(pin.capture.elementScreenshot.startsWith('data:image/png;base64,')).toBe(true);
    expect(pin.capture.viewportScreenshot.startsWith('data:image/png;base64,')).toBe(true);
    expect(JSON.parse(pin.capture.computedStyles)).toEqual(computedStyles);
    expect(pin.capture.annotations).toEqual(annotations);
    expect(pin.capture.annotations).not.toBe(annotations);
    expect(pin.target).toEqual(target);
    expect(pin.comment).toBe('needs padding');
    expect(pin.parentPinId).toBeNull();
    expect(pin.commentGroupId).toBeNull();
  });

  it('threads commentGroupId and screen through from BuildPinOptions', async () => {
    const target = makeTarget(null);
    const pin = await buildPin(
      target,
      '',
      [],
      {
        elementPng: makeStubPng(),
        viewportPng: makeStubPng(),
        computedStyles: {},
      },
      { commentGroupId: 'group-42', screen: '/pin-time' },
    );
    expect(pin.commentGroupId).toBe('group-42');
    expect(pin.screen).toBe('/pin-time');
  });

  it('preserves target.source taken from data-forjis-src', async () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', 'src/App.tsx:12:4');
    document.body.appendChild(el);
    const source = readSourceInfo(el);
    expect(source).toEqual({ file: 'src/App.tsx', line: 12, col: 4 });
    const target = makeTarget(source);
    const pin = await buildPin(target, '', [], {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    expect(pin.target.source).toEqual({ file: 'src/App.tsx', line: 12, col: 4 });
  });

  it('FR-011-024 — parentPinId threads through to the pin', async () => {
    const target = makeTarget(null);
    const pin = await buildPin(
      target,
      '',
      [],
      {
        elementPng: makeStubPng(),
        viewportPng: makeStubPng(),
        computedStyles: {},
      },
      { parentPinId: 'p-2' },
    );
    expect(pin.parentPinId).toBe('p-2');
  });

  it('FR-011-024 — omitted parentPinId defaults to null', async () => {
    const target = makeTarget(null);
    const pin = await buildPin(
      target,
      '',
      [],
      {
        elementPng: makeStubPng(),
        viewportPng: makeStubPng(),
        computedStyles: {},
      },
      { commentGroupId: 'g-1' },
    );
    expect(pin.parentPinId).toBeNull();
  });

  it('tolerates empty annotations and empty computed styles', async () => {
    const target = makeTarget(null);
    const pin = await buildPin(target, '', [], {
      elementPng: makeStubPng(),
      viewportPng: makeStubPng(),
      computedStyles: {},
    });
    expect(pin.capture.annotations).toEqual([]);
    expect(JSON.parse(pin.capture.computedStyles)).toEqual({});
  });
});
