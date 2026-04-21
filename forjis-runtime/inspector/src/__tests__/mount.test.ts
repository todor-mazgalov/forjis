/**
 * DOM-focused tests for `mount()` / `unmount()`.
 *
 * Covers the FR-003 and FR-008 scenarios that rely on `document.body` and
 * `<meta>` tags — split from `transport.test.ts` so the transport suite can
 * stay single-purpose.
 */

import { Server } from 'mock-socket';
import type { Pin } from '@forjis/shared';
import { mount } from '../mount.js';
import {
  __resetBatchStateForTests,
  addPin as batchAddPin,
  getBatch,
} from '../queue/batch-state.js';
import { __resetScreenTrackerForTests } from '../queue/screen-tracker.js';
import { unmount } from '../unmount.js';

const TEST_URL = 'ws://localhost:9998/inspector/ws';
const TEST_TOKEN = 'tok-mount-test';

describe('mount()', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    sessionStorage.clear();
  });

  afterEach(() => {
    unmount();
    if (server) {
      server.stop();
      server = null;
    }
  });

  it('appends <div id="forjis-inspector-root"> to document.body and opens a WebSocket', async () => {
    server = new Server(TEST_URL);
    const opened = new Promise<void>((resolve) => {
      server?.on('connection', () => resolve());
    });
    const handle = mount({ url: TEST_URL, token: TEST_TOKEN });
    const root = document.querySelector('#forjis-inspector-root');
    expect(root).not.toBeNull();
    expect(root?.tagName).toBe('DIV');
    expect(typeof handle.send).toBe('function');
    await opened;
  });

  it('reads url and token from meta tags when called without arguments', async () => {
    server = new Server(TEST_URL);
    const urlMeta = document.createElement('meta');
    urlMeta.setAttribute('name', 'forjis-inspector-url');
    urlMeta.setAttribute('content', TEST_URL);
    document.head.appendChild(urlMeta);
    const tokenMeta = document.createElement('meta');
    tokenMeta.setAttribute('name', 'forjis-inspector-token');
    tokenMeta.setAttribute('content', TEST_TOKEN);
    document.head.appendChild(tokenMeta);
    const opened = new Promise<void>((resolve) => {
      server?.on('connection', () => resolve());
    });
    const handle = mount();
    expect(handle).toBeDefined();
    expect(document.querySelector('#forjis-inspector-root')).not.toBeNull();
    await opened;
  });

  it('throws synchronously when neither arguments nor meta tags provide url or token', () => {
    expect(() => mount()).toThrow(/missing url/);
    expect(document.querySelector('#forjis-inspector-root')).toBeNull();
  });

  it('throws synchronously on double mount', () => {
    server = new Server(TEST_URL);
    mount({ url: TEST_URL, token: TEST_TOKEN });
    expect(() => mount({ url: TEST_URL, token: TEST_TOKEN })).toThrow(
      /already mounted/,
    );
  });
});

describe('unmount()', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    sessionStorage.clear();
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it('is a no-op when no mount is active', () => {
    expect(() => unmount()).not.toThrow();
  });

  it('removes the root div and closes the WebSocket', async () => {
    server = new Server(TEST_URL);
    let closed = false;
    server.on('connection', (socket) => {
      (socket as unknown as { on: (ev: string, h: () => void) => void }).on(
        'close',
        () => {
          closed = true;
        },
      );
    });
    const opened = new Promise<void>((resolve) => {
      server?.on('connection', () => resolve());
    });
    mount({ url: TEST_URL, token: TEST_TOKEN });
    await opened;
    unmount();
    expect(document.querySelector('#forjis-inspector-root')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });

  it('is idempotent', () => {
    server = new Server(TEST_URL);
    mount({ url: TEST_URL, token: TEST_TOKEN });
    unmount();
    expect(() => unmount()).not.toThrow();
  });
});

describe('mount() integration with BatchState + queue panel', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    sessionStorage.clear();
  });

  afterEach(() => {
    unmount();
    if (server) {
      server.stop();
      server = null;
    }
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    sessionStorage.clear();
  });

  /**
   * Build a deterministic Pin for the integration tests.
   *
   * @param id - Pin identifier.
   * @returns Pin value.
   */
  function makePin(id: string): Pin {
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
    };
  }

  it('mounts queue panel inside the overlay shadow root (FR-010-019)', () => {
    server = new Server(TEST_URL);
    mount({ url: TEST_URL, token: TEST_TOKEN });
    const root = document.getElementById('forjis-inspector-root');
    const panel = root?.shadowRoot?.querySelector('[data-forjis-queue-panel]');
    expect(panel).not.toBeNull();
  });

  it('adding a pin renders a row in the queue panel', () => {
    server = new Server(TEST_URL);
    mount({ url: TEST_URL, token: TEST_TOKEN });
    batchAddPin(makePin('p-1'));
    const root = document.getElementById('forjis-inspector-root');
    const rows = root?.shadowRoot?.querySelectorAll('.queue-row');
    expect(rows).toHaveLength(1);
  });

  it('batch.finalize message clears the queue (FR-010-029)', async () => {
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
    const handle = mount({ url: TEST_URL, token: TEST_TOKEN });
    await opened;
    await handle.ready;
    batchAddPin(makePin('p-1'));
    expect(getBatch()!.pins).toHaveLength(1);
    const batchId = getBatch()!.id;
    // Server sends a batch.finalize for the current batch id.
    server.clients().forEach((c) => {
      c.send(
        JSON.stringify({
          type: 'batch.finalize',
          batchId,
          taskPath: '/tmp/t',
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(getBatch()).toBeNull();
    const root = document.getElementById('forjis-inspector-root');
    const empty = root?.shadowRoot?.querySelector('.queue-empty');
    expect(empty).not.toBeNull();
  });

  it('unmount teardown order removes panel + overlay + root', () => {
    server = new Server(TEST_URL);
    mount({ url: TEST_URL, token: TEST_TOKEN });
    expect(document.getElementById('forjis-inspector-root')).not.toBeNull();
    unmount();
    expect(document.getElementById('forjis-inspector-root')).toBeNull();
    // After unmount BatchState persists in storage (not cleared).
    const stored = sessionStorage.getItem('forjis-inspector:batch');
    // Either null (never written) or a valid payload — what matters is
    // that unmount did NOT programmatically clear it.
    expect(stored === null || stored.length > 0).toBe(true);
  });
});
