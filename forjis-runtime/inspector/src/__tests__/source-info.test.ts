/**
 * Unit tests for the `pick/source-info.ts` pure helpers. Each test resets the
 * document body so element queries are deterministic. The tests exercise
 * happy, walk-up, and malformed-input branches for every exported function.
 */

import {
  computeBbox,
  computeSelector,
  readComponentName,
  readSourceInfo,
} from '../pick/source-info.js';

describe('readSourceInfo', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('parses a valid triple on the target element', () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', '/src/App.tsx:42:7');
    document.body.appendChild(el);
    expect(readSourceInfo(el)).toEqual({ file: '/src/App.tsx', line: 42, col: 7 });
  });

  it('walks up to a parent carrying the attribute', () => {
    const parent = document.createElement('div');
    parent.setAttribute('data-forjis-src', '/src/Widget.tsx:10:4');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(readSourceInfo(child)).toEqual({
      file: '/src/Widget.tsx',
      line: 10,
      col: 4,
    });
  });

  it('walks up to a grandparent carrying the attribute', () => {
    const grand = document.createElement('section');
    grand.setAttribute('data-forjis-src', '/src/Grand.tsx:3:1');
    const mid = document.createElement('div');
    const child = document.createElement('span');
    grand.appendChild(mid);
    mid.appendChild(child);
    document.body.appendChild(grand);
    expect(readSourceInfo(child)?.file).toBe('/src/Grand.tsx');
  });

  it('returns null when no ancestor carries the attribute', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(readSourceInfo(el)).toBeNull();
  });

  it('returns null on an empty attribute', () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', '');
    document.body.appendChild(el);
    expect(readSourceInfo(el)).toBeNull();
  });

  it('returns null on non-triple input without throwing', () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', 'foo');
    document.body.appendChild(el);
    expect(() => readSourceInfo(el)).not.toThrow();
    expect(readSourceInfo(el)).toBeNull();
  });

  it('returns null on non-numeric line/col', () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', 'file.tsx:abc:def');
    document.body.appendChild(el);
    expect(readSourceInfo(el)).toBeNull();
  });

  it('returns null on non-positive line', () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', 'file.tsx:-1:0');
    document.body.appendChild(el);
    expect(readSourceInfo(el)).toBeNull();
  });

  it('returns null when the triple has more than three parts', () => {
    const el = document.createElement('div');
    el.setAttribute('data-forjis-src', 'a:b:c:d');
    document.body.appendChild(el);
    expect(readSourceInfo(el)).toBeNull();
  });
});

describe('readComponentName', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the attribute value on the target element', () => {
    const el = document.createElement('button');
    el.setAttribute('data-forjis-component', 'Button');
    document.body.appendChild(el);
    expect(readComponentName(el)).toBe('Button');
  });

  it('walks up to a parent carrying the attribute', () => {
    const parent = document.createElement('div');
    parent.setAttribute('data-forjis-component', 'Card');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(readComponentName(child)).toBe('Card');
  });

  it('returns null when no ancestor carries the attribute', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(readComponentName(el)).toBeNull();
  });
});

describe('computeSelector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('roots the chain at the nearest id-bearing ancestor using nth-of-type', () => {
    const root = document.createElement('div');
    root.id = 'root';
    const inner = document.createElement('div');
    const span1 = document.createElement('span');
    const span2 = document.createElement('span');
    inner.appendChild(span1);
    inner.appendChild(span2);
    root.appendChild(inner);
    document.body.appendChild(root);
    const sel = computeSelector(span2);
    expect(sel).toBe('#root > div:nth-of-type(1) > span:nth-of-type(2)');
  });

  it('bottoms out at html when no ancestor has an id', () => {
    // Body has no id; body's parent is html.
    const div = document.createElement('div');
    document.body.appendChild(div);
    const sel = computeSelector(div);
    expect(sel.startsWith('html')).toBe(true);
    expect(sel.includes(' > ')).toBe(true);
  });

  it('escapes ids containing special characters via CSS.escape when available', () => {
    const root = document.createElement('div');
    root.id = 'my.id';
    const child = document.createElement('p');
    root.appendChild(child);
    document.body.appendChild(root);
    const sel = computeSelector(child);
    const expectedId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape('my.id')
        : 'my.id';
    expect(sel).toBe('#' + expectedId + ' > p:nth-of-type(1)');
  });

  it('uses nth-of-type indexing independent of sibling tag variety', () => {
    const root = document.createElement('div');
    root.id = 'root';
    // Mixed siblings: p, span, p, span. Target is the 2nd span.
    root.appendChild(document.createElement('p'));
    root.appendChild(document.createElement('span'));
    root.appendChild(document.createElement('p'));
    const targetSpan = document.createElement('span');
    root.appendChild(targetSpan);
    document.body.appendChild(root);
    expect(computeSelector(targetSpan)).toBe('#root > span:nth-of-type(2)');
  });
});

describe('computeBbox', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('returns viewport rect normalised by window scroll offsets', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        right: 110,
        bottom: 70,
        width: 100,
        height: 50,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(window, 'scrollX', { value: 5, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 7, configurable: true });
    expect(computeBbox(el)).toEqual({ x: 15, y: 27, w: 100, h: 50 });
  });
});
