/**
 * Integration test for the "Add another pin" multi-pin flow.
 *
 * Drives the comment-sheet factory directly (avoiding the annotation
 * canvas that requires a real 2D context) and asserts FR-010-016,
 * FR-010-017, FR-010-018: hide preserves state, group shares
 * `commentGroupId`, grouped pins share comment + annotations, solo pins
 * have null `commentGroupId`.
 */

import { jest } from '@jest/globals';
import type { Pin, PinTarget } from '@forjis/shared';
import { createCommentSheet } from '../ui/comment-sheet.js';

/** Simple PNG placeholder blob. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

/**
 * Build a stub PNG Blob.
 *
 * @returns A 1×1 transparent PNG `Blob`.
 */
function makePng(): Blob {
  const bin = atob(PNG_1X1);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * Build a deterministic element PinTarget.
 *
 * @param id - Selector suffix.
 * @returns PinTarget.
 */
function makeTarget(id: string): PinTarget {
  return {
    kind: 'element',
    source: null,
    selector: '#' + id,
    componentName: null,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
  };
}

describe('multi-pin flow', () => {
  let host: HTMLDivElement;
  let shadow: ShadowRoot;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    // Stub URL.createObjectURL / revokeObjectURL for jsdom.
    Object.defineProperty(URL, 'createObjectURL', {
      value: jest.fn((blob: Blob) => 'blob:' + (blob.type || 'x')),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: jest.fn(),
      configurable: true,
    });
    // Stub canvas.getContext so annotation-canvas doesn't blow up.
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: jest.fn(() => ({
        clearRect: jest.fn(),
        drawImage: jest.fn(),
        strokeRect: jest.fn(),
        fillRect: jest.fn(),
        beginPath: jest.fn(),
        moveTo: jest.fn(),
        lineTo: jest.fn(),
        stroke: jest.fn(),
        fillText: jest.fn(),
        save: jest.fn(),
        restore: jest.fn(),
        setLineDash: jest.fn(),
        translate: jest.fn(),
        rotate: jest.fn(),
        arc: jest.fn(),
        fill: jest.fn(),
        closePath: jest.fn(),
      })),
      configurable: true,
      writable: true,
    });
  });

  it('hide preserves textarea and annotation handle; re-open via addPinToGroup (FR-010-016)', () => {
    const submitted: Pin[] = [];
    const onAdd = jest.fn();
    const handle = createCommentSheet({
      shadow,
      onSubmit: (pin) => {
        submitted.push(pin);
      },
      onCancel: jest.fn(),
      onAddAnotherPin: onAdd,
    });
    handle.open({
      target: makeTarget('el-1'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: { color: 'red' },
      screen: '/a',
    });
    expect(handle.isOpen()).toBe(true);
    // Type into the textarea.
    const textarea = shadow.querySelector<HTMLTextAreaElement>(
      '.comment-sheet textarea',
    );
    if (textarea) {
      textarea.value = 'my comment';
    }
    // Simulate "Add another pin" click.
    const addBtn = shadow.querySelector<HTMLButtonElement>(
      'button[data-action="add-another"]',
    );
    addBtn?.click();
    expect(onAdd).toHaveBeenCalledTimes(1);
    // Sheet hidden but state preserved.
    const root = shadow.querySelector('.comment-sheet');
    expect(root?.getAttribute('data-open')).toBe('false');
    expect(handle.isOpen()).toBe(true);
    // Pick a second pin → addPinToGroup.
    handle.addPinToGroup({
      target: makeTarget('el-2'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: { color: 'blue' },
      screen: '/a',
    });
    // Sheet re-shown, textarea buffer restored.
    expect(root?.getAttribute('data-open')).toBe('true');
    const textarea2 = shadow.querySelector<HTMLTextAreaElement>(
      '.comment-sheet textarea',
    );
    expect(textarea2?.value).toBe('my comment');
    handle.destroy();
  });

  it('Send with two grouped pins emits two pins sharing commentGroupId + comment (FR-010-017, FR-010-018)', async () => {
    const submitted: Pin[] = [];
    const handle = createCommentSheet({
      shadow,
      onSubmit: (pin) => {
        submitted.push(pin);
      },
      onCancel: jest.fn(),
      onAddAnotherPin: jest.fn(),
    });
    handle.open({
      target: makeTarget('el-1'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: { color: 'red' },
      screen: '/a',
    });
    const textarea = shadow.querySelector<HTMLTextAreaElement>(
      '.comment-sheet textarea',
    );
    if (textarea) {
      textarea.value = 'group comment';
    }
    shadow
      .querySelector<HTMLButtonElement>('button[data-action="add-another"]')
      ?.click();
    handle.addPinToGroup({
      target: makeTarget('el-2'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: { color: 'blue' },
      screen: '/b',
    });
    // Click Send and wait for all async emissions.
    const sendBtn = shadow.querySelector<HTMLButtonElement>(
      'button[data-action="send"]',
    );
    sendBtn?.click();
    // Wait for the async send loop to complete (two buildPin awaits).
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toHaveLength(2);
    expect(submitted[0].commentGroupId).not.toBeNull();
    expect(submitted[0].commentGroupId).toBe(submitted[1].commentGroupId);
    expect(submitted[0].comment).toBe('group comment');
    expect(submitted[1].comment).toBe('group comment');
    // Distinct targets.
    expect(submitted[0].target.selector).toBe('#el-1');
    expect(submitted[1].target.selector).toBe('#el-2');
    // Distinct ids.
    expect(submitted[0].id).not.toBe(submitted[1].id);
    // Pin screens preserve pick-time values (FR-010-031).
    expect(submitted[0].screen).toBe('/a');
    expect(submitted[1].screen).toBe('/b');
    // FR-010-018 annotations parity: both pins carry an annotations array
    // (JSON-string deep-equal covers the empty-array baseline from the
    // stubbed canvas as well as any future non-empty case the sheet
    // snapshots once and slices into each pin).
    expect(submitted[0].capture.annotations).toEqual(
      submitted[1].capture.annotations,
    );
    handle.destroy();
  });

  it('Solo pin (no Add another) has commentGroupId === null (FR-010-017 scenario 2)', async () => {
    const submitted: Pin[] = [];
    const handle = createCommentSheet({
      shadow,
      onSubmit: (pin) => {
        submitted.push(pin);
      },
      onCancel: jest.fn(),
      onAddAnotherPin: jest.fn(),
    });
    handle.open({
      target: makeTarget('solo'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: {},
      screen: '/solo',
    });
    const textarea = shadow.querySelector<HTMLTextAreaElement>(
      '.comment-sheet textarea',
    );
    if (textarea) {
      textarea.value = 'solo';
    }
    shadow
      .querySelector<HTMLButtonElement>('button[data-action="send"]')
      ?.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].commentGroupId).toBeNull();
    handle.destroy();
  });

  it('Group-count badge becomes visible after addPinToGroup', () => {
    const handle = createCommentSheet({
      shadow,
      onSubmit: jest.fn(),
      onCancel: jest.fn(),
      onAddAnotherPin: jest.fn(),
    });
    handle.open({
      target: makeTarget('el-1'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: {},
      screen: '/a',
    });
    const badge = shadow.querySelector<HTMLElement>('.group-count');
    expect(badge?.getAttribute('data-visible')).toBe('false');
    shadow
      .querySelector<HTMLButtonElement>('button[data-action="add-another"]')
      ?.click();
    handle.addPinToGroup({
      target: makeTarget('el-2'),
      elementBlob: makePng(),
      viewportBlob: makePng(),
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      computedStyles: {},
      screen: '/a',
    });
    expect(badge?.getAttribute('data-visible')).toBe('true');
    expect(badge?.textContent).toBe('2 pins');
    handle.destroy();
  });
});
