/**
 * DOM-focused tests for `mount()` / `unmount()`.
 *
 * Covers the FR-003 and FR-008 scenarios that rely on `document.body` and
 * `<meta>` tags — split from `transport.test.ts` so the transport suite can
 * stay single-purpose.
 */

import { Server } from 'mock-socket';
import { mount } from '../mount.js';
import { unmount } from '../unmount.js';

const TEST_URL = 'ws://localhost:9998/inspector/ws';
const TEST_TOKEN = 'tok-mount-test';

describe('mount()', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
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
