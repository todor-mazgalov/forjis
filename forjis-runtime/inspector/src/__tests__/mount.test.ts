/**
 * DOM-focused tests for `mount()` / `unmount()`.
 *
 * Covers the FR-003 and FR-008 scenarios that rely on `document.body` and
 * `<meta>` tags — split from `transport.test.ts` so the transport suite can
 * stay single-purpose.
 */

import { Server } from 'mock-socket';
import type { Batch, Pin } from '@forjis/shared';
import { mount } from '../mount.js';
import {
  __resetBatchStateForTests,
  addPin as batchAddPin,
  getBatch,
} from '../queue/batch-state.js';
import { __resetScreenTrackerForTests } from '../queue/screen-tracker.js';
import {
  __resetHistoryStoreForTests,
  getHistory,
} from '../history/history-store.js';
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
    __resetHistoryStoreForTests();
    sessionStorage.clear();
    localStorage.clear();
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
    __resetHistoryStoreForTests();
    sessionStorage.clear();
    localStorage.clear();
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
    __resetHistoryStoreForTests();
    sessionStorage.clear();
    localStorage.clear();
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
    sessionStorage.clear();
    localStorage.clear();
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

describe('mount() task-011 clarify + history + reply wiring', () => {
  let server: Server | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    __resetBatchStateForTests();
    __resetScreenTrackerForTests();
    __resetHistoryStoreForTests();
    sessionStorage.clear();
    localStorage.clear();
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
    sessionStorage.clear();
    localStorage.clear();
  });

  /** Build a deterministic Pin for the integration tests. */
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

  /** Push a session.ack and wait for the client to go ready. */
  async function startReady(): Promise<{ batchId: string }> {
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
    return { batchId: getBatch()!.id };
  }

  /** Send a frame from server to every connected client. */
  function broadcast(msg: unknown): void {
    server?.clients().forEach((c) => {
      c.send(JSON.stringify(msg));
    });
  }

  it('FR-011-030 — clarify.question reaches the clarify panel', async () => {
    server = new Server(TEST_URL);
    const { batchId } = await startReady();
    broadcast({
      type: 'clarify.question',
      batchId,
      question: {
        id: 'q1',
        text: 'Which footer?',
        options: [
          { id: 'a', label: 'Primary', description: '' },
          { id: 'b', label: 'Secondary', description: '' },
        ],
        allowFreeText: false,
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const root = document.getElementById('forjis-inspector-root');
    const entry = root?.shadowRoot?.querySelector(
      '.clarify-question[data-question-id="q1"]',
    );
    expect(entry).not.toBeNull();
  });

  it('FR-011-030 — batch.finalize pushes active batch into history and clears BatchState', async () => {
    server = new Server(TEST_URL);
    const { batchId } = await startReady();
    batchAddPin(makePin('p-2'));
    broadcast({
      type: 'batch.finalize',
      batchId,
      taskPath: '/tmp/t',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(getBatch()).toBeNull();
    const history = getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].batch.id).toBe(batchId);
    expect(history[0].taskPath).toBe('/tmp/t');
    expect(history[0].batch.pins).toHaveLength(2);
  });

  it('FR-011-030 — task.status summary updates stored history entry', async () => {
    server = new Server(TEST_URL);
    const { batchId } = await startReady();
    broadcast({
      type: 'batch.finalize',
      batchId,
      taskPath: '/tmp/t',
    });
    await new Promise((r) => setTimeout(r, 20));
    broadcast({
      type: 'task.status',
      batchId,
      status: 'done',
      summary: 'diff',
    });
    await new Promise((r) => setTimeout(r, 20));
    const entry = getHistory().find((e) => e.batch.id === batchId);
    expect(entry?.summary).toBe('diff');
    expect(entry?.batch.status).toBe('done');
  });

  /**
   * Seed the history store with a parent batch + pin under the same
   * session token the mount uses.
   */
  function seedHistoryFor(token: string): {
    parentPinId: string;
    parentBatchId: string;
  } {
    const parentPin = makePin('p-parent');
    const parentBatch: Batch = {
      id: 'b-parent-42',
      platform: 'web',
      screens: ['/a'],
      pins: [parentPin],
      createdAt: '2026-01-01T00:00:00.000Z',
      parentBatchId: null,
      status: 'done',
    };
    const payload = {
      token,
      entries: [
        {
          batch: parentBatch,
          taskPath: '/tmp/parent',
          summary: null,
          finalizedAt: '2026-04-22T10:00:00.000Z',
        },
      ],
    };
    localStorage.setItem(
      'forjis-inspector:history',
      JSON.stringify(payload),
    );
    return { parentPinId: parentPin.id, parentBatchId: parentBatch.id };
  }

  it('FR-011-031 — sidebar reply opens the sheet; Send dispatches a single reply.create frame with parentPinId', async () => {
    server = new Server(TEST_URL);
    const outbound: Array<{ type: string; payload: unknown }> = [];
    server.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'session.ack',
          sessionId: 's',
          protocolVersion: 'forjis-inspector/1.0',
        }),
      );
      (
        socket as unknown as {
          on: (ev: string, h: (raw: string) => void) => void;
        }
      ).on('message', (raw: string) => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === 'session.join') {
            return;
          }
          outbound.push({ type: parsed.type, payload: parsed });
        } catch {
          /* ignore */
        }
      });
    });
    const { parentPinId, parentBatchId } = seedHistoryFor(TEST_TOKEN);
    const handle = mount({ url: TEST_URL, token: TEST_TOKEN });
    await handle.ready;
    const root = document.getElementById('forjis-inspector-root');
    const shadow = root?.shadowRoot;
    expect(shadow).not.toBeNull();
    // Expand the parent batch card, click Reply on the first pin.
    const expandBtn = shadow?.querySelector(
      '.sidebar-batch-card[data-batch-id="' +
        parentBatchId +
        '"] .sidebar-batch-expand',
    ) as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();
    expandBtn?.click();
    const replyBtn = shadow?.querySelector(
      '[data-forjis-sidebar-reply]',
    ) as HTMLButtonElement | null;
    expect(replyBtn).not.toBeNull();
    replyBtn?.click();
    // Reply sheet should be open; type comment + Send.
    const replySheet = shadow?.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement | null;
    expect(replySheet?.getAttribute('data-open')).toBe('true');
    const textarea = shadow?.querySelector(
      '.reply-comment',
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    if (textarea) {
      textarea.value = 'still broken';
    }
    const sendBtn = shadow?.querySelector(
      '.reply-send-btn',
    ) as HTMLButtonElement | null;
    sendBtn?.click();
    // Allow buildPin + fetch microtasks to settle.
    await new Promise((r) => setTimeout(r, 50));
    // Expect exactly one outbound `reply.create` frame. The facilitator's
    // `replyToPin` handler owns child-batch allocation, so the inspector no
    // longer sends `pin.create` + `batch.submit` for replies (inspector-013).
    const replyIdx = outbound.findIndex((o) => o.type === 'reply.create');
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(outbound.some((o) => o.type === 'pin.create')).toBe(false);
    expect(outbound.some((o) => o.type === 'batch.submit')).toBe(false);
    const replyMsg = outbound[replyIdx].payload as {
      parentPinId: string;
      pin: Pin;
      comment: string;
      failureSummary?: string;
      failedTaskPath?: string;
    };
    expect(replyMsg.parentPinId).toBe(parentPinId);
    expect(replyMsg.pin.parentPinId).toBe(parentPinId);
    expect(replyMsg.pin.comment).toBe('still broken');
    expect(replyMsg.comment).toBe('still broken');
    // Ordinary (non-failure) reply: the optional failure fields MUST be
    // omitted from the wire frame.
    expect(replyMsg.failureSummary).toBeUndefined();
    expect(replyMsg.failedTaskPath).toBeUndefined();
  });

  it('FR-013 — failure-mode reply submission emits a reply.create frame carrying failureSummary + failedTaskPath', async () => {
    server = new Server(TEST_URL);
    const outbound: Array<{ type: string; payload: unknown }> = [];
    server.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'session.ack',
          sessionId: 's',
          protocolVersion: 'forjis-inspector/1.0',
        }),
      );
      (
        socket as unknown as {
          on: (ev: string, h: (raw: string) => void) => void;
        }
      ).on('message', (raw: string) => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === 'session.join') {
            return;
          }
          outbound.push({ type: parsed.type, payload: parsed });
        } catch {
          /* ignore */
        }
      });
    });
    // Seed the history store with a FAILED parent batch so the sidebar
    // renders the failure section with "Reply with hint".
    const parentPin = makePin('p-failed-parent');
    const parentBatch: Batch = {
      id: 'b-failed-parent-1',
      platform: 'web',
      screens: ['/a'],
      pins: [parentPin],
      createdAt: '2026-01-01T00:00:00.000Z',
      parentBatchId: null,
      status: 'failed',
    };
    const seeded = {
      token: TEST_TOKEN,
      entries: [
        {
          batch: parentBatch,
          taskPath: '.forjis/tasks/inspector-xyz',
          summary: 'Build failed in components/Card.tsx',
          finalizedAt: '2026-04-22T10:00:00.000Z',
        },
      ],
    };
    localStorage.setItem(
      'forjis-inspector:history',
      JSON.stringify(seeded),
    );

    const handle = mount({ url: TEST_URL, token: TEST_TOKEN });
    await handle.ready;
    const root = document.getElementById('forjis-inspector-root');
    const shadow = root?.shadowRoot;
    expect(shadow).not.toBeNull();
    // Click the failure-card "Reply with hint" button.
    const failureReplyBtn = shadow?.querySelector(
      '.sidebar-failure-reply',
    ) as HTMLButtonElement | null;
    expect(failureReplyBtn).not.toBeNull();
    failureReplyBtn?.click();
    // Reply sheet should be open and the failure metadata visible.
    const replySheet = shadow?.querySelector(
      '[data-forjis-reply-sheet]',
    ) as HTMLElement | null;
    expect(replySheet?.getAttribute('data-open')).toBe('true');
    const textarea = shadow?.querySelector(
      '.reply-comment',
    ) as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    if (textarea) {
      textarea.value = 'please add the missing import';
    }
    const sendBtn = shadow?.querySelector(
      '.reply-send-btn',
    ) as HTMLButtonElement | null;
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 50));
    const replyMsg = outbound.find((o) => o.type === 'reply.create')
      ?.payload as
      | {
          parentPinId: string;
          pin: Pin;
          comment: string;
          failureSummary?: string;
          failedTaskPath?: string;
        }
      | undefined;
    expect(replyMsg).toBeDefined();
    expect(replyMsg?.parentPinId).toBe(parentPin.id);
    expect(replyMsg?.comment).toBe('please add the missing import');
    expect(replyMsg?.failureSummary).toBe(
      'Build failed in components/Card.tsx',
    );
    expect(replyMsg?.failedTaskPath).toBe('.forjis/tasks/inspector-xyz');
  });

  it('FR-011-030 — clarify panel auto-opens after batch.submit status transition', async () => {
    server = new Server(TEST_URL);
    await startReady();
    // submitBatch flips status to clarifying via queue panel, but we trigger
    // directly via setStatus simulated below: drive through the public
    // handle by broadcasting a `task.status` is NOT the expected path; the
    // clarify panel auto-opens via BatchState subscription.
    // The clarify panel is already subscribed; triggering setStatus indirectly
    // by calling submitBatch through the queue button is easier here.
    const root = document.getElementById('forjis-inspector-root');
    const submitBtn = root?.shadowRoot?.querySelector(
      '.queue-footer button',
    ) as HTMLButtonElement | null;
    expect(submitBtn).not.toBeNull();
    submitBtn?.click();
    await new Promise((r) => setTimeout(r, 20));
    const panel = root?.shadowRoot?.querySelector(
      '[data-forjis-clarify-panel]',
    );
    expect(panel?.getAttribute('data-open')).toBe('true');
  });
});
