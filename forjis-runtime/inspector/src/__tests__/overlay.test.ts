/**
 * Integration tests for `ui/overlay.ts`. Tests mount the inspector through the
 * public `mount()` entry point (matching `mount.test.ts` conventions) so the
 * shadow root hookup is verified end-to-end. A `mock-socket` server is used
 * because `mount()` still opens the transport.
 *
 * `__resetModeForTests` clears the module-local mode cache between tests so
 * `sessionStorage` seeding is honoured.
 */

import { jest } from '@jest/globals';
import { Server } from 'mock-socket';
import { mount } from '../mount.js';
import { initOverlay } from '../ui/overlay.js';
import { __resetModeForTests, getMode, setMode } from '../ui/mode.js';
import { unmount } from '../unmount.js';

const TEST_URL = 'ws://localhost:9997/inspector/ws';
const TEST_TOKEN = 'tok-overlay-test';

/**
 * Query the mounted toggle button.
 *
 * @returns The button element, or `null` when the overlay is not mounted.
 */
function getToggleButton(): HTMLButtonElement | null {
  const root = document.getElementById('forjis-inspector-root');
  if (!root || !root.shadowRoot) {
    return null;
  }
  return root.shadowRoot.querySelector<HTMLButtonElement>(
    '[data-forjis-role="toggle"]',
  );
}

/**
 * Query the highlight box inside the overlay shadow root.
 *
 * @returns The highlight element, or `null` when not mounted.
 */
function getHighlight(): HTMLElement | null {
  const root = document.getElementById('forjis-inspector-root');
  if (!root || !root.shadowRoot) {
    return null;
  }
  return root.shadowRoot.querySelector<HTMLElement>(
    '[data-forjis-role="highlight"]',
  );
}

describe('overlay integration through mount()', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    sessionStorage.clear();
    __resetModeForTests();
    server = new Server(TEST_URL);
  });

  afterEach(() => {
    unmount();
    if (server) {
      server.stop();
      server = null;
    }
    sessionStorage.clear();
    __resetModeForTests();
  });

  it('FR-001: renders a toggle button inside an open shadow root', () => {
    mount({ url: TEST_URL, token: TEST_TOKEN });
    const root = document.getElementById('forjis-inspector-root');
    expect(root?.shadowRoot).not.toBeNull();
    expect(root?.shadowRoot?.mode).toBe('open');
    const btn = getToggleButton();
    expect(btn).not.toBeNull();
    expect(getComputedStyle(btn as HTMLButtonElement).display).not.toBe('none');
  });

  it('FR-009: shadow DOM exists, mode is open, and overlay nodes live inside it', () => {
    mount({ url: TEST_URL, token: TEST_TOKEN });
    const style = document.createElement('style');
    style.textContent = '* { display: none }';
    document.head.appendChild(style);
    const root = document.getElementById('forjis-inspector-root');
    expect(root?.shadowRoot).not.toBeNull();
    expect(root?.shadowRoot?.mode).toBe('open');
    // Overlay nodes live inside the shadow root, not document.body.
    const btn = root?.shadowRoot?.querySelector('[data-forjis-role="toggle"]');
    expect(btn).not.toBeNull();
    // JSDOM has limited shadow-DOM CSS isolation; still, the overlay's own
    // shadow stylesheet is present and the button is in the shadow subtree.
    const styles = root?.shadowRoot?.querySelector('style');
    expect(styles).not.toBeNull();
    expect(styles?.textContent).toContain('data-forjis-role');
  });

  it('FR-002: default mode is "use" on first load', () => {
    mount({ url: TEST_URL, token: TEST_TOKEN });
    expect(getMode()).toBe('use');
    const btn = getToggleButton();
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
  });

  it('FR-002: clicking the toggle persists inspect mode to sessionStorage', () => {
    mount({ url: TEST_URL, token: TEST_TOKEN });
    const btn = getToggleButton();
    btn?.click();
    expect(sessionStorage.getItem('forjis-inspector:mode')).toBe('inspect');
  });

  it('FR-002: re-mount preserves inspect mode from sessionStorage', () => {
    sessionStorage.setItem('forjis-inspector:mode', 'inspect');
    __resetModeForTests();
    mount({ url: TEST_URL, token: TEST_TOKEN });
    expect(getMode()).toBe('inspect');
    const btn = getToggleButton();
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
  });

  it('FR-003: click flips aria-pressed', () => {
    mount({ url: TEST_URL, token: TEST_TOKEN });
    const btn = getToggleButton() as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('overlay via initOverlay directly (no transport)', () => {
  let root: HTMLElement;
  let onPick: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    sessionStorage.clear();
    __resetModeForTests();
    root = document.createElement('div');
    root.id = 'forjis-inspector-root';
    document.body.appendChild(root);
    onPick = jest.fn();
  });

  afterEach(() => {
    sessionStorage.clear();
    __resetModeForTests();
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  });

  it('FR-005: two clicks on the same element emit one PinTarget', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const target = document.createElement('div');
    target.id = 'target';
    target.setAttribute('data-forjis-src', '/src/App.tsx:42:7');
    document.body.appendChild(target);
    target.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 100,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onPick).toHaveBeenCalledTimes(1);
    const pin = onPick.mock.calls[0][0];
    expect(pin.kind).toBe('element');
    expect(pin.selector).toBe('#target');
    expect(pin.source).toEqual({ file: '/src/App.tsx', line: 42, col: 7 });
    expect(pin.bbox).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    overlay.destroy();
  });

  it('FR-005: second click on a different element swaps pending without firing onPick', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const el1 = document.createElement('div');
    el1.id = 'el1';
    const el2 = document.createElement('div');
    el2.id = 'el2';
    document.body.appendChild(el1);
    document.body.appendChild(el2);

    el1.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el2.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();

    // Third click on el2 confirms it.
    el2.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].selector).toBe('#el2');
    overlay.destroy();
  });

  it('FR-006: Escape cancels pending and subsequent click re-enters pending (no confirm)', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const el = document.createElement('div');
    el.id = 'only';
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it('FR-006: click on empty space (document.body) clears pending', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const el = document.createElement('div');
    el.id = 'only2';
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Click directly on body.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
    // Highlight should be hidden.
    const highlight = root.shadowRoot?.querySelector<HTMLElement>(
      '[data-forjis-role="highlight"]',
    );
    expect(highlight?.style.display).toBe('none');
    overlay.destroy();
  });

  it('FR-007: use mode passes clicks through to host listeners', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('use');
    const el = document.createElement('div');
    el.id = 'host';
    const hostSpy = jest.fn();
    el.addEventListener('click', hostSpy);
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hostSpy).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it('FR-010: clicking the toggle button does not fire onPick in inspect mode', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const btn = root.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-forjis-role="toggle"]',
    );
    btn?.click();
    btn?.click();
    expect(onPick).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it('FR-008: touch pointerdown does not show hover; two clicks confirm', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const el = document.createElement('div');
    el.id = 'touchtarget';
    el.setAttribute('data-forjis-src', '/src/X.tsx:1:1');
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 10,
        bottom: 10,
        width: 10,
        height: 10,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    // Touch pointerdown — should not render a hover highlight.
    const pd = new Event('pointermove', { bubbles: true }) as PointerEvent;
    Object.defineProperty(pd, 'pointerType', { value: 'touch' });
    el.dispatchEvent(pd);
    const highlight = root.shadowRoot?.querySelector<HTMLElement>(
      '[data-forjis-role="highlight"]',
    );
    expect(highlight?.style.display).toBe('none');

    // Two synthetic clicks confirm.
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).toHaveBeenCalledTimes(1);
    overlay.destroy();
  });

  it('FR-004: pointermove in inspect mode sets hover highlight variant', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const el = document.createElement('div');
    el.id = 'hovertarget';
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
      ({
        left: 1,
        top: 2,
        right: 11,
        bottom: 12,
        width: 10,
        height: 10,
        x: 1,
        y: 2,
        toJSON: () => ({}),
      }) as DOMRect;

    const move = new Event('pointermove', { bubbles: true }) as PointerEvent;
    Object.defineProperty(move, 'pointerType', { value: 'mouse' });
    el.dispatchEvent(move);

    const highlight = root.shadowRoot?.querySelector<HTMLElement>(
      '[data-forjis-role="highlight"]',
    );
    expect(highlight).not.toBeNull();
    expect(highlight?.getAttribute('data-variant')).toBe('hover');
    expect(highlight?.style.display).toBe('block');
    overlay.destroy();
  });

  it('FR-012: destroy removes listeners — subsequent clicks do not fire onPick', () => {
    const overlay = initOverlay({ root, onPick, onSubmitPin: jest.fn() });
    setMode('inspect');
    const el = document.createElement('div');
    el.id = 'post-destroy';
    document.body.appendChild(el);
    overlay.destroy();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('overlay teardown via mount()/unmount()', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    sessionStorage.clear();
    __resetModeForTests();
    server = new Server(TEST_URL);
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    sessionStorage.clear();
    __resetModeForTests();
  });

  it('FR-012: unmount() removes the host root div', () => {
    mount({ url: TEST_URL, token: TEST_TOKEN });
    expect(document.getElementById('forjis-inspector-root')).not.toBeNull();
    unmount();
    expect(document.getElementById('forjis-inspector-root')).toBeNull();
  });
});
