/**
 * Unit tests for `matchScore` and `detectReplyCandidate`.
 *
 * Covers FR-011-019 (weighted signals, null-safety) and FR-011-020
 * (threshold gate, empty-history, tie-breaker) plus the module-boundary
 * scan for NFR-011-002.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Batch, Pin } from '@forjis/shared';
import {
  REPLY_DETECT_THRESHOLD,
  detectReplyCandidate,
  matchScore,
} from '../reply/reply-detect.js';
import type { HistoryEntry } from '../history/storage.js';

/** Construct a Pin for score assertions. */
function makePin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: 'p-test',
    platform: 'web',
    screen: '/a',
    target: {
      kind: 'element',
      source: null,
      selector: '.t',
      componentName: null,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: '',
      viewportScreenshot: '',
      computedStyles: '{}',
      annotations: [],
    },
    comment: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentPinId: null,
    commentGroupId: null,
    ...overrides,
  };
}

/** Create a DOM element with optional attributes / innerText. */
function makeElement(attrs: {
  src?: string;
  component?: string;
  text?: string;
}): HTMLElement {
  const el = document.createElement('div');
  if (attrs.src !== undefined) {
    el.setAttribute('data-forjis-src', attrs.src);
  }
  if (attrs.component !== undefined) {
    el.setAttribute('data-forjis-component', attrs.component);
  }
  if (attrs.text !== undefined) {
    el.textContent = attrs.text;
  }
  document.body.appendChild(el);
  return el;
}

/** Wrap a batch into a single HistoryEntry. */
function makeEntry(
  batch: Batch,
  summary: string | null = null,
  taskPath = '/tmp/t',
): HistoryEntry {
  return {
    batch,
    taskPath,
    summary,
    finalizedAt: '2026-04-22T10:00:00.000Z',
  };
}

/** Build a batch containing the supplied pins. */
function makeBatch(pins: Pin[]): Batch {
  return {
    id: 'b-test',
    platform: 'web',
    screens: ['/a'],
    pins,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status: 'done',
  };
}

describe('reply-detect', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('FR-011-019 — all three signals match yield 1.0', () => {
    const pin = makePin({
      target: {
        kind: 'element',
        source: { file: 'src/App.tsx', line: 12, col: 4 },
        selector: '#x',
        componentName: 'Footer',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'the SIGN UP button looks wrong',
    });
    const el = makeElement({
      src: 'src/App.tsx:12:4',
      component: 'footer',
      text: 'sign up',
    });
    expect(matchScore(pin, el)).toBeCloseTo(1.0);
  });

  it('FR-011-019 — source-only match yields 0.4', () => {
    const pin = makePin({
      target: {
        kind: 'element',
        source: { file: 'src/App.tsx', line: 1, col: 1 },
        selector: '#x',
        componentName: 'Header',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'unrelated text',
    });
    const el = makeElement({
      src: 'src/App.tsx:99:4',
      component: 'Sidebar',
      text: 'hello',
    });
    expect(matchScore(pin, el)).toBeCloseTo(0.4);
  });

  it('FR-011-019 — component-only match (case-insensitive) yields 0.3', () => {
    const pin = makePin({
      target: {
        kind: 'element',
        source: null,
        selector: '#x',
        componentName: 'Footer',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'unrelated',
    });
    const el = makeElement({ component: 'FOOTER', text: 'x' });
    expect(matchScore(pin, el)).toBeCloseTo(0.3);
  });

  it('FR-011-019 — text-only match via pin.comment substring yields 0.3', () => {
    const pin = makePin({
      target: {
        kind: 'element',
        source: null,
        selector: '#x',
        componentName: null,
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'please fix the Sign Up button',
    });
    const el = makeElement({ text: 'sign up' });
    expect(matchScore(pin, el)).toBeCloseTo(0.3);
  });

  it('FR-011-019 — no match yields 0', () => {
    const pin = makePin({ comment: 'foo' });
    const el = makeElement({ text: 'bar' });
    expect(matchScore(pin, el)).toBe(0);
  });

  it('FR-011-019 — null source and missing data-forjis-src does not throw; returns [0,1]', () => {
    const pin = makePin({
      target: {
        kind: 'element',
        source: null,
        selector: '#x',
        componentName: null,
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: '',
    });
    const el = makeElement({});
    const s = matchScore(pin, el);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('FR-011-020 — detectReplyCandidate returns a candidate when score ≥ threshold', () => {
    const pin = makePin({
      id: 'p-hit',
      target: {
        kind: 'element',
        source: { file: 'src/App.tsx', line: 12, col: 4 },
        selector: '#x',
        componentName: 'Footer',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'the SIGN UP button',
    });
    const history = [makeEntry(makeBatch([pin]))];
    const el = makeElement({
      src: 'src/App.tsx:12:4',
      component: 'footer',
      text: 'sign up',
    });
    const cand = detectReplyCandidate(el, history);
    expect(cand).not.toBeNull();
    expect(cand?.pin.id).toBe('p-hit');
    expect(cand?.score).toBeGreaterThanOrEqual(REPLY_DETECT_THRESHOLD);
  });

  it('FR-011-020 — returns null when every score is below threshold', () => {
    const pin = makePin({
      target: {
        kind: 'element',
        source: null,
        selector: '#x',
        componentName: 'Footer',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: '',
    });
    // Element only matches component (0.3).
    const el = makeElement({ component: 'Footer' });
    const history = [makeEntry(makeBatch([pin]))];
    expect(detectReplyCandidate(el, history)).toBeNull();
  });

  it('FR-011-020 — empty history returns null', () => {
    const el = makeElement({ component: 'x' });
    expect(detectReplyCandidate(el, [])).toBeNull();
  });

  it('FR-011-020 — tie-breaker: 0.8 beats 0.75', () => {
    // Pin A scores source+component = 0.7 (just below).
    const pinA = makePin({
      id: 'p-a',
      target: {
        kind: 'element',
        source: { file: 'src/X.tsx', line: 1, col: 1 },
        selector: '.a',
        componentName: 'Alpha',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'nothing',
    });
    // Pin B scores source+component+text-on-comment = 1.0.
    const pinB = makePin({
      id: 'p-b',
      target: {
        kind: 'element',
        source: { file: 'src/X.tsx', line: 1, col: 1 },
        selector: '.b',
        componentName: 'Alpha',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      comment: 'click the CTA now',
    });
    const history = [makeEntry(makeBatch([pinA, pinB]))];
    const el = makeElement({
      src: 'src/X.tsx:1:1',
      component: 'alpha',
      text: 'cta',
    });
    const cand = detectReplyCandidate(el, history);
    expect(cand?.pin.id).toBe('p-b');
    expect(cand?.score).toBeGreaterThan(0.75);
  });

  it('NFR-011-002 — source contains no transport / mount / WebSocket imports', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/reply/reply-detect.ts'),
      'utf-8',
    );
    expect(/from\s+['"][^'"]*transport/.test(src)).toBe(false);
    expect(/from\s+['"][^'"]*mount/.test(src)).toBe(false);
    expect(/new\s+WebSocket\(/.test(src)).toBe(false);
  });
});
