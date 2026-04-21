/**
 * Unit tests for the reply-sheet factory.
 *
 * Covers FR-011-022 (header, summary placeholder, Send payload, empty
 * guard, no "Add another pin" control) and NFR-011-004 (44px tap targets).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Batch, Pin } from '@forjis/shared';
import {
  createReplySheet,
  type ReplySheetContext,
} from '../reply/reply-sheet.js';

/** Build a deterministic parent pin. */
function makePin(id: string): Pin {
  return {
    id,
    platform: 'web',
    screen: '/a',
    target: {
      kind: 'element',
      source: null,
      selector: '#' + id,
      componentName: 'Footer',
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,' + id,
      viewportScreenshot: 'data:image/png;base64,vp-' + id,
      computedStyles: '{}',
      annotations: [],
    },
    comment: 'original comment for ' + id,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentPinId: null,
    commentGroupId: null,
  };
}

/** Build a deterministic parent batch. */
function makeBatch(id: string, pins: Pin[]): Batch {
  return {
    id,
    platform: 'web',
    screens: ['/a'],
    pins,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status: 'done',
  };
}

/** Build a canonical context. */
function makeContext(summary: string | null = null): ReplySheetContext {
  const pin = makePin('p-2');
  const batch = makeBatch('b1234567-abcd-4abc-8def-0123456789ab', [pin]);
  return { pin, batch, taskPath: '/tmp/t', summary };
}

/** Attach a fresh shadow root. */
function attachShadow(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  return { host, shadow };
}

describe('reply-sheet', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
  });

  it('FR-011-022 — header contains "Reply to pin from batch b1234567"', () => {
    const { shadow } = attachShadow();
    const handle = createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => undefined,
    });
    handle.open(makeContext());
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const caption = root.querySelector('.reply-caption') as HTMLElement;
    expect(caption.textContent).toContain('Reply to pin from batch b1234567');
  });

  it('FR-011-022 — summary === null renders the placeholder', () => {
    const { shadow } = attachShadow();
    const handle = createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => undefined,
    });
    handle.open(makeContext(null));
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    expect(root.textContent).toContain('Agent diff summary unavailable');
  });

  it('FR-011-022 — non-null summary renders as-is', () => {
    const { shadow } = attachShadow();
    const handle = createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => undefined,
    });
    handle.open(makeContext('the real diff'));
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const summary = root.querySelector('.reply-summary') as HTMLElement;
    expect(summary.textContent).toBe('the real diff');
  });

  it('FR-011-022 — Send invokes onSubmitReply with parent linkage', () => {
    const { shadow } = attachShadow();
    const captured: unknown[] = [];
    const handle = createReplySheet({
      shadow,
      onSubmitReply: (p) => captured.push(p),
      onCancel: () => undefined,
    });
    handle.open(makeContext());
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const textarea = root.querySelector(
      '.reply-comment',
    ) as HTMLTextAreaElement;
    textarea.value = '  still broken  ';
    const sendBtn = root.querySelector('.reply-send-btn') as HTMLButtonElement;
    sendBtn.click();
    expect(captured).toEqual([
      {
        parentPinId: 'p-2',
        parentBatchId: 'b1234567-abcd-4abc-8def-0123456789ab',
        parentTaskPath: '/tmp/t',
        comment: 'still broken',
      },
    ]);
  });

  it('FR-011-022 — empty / whitespace-only Send is a no-op', () => {
    const { shadow } = attachShadow();
    const captured: unknown[] = [];
    const handle = createReplySheet({
      shadow,
      onSubmitReply: (p) => captured.push(p),
      onCancel: () => undefined,
    });
    handle.open(makeContext());
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const textarea = root.querySelector(
      '.reply-comment',
    ) as HTMLTextAreaElement;
    textarea.value = '   ';
    const sendBtn = root.querySelector('.reply-send-btn') as HTMLButtonElement;
    sendBtn.click();
    expect(captured).toHaveLength(0);
  });

  it('FR-011-022 — no "Add another pin" control is present', () => {
    const { shadow } = attachShadow();
    const handle = createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => undefined,
    });
    handle.open(makeContext());
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const anyAddAnother = Array.from(root.querySelectorAll('*')).some(
      (el) =>
        /add another pin/i.test(el.textContent ?? '') ||
        /add-another/i.test(
          (el as HTMLElement).getAttribute('data-action') ?? '',
        ),
    );
    expect(anyAddAnother).toBe(false);
  });

  it('FR-011-022 — Cancel invokes onCancel and closes the sheet', () => {
    const { shadow } = attachShadow();
    let cancelCount = 0;
    const handle = createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    handle.open(makeContext());
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const cancelBtn = root.querySelector(
      '.reply-cancel-btn',
    ) as HTMLButtonElement;
    cancelBtn.click();
    expect(cancelCount).toBe(1);
    expect(root.getAttribute('data-open')).toBe('false');
    expect(handle.isOpen()).toBe(false);
  });

  it('FR-011-022 — destroy is idempotent', () => {
    const { shadow } = attachShadow();
    const handle = createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => undefined,
    });
    handle.destroy();
    expect(shadow.querySelector('[data-forjis-reply-sheet]')).toBeNull();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('NFR-011-004 — Send button declares 44×44 tap target via inline CSS', () => {
    const { shadow } = attachShadow();
    createReplySheet({
      shadow,
      onSubmitReply: () => undefined,
      onCancel: () => undefined,
    });
    const root = shadow.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement;
    const styleEl = root.querySelector('style') as HTMLStyleElement;
    const css = styleEl.textContent ?? '';
    const re =
      /\.reply-send-btn[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s;
    expect(re.test(css)).toBe(true);
  });

  it('NFR-011-002 — source contains no transport / mount / WebSocket imports', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/reply/reply-sheet.ts'),
      'utf-8',
    );
    expect(/from\s+['"][^'"]*transport/.test(src)).toBe(false);
    expect(/from\s+['"][^'"]*mount/.test(src)).toBe(false);
    expect(/new\s+WebSocket\(/.test(src)).toBe(false);
  });
});
