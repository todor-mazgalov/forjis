/**
 * Unit tests for the sidebar factory.
 *
 * Covers FR-011-013 through FR-011-018, plus NFR-011-002 (no transport /
 * mount / WebSocket imports), NFR-011-003 (render budget for 20 entries ×
 * 10 pins), and NFR-011-004 (44px tap targets).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Batch, Pin } from '@forjis/shared';
import { createSidebar } from '../ui/sidebar.js';
import {
  __resetHistoryStoreForTests,
  pushBatch,
  updateSummary,
} from '../history/history-store.js';

/** Build a deterministic pin. */
function makePin(id: string, comment = 'c-' + id): Pin {
  return {
    id,
    platform: 'web',
    screen: '/' + id,
    target: {
      kind: 'element',
      source: null,
      selector: '#' + id,
      componentName: null,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,' + id,
      viewportScreenshot: 'data:image/png;base64,vp-' + id,
      computedStyles: '{}',
      annotations: [],
    },
    comment,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentPinId: null,
    commentGroupId: null,
  };
}

/** Build a batch with `pinCount` pins. */
function makeBatch(id: string, pinCount: number, status: Batch['status'] = 'done'): Batch {
  const pins: Pin[] = [];
  for (let i = 0; i < pinCount; i += 1) {
    pins.push(makePin(id + '-p-' + String(i)));
  }
  return {
    id,
    platform: 'web',
    screens: ['/a'],
    pins,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status,
  };
}

/** Attach a fresh shadow root. */
function attachShadow(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  return { host, shadow };
}

describe('sidebar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    __resetHistoryStoreForTests();
  });

  it('FR-011-013 — factory mounts into the shadow root; destroy is idempotent', () => {
    const { shadow } = attachShadow();
    const handle = createSidebar({ shadow, onReply: () => undefined });
    expect(shadow.querySelector('[data-forjis-sidebar]')).not.toBeNull();
    expect(document.body.querySelector('[data-forjis-sidebar]')).toBeNull();
    handle.destroy();
    expect(shadow.querySelector('[data-forjis-sidebar]')).toBeNull();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('FR-011-014 — two entries render newest first by finalizedAt', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    pushBatch(makeBatch('b-old', 1), '/tmp/old', '2026-04-22T10:00:00.000Z');
    pushBatch(makeBatch('b-new', 1), '/tmp/new', '2026-04-22T11:00:00.000Z');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const cards = root.querySelectorAll('.sidebar-batch-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-batch-id')).toBe('b-new');
    expect(cards[1].getAttribute('data-batch-id')).toBe('b-old');
  });

  it('FR-011-014 — empty history renders a visible empty-state element', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const empty = root.querySelector('.sidebar-empty') as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent?.toLowerCase()).toMatch(/no|empty/);
  });

  it('FR-011-015 — batch card with 3 pins shows exactly 2 thumbnails', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    pushBatch(makeBatch('b-3', 3), '/tmp/3');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const thumbs = root.querySelectorAll(
      '.sidebar-batch-card[data-batch-id="b-3"] .sidebar-thumbnails img',
    );
    expect(thumbs).toHaveLength(2);
    expect((thumbs[0] as HTMLImageElement).src).toContain('b-3-p-0');
    expect((thumbs[1] as HTMLImageElement).src).toContain('b-3-p-1');
  });

  it('FR-011-015 — batch card with 1 pin shows 1 thumbnail', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    pushBatch(makeBatch('b-1', 1), '/tmp/1');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const thumbs = root.querySelectorAll('.sidebar-thumbnails img');
    expect(thumbs).toHaveLength(1);
  });

  it('FR-011-015 — status dot differentiates failed from done', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    pushBatch(makeBatch('b-done', 1, 'done'), '/tmp/d');
    pushBatch(makeBatch('b-fail', 1, 'failed'), '/tmp/f');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const doneCard = root.querySelector(
      '.sidebar-batch-card[data-batch-id="b-done"] .sidebar-status-dot',
    );
    const failCard = root.querySelector(
      '.sidebar-batch-card[data-batch-id="b-fail"] .sidebar-status-dot',
    );
    expect(doneCard?.getAttribute('data-status')).toBe('done');
    expect(failCard?.getAttribute('data-status')).toBe('failed');
  });

  it('FR-011-016 — expand reveals 3 rows for a 3-pin batch; second click collapses', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    pushBatch(makeBatch('b-3', 3), '/tmp/3');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const expandBtn = root.querySelector(
      '.sidebar-batch-card[data-batch-id="b-3"] .sidebar-batch-expand',
    ) as HTMLButtonElement;
    expandBtn.click();
    let rows = root.querySelectorAll(
      '.sidebar-batch-card[data-batch-id="b-3"] .sidebar-pin-row',
    );
    expect(rows).toHaveLength(3);
    for (const row of Array.from(rows)) {
      expect(
        row.querySelector('[data-forjis-sidebar-reply]'),
      ).not.toBeNull();
    }
    const expandBtn2 = root.querySelector(
      '.sidebar-batch-card[data-batch-id="b-3"] .sidebar-batch-expand',
    ) as HTMLButtonElement;
    expandBtn2.click();
    rows = root.querySelectorAll(
      '.sidebar-batch-card[data-batch-id="b-3"] .sidebar-pin-row',
    );
    expect(rows).toHaveLength(0);
  });

  it('FR-011-017 — Reply control invokes onReply with correct pin/batch/taskPath/summary', () => {
    const { shadow } = attachShadow();
    const observed: unknown[] = [];
    createSidebar({
      shadow,
      onReply: (ctx) => observed.push(ctx),
    });
    pushBatch(makeBatch('b-42', 3), '/tmp/t');
    updateSummary('b-42', 'diff summary');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const expandBtn = root.querySelector(
      '.sidebar-batch-card[data-batch-id="b-42"] .sidebar-batch-expand',
    ) as HTMLButtonElement;
    expandBtn.click();
    const rows = root.querySelectorAll(
      '.sidebar-batch-card[data-batch-id="b-42"] .sidebar-pin-row',
    );
    const secondReply = rows[1].querySelector(
      '[data-forjis-sidebar-reply]',
    ) as HTMLButtonElement;
    secondReply.click();
    expect(observed).toHaveLength(1);
    const ctx = observed[0] as {
      pin: { id: string };
      batch: { id: string };
      taskPath: string;
      summary: string | null;
    };
    expect(ctx.pin.id).toBe('b-42-p-1');
    expect(ctx.batch.id).toBe('b-42');
    expect(ctx.taskPath).toBe('/tmp/t');
    expect(ctx.summary).toBe('diff summary');
  });

  it('FR-011-018 — pushBatch adds a card without external invocation', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    pushBatch(makeBatch('b-1', 1), '/tmp/t');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const cards = root.querySelectorAll('.sidebar-batch-card');
    expect(cards).toHaveLength(1);
  });

  it('FR-011-018 — updateSummary re-renders per-pin parent context so subsequent onReply carries the new summary', () => {
    const { shadow } = attachShadow();
    const observed: Array<string | null> = [];
    createSidebar({
      shadow,
      onReply: (ctx) => observed.push(ctx.summary),
    });
    pushBatch(makeBatch('b-42', 1), '/tmp/t');
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const expand = root.querySelector(
      '.sidebar-batch-card[data-batch-id="b-42"] .sidebar-batch-expand',
    ) as HTMLButtonElement;
    expand.click();
    updateSummary('b-42', 'new diff');
    // Re-expand the card (renders overwrote the expand set since expand was
    // preserved across re-renders via the closure Set); the subscribe path
    // preserves the expandedIds Set.
    const firstReply = root.querySelector(
      '[data-forjis-sidebar-reply]',
    ) as HTMLButtonElement;
    firstReply.click();
    expect(observed).toEqual(['new diff']);
  });

  it('NFR-011-002 — source contains no transport / mount / WebSocket imports', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/ui/sidebar.ts'),
      'utf-8',
    );
    expect(/from\s+['"][^'"]*transport/.test(src)).toBe(false);
    expect(/from\s+['"][^'"]*mount/.test(src)).toBe(false);
    expect(/new\s+WebSocket\(/.test(src)).toBe(false);
  });

  it('NFR-011-003 — rendering 20 entries with 10 pins each completes under 100 ms', () => {
    const { shadow } = attachShadow();
    // Pre-populate before creating sidebar to hit the initial render path.
    for (let i = 0; i < 20; i += 1) {
      pushBatch(
        makeBatch('b-' + String(i), 10),
        '/tmp/' + String(i),
        '2026-04-22T' + String(10 + Math.floor(i / 2)).padStart(2, '0') + ':' +
          String(i % 60).padStart(2, '0') +
          ':00.000Z',
      );
    }
    const start = performance.now();
    const handle = createSidebar({ shadow, onReply: () => undefined });
    const delta = performance.now() - start;
    expect(delta).toBeLessThan(100);
    handle.destroy();
  });

  it('NFR-011-004 — expand and Reply controls declare 44×44 tap targets via inline CSS', () => {
    const { shadow } = attachShadow();
    createSidebar({ shadow, onReply: () => undefined });
    const root = shadow.querySelector('[data-forjis-sidebar]') as HTMLElement;
    const styleEl = root.querySelector('style') as HTMLStyleElement;
    const css = styleEl.textContent ?? '';
    const classes = ['.sidebar-batch-expand', '.sidebar-pin-reply'];
    for (const cls of classes) {
      const re = new RegExp(
        cls.replace('.', '\\.') +
          '[^}]*min-width:\\s*44px[^}]*min-height:\\s*44px',
        's',
      );
      expect(re.test(css)).toBe(true);
    }
  });
});
