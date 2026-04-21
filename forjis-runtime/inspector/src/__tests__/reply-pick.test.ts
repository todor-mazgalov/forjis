/**
 * Integration tests for the overlay-pick → reply-detect → reply-banner
 * routing in `mount.ts:wireShadowComponents`.
 *
 * Covers FR-011-030 scenarios:
 * - "reply pick with a candidate opens the reply banner" — a confirmed
 *   two-tap pick on an element whose source / component / comment match a
 *   seeded history pin surfaces the reply banner and suppresses the
 *   comment sheet.
 * - "reply pick with no candidate proceeds to comment sheet" — the same
 *   flow on an unmatched element leaves the banner hidden and opens the
 *   comment sheet via the overlay's default dispatch path.
 */

import { Server } from 'mock-socket';
import type { Batch, Pin } from '@forjis/shared';
import { mount } from '../mount.js';
import { unmount } from '../unmount.js';
import { __resetBatchStateForTests } from '../queue/batch-state.js';
import { __resetScreenTrackerForTests } from '../queue/screen-tracker.js';
import { __resetHistoryStoreForTests } from '../history/history-store.js';
import { __resetModeForTests, setMode } from '../ui/mode.js';
import { __resetPickerToolForTests } from '../ui/picker-tool.js';

const TEST_URL = 'ws://localhost:9993/inspector/ws';
const TEST_TOKEN = 'tok-reply-pick-test';

/** Deterministic Pin builder. */
function makePin(id: string, overrides: Partial<Pin> = {}): Pin {
  return {
    id,
    platform: 'web',
    screen: '/a',
    target: {
      kind: 'element',
      source: null,
      selector: '#' + id,
      componentName: null,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,AAAA',
      viewportScreenshot: 'data:image/png;base64,AAAA',
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

/** Seed the history store with a parent pin matching the host element. */
function seedMatchingParent(token: string): {
  parentPinId: string;
  parentBatchId: string;
} {
  const parent: Pin = makePin('p-parent', {
    target: {
      kind: 'element',
      source: { file: 'src/App.tsx', line: 12, col: 4 },
      selector: '#footer',
      componentName: 'Footer',
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    comment: 'the sign up button looks wrong',
  });
  const batch: Batch = {
    id: 'b-parent-42',
    platform: 'web',
    screens: ['/a'],
    pins: [parent],
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status: 'done',
  };
  const payload = {
    token,
    entries: [
      {
        batch,
        taskPath: '/tmp/parent',
        summary: null,
        finalizedAt: '2026-04-22T10:00:00.000Z',
      },
    ],
  };
  localStorage.setItem('forjis-inspector:history', JSON.stringify(payload));
  return { parentPinId: parent.id, parentBatchId: batch.id };
}

/** Seed the history store with a pin that cannot match anything generic. */
function seedUnrelatedParent(token: string): void {
  const parent = makePin('p-parent-unrelated', {
    target: {
      kind: 'element',
      source: { file: 'src/Unrelated.tsx', line: 99, col: 1 },
      selector: '#other',
      componentName: 'Unrelated',
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    comment: 'zzz-nothing-shared',
  });
  const batch: Batch = {
    id: 'b-parent-unrelated',
    platform: 'web',
    screens: ['/a'],
    pins: [parent],
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status: 'done',
  };
  const payload = {
    token,
    entries: [
      {
        batch,
        taskPath: '/tmp/parent',
        summary: null,
        finalizedAt: '2026-04-22T10:00:00.000Z',
      },
    ],
  };
  localStorage.setItem('forjis-inspector:history', JSON.stringify(payload));
}

describe('mount() pick-confirm → reply-banner routing', () => {
  let server: Server | null = null;
  // jsdom does not implement URL.createObjectURL / revokeObjectURL. The
  // comment-sheet uses both when rendering a pick; stub them with a fake
  // "blob:" URL so the "no candidate → comment sheet" fallthrough path can
  // open the sheet under test. Restored in afterEach.
  let originalCreate: typeof URL.createObjectURL | undefined;
  let originalRevoke: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    __resetHistoryStoreForTests();
    __resetModeForTests();
    __resetPickerToolForTests();
    sessionStorage.clear();
    localStorage.clear();
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL =
      () => 'blob:inspector-test';
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
      () => undefined;
  });

  afterEach(() => {
    unmount();
    if (server) {
      server.stop();
      server = null;
    }
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    __resetHistoryStoreForTests();
    __resetModeForTests();
    __resetPickerToolForTests();
    sessionStorage.clear();
    localStorage.clear();
    if (originalCreate !== undefined) {
      (URL as unknown as { createObjectURL: typeof originalCreate }).createObjectURL =
        originalCreate;
    }
    if (originalRevoke !== undefined) {
      (URL as unknown as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL =
        originalRevoke;
    }
  });

  it('FR-011-030 — reply pick with a candidate opens the reply banner and suppresses the comment sheet', async () => {
    server = new Server(TEST_URL);
    const opened = new Promise<void>((resolve) => {
      server?.on('connection', (socket) => {
        socket.send(
          JSON.stringify({
            type: 'session.ack',
            sessionId: 's',
            protocolVersion: 'forjis-inspector/1.0',
          }),
        );
        resolve();
      });
    });
    seedMatchingParent(TEST_TOKEN);
    const handle = mount({ url: TEST_URL, token: TEST_TOKEN });
    await opened;
    await handle.ready;
    setMode('inspect');
    // Host DOM element whose source + component + comment match the seeded
    // parent pin so `detectReplyCandidate` scores ≥ 0.75.
    const el = document.createElement('div');
    el.id = 'host-match';
    el.setAttribute('data-forjis-src', 'src/App.tsx:12:4');
    el.setAttribute('data-forjis-component', 'Footer');
    el.textContent = 'sign up';
    document.body.appendChild(el);
    // Two clicks on the same element: first → pending, second → confirm.
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Allow the async capture + middleware chain to drain.
    await new Promise((r) => setTimeout(r, 60));
    const root = document.getElementById('forjis-inspector-root');
    const banner = root?.shadowRoot?.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('data-open')).toBe('true');
    // Banner text mentions the parent pin's componentName (FR-011-021).
    expect(banner?.textContent ?? '').toContain('Footer');
    // Comment sheet remained closed (middleware suppressed the dispatch).
    const commentSheet = root?.shadowRoot?.querySelector(
      '.comment-sheet',
    ) as HTMLElement | null;
    expect(commentSheet?.getAttribute('data-open')).toBe('false');
  });

  it('FR-011-030 — reply pick with no candidate falls through to the comment sheet', async () => {
    server = new Server(TEST_URL);
    const opened = new Promise<void>((resolve) => {
      server?.on('connection', (socket) => {
        socket.send(
          JSON.stringify({
            type: 'session.ack',
            sessionId: 's',
            protocolVersion: 'forjis-inspector/1.0',
          }),
        );
        resolve();
      });
    });
    seedUnrelatedParent(TEST_TOKEN);
    const handle = mount({ url: TEST_URL, token: TEST_TOKEN });
    await opened;
    await handle.ready;
    setMode('inspect');
    // Element with NO matching source/component, and text that does not
    // appear in the seeded pin's comment. matchScore = 0.
    const el = document.createElement('div');
    el.id = 'host-nomatch';
    el.textContent = 'entirely-unrelated-label';
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const root = document.getElementById('forjis-inspector-root');
    const banner = root?.shadowRoot?.querySelector(
      '[data-forjis-reply-banner]',
    ) as HTMLElement | null;
    // Banner stays hidden — no candidate → middleware returned false.
    expect(banner?.getAttribute('data-open')).toBe('false');
    // Comment sheet opened because the overlay proceeded with its default
    // dispatch path.
    const commentSheet = root?.shadowRoot?.querySelector(
      '.comment-sheet',
    ) as HTMLElement | null;
    expect(commentSheet).not.toBeNull();
    expect(commentSheet?.getAttribute('data-open')).toBe('true');
  });
});
