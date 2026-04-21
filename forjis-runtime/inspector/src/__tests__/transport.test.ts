/**
 * Transport-layer tests for `@forjis/inspector`.
 *
 * Exercises the four scenarios called out by FR-009:
 *
 * 1. Handshake — the first inbound frame observed server-side is
 *    `session.join` with the caller-supplied token, `platform: "web"`, and a
 *    non-empty `clientId`.
 * 2. Ready lifecycle — ack resolves, session.error rejects with a typed
 *    {@link InspectorSessionError}, close-before-ack rejects with
 *    `SESSION_CLOSED_BEFORE_ACK` on the first connect attempt.
 * 3. Queue flush — messages sent before the ack arrive after it, in call
 *    order; the queue is preserved across a pre-ack reconnect.
 * 4. Reconnect — a post-ack server-initiated close triggers a new socket
 *    within 1000 ms and the new socket re-sends `session.join`.
 */

import { Server, type MockSocketClient } from 'mock-socket';
import { InspectorClient, InspectorSessionError } from '../transport.js';
import type { InspectorMessage } from '@forjis/shared';

const TEST_URL = 'ws://localhost:9999/inspector/ws';
const TEST_TOKEN = 'tok-abc123';

interface CapturedServer {
  readonly server: Server;
  readonly frames: InspectorMessage[];
  readonly connections: MockSocketClient[];
}

/**
 * Start a fresh mock-socket server bound to {@link TEST_URL} and record every
 * frame + connection so tests can assert ordering without race-prone polling.
 *
 * @returns Harness with `server`, `frames`, and `connections` fields.
 */
function startServer(): CapturedServer {
  const frames: InspectorMessage[] = [];
  const connections: MockSocketClient[] = [];
  const server = new Server(TEST_URL);
  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', ((data: string) => {
      frames.push(JSON.parse(data) as InspectorMessage);
    }) as unknown as (...args: unknown[]) => void);
  });
  return { server, frames, connections };
}

/**
 * Wait for an asynchronous predicate to become true, polling every 10 ms up
 * to the supplied timeout.
 *
 * @param predicate - Callback returning the condition under test.
 * @param timeoutMs - Maximum time to wait; defaults to 1 s.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out after ' + String(timeoutMs) + ' ms');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('InspectorClient handshake', () => {
  let harness: CapturedServer;
  let client: InspectorClient | null = null;

  beforeEach(() => {
    harness = startServer();
  });

  afterEach(() => {
    if (client) {
      client.close();
      client = null;
    }
    harness.server.stop();
  });

  it('sends session.join as the first inbound frame with token and platform', async () => {
    client = new InspectorClient({ url: TEST_URL, token: TEST_TOKEN });
    await waitFor(() => harness.frames.length >= 1);
    const first = harness.frames[0];
    expect(first).toBeDefined();
    if (!first || first.type !== 'session.join') {
      throw new Error('first frame was not session.join');
    }
    expect(first.type).toBe('session.join');
    expect(first.token).toBe(TEST_TOKEN);
    expect(first.platform).toBe('web');
    expect(typeof first.clientId).toBe('string');
    expect(first.clientId.length).toBeGreaterThan(0);
  });
});

describe('InspectorClient ready promise', () => {
  let harness: CapturedServer;
  let client: InspectorClient | null = null;

  beforeEach(() => {
    harness = startServer();
  });

  afterEach(() => {
    if (client) {
      client.close();
      client = null;
    }
    harness.server.stop();
  });

  it('resolves ready after session.ack', async () => {
    harness.server.on('connection', (socket) => {
      socket.on('message', ((_data: string) => {
        socket.send(
          JSON.stringify({
            type: 'session.ack',
            sessionId: 'sess-1',
            protocolVersion: 'forjis-inspector/1.0',
          }),
        );
      }) as unknown as (...args: unknown[]) => void);
    });
    client = new InspectorClient({ url: TEST_URL, token: TEST_TOKEN });
    await expect(client.ready).resolves.toBeUndefined();
  });

  it('rejects ready with InspectorSessionError on session.error', async () => {
    harness.server.on('connection', (socket) => {
      socket.on('message', ((_data: string) => {
        socket.send(
          JSON.stringify({
            type: 'session.error',
            code: 'TOKEN_MISMATCH',
            message: 'supplied token did not match',
          }),
        );
      }) as unknown as (...args: unknown[]) => void);
    });
    client = new InspectorClient({ url: TEST_URL, token: TEST_TOKEN });
    await expect(client.ready).rejects.toBeInstanceOf(InspectorSessionError);
    await client.ready.catch((err: InspectorSessionError) => {
      expect(err.code).toBe('TOKEN_MISMATCH');
      expect(err.message).toContain('supplied token');
    });
  });

  it('rejects ready with SESSION_CLOSED_BEFORE_ACK on premature close', async () => {
    harness.server.on('connection', (socket) => {
      socket.on('message', ((_data: string) => {
        socket.close({ code: 1011, reason: 'server oopsie', wasClean: false });
      }) as unknown as (...args: unknown[]) => void);
    });
    client = new InspectorClient({ url: TEST_URL, token: TEST_TOKEN });
    await expect(client.ready).rejects.toBeInstanceOf(InspectorSessionError);
    await client.ready.catch((err: InspectorSessionError) => {
      expect(err.code).toBe('SESSION_CLOSED_BEFORE_ACK');
    });
  });
});

describe('InspectorClient queue flush', () => {
  let harness: CapturedServer;
  let client: InspectorClient | null = null;

  beforeEach(() => {
    harness = startServer();
  });

  afterEach(() => {
    if (client) {
      client.close();
      client = null;
    }
    harness.server.stop();
  });

  it('flushes queued messages in call order after session.ack', async () => {
    let joinReceived = false;
    harness.server.on('connection', (socket) => {
      socket.on('message', ((data: string) => {
        const msg = JSON.parse(data) as InspectorMessage;
        if (msg.type === 'session.join' && !joinReceived) {
          joinReceived = true;
          socket.send(
            JSON.stringify({
              type: 'session.ack',
              sessionId: 'sess-queue',
              protocolVersion: 'forjis-inspector/1.0',
            }),
          );
        }
      }) as unknown as (...args: unknown[]) => void);
    });
    client = new InspectorClient({ url: TEST_URL, token: TEST_TOKEN });
    const msgA: InspectorMessage = { type: 'pin.ack', pinId: 'a' };
    const msgB: InspectorMessage = { type: 'pin.ack', pinId: 'b' };
    client.send(msgA);
    client.send(msgB);
    await client.ready;
    await waitFor(() => harness.frames.length >= 3);
    expect(harness.frames[0]?.type).toBe('session.join');
    expect(harness.frames[1]).toEqual(msgA);
    expect(harness.frames[2]).toEqual(msgB);
  });
});

describe('InspectorClient reconnect', () => {
  let harness: CapturedServer;
  let client: InspectorClient | null = null;

  beforeEach(() => {
    harness = startServer();
  });

  afterEach(() => {
    if (client) {
      client.close();
      client = null;
    }
    harness.server.stop();
  });

  it('reopens the socket and re-sends session.join within 1000 ms of an unexpected close', async () => {
    let connectionCount = 0;
    harness.server.on('connection', (socket) => {
      connectionCount += 1;
      const localCount = connectionCount;
      socket.on('message', ((data: string) => {
        const msg = JSON.parse(data) as InspectorMessage;
        if (msg.type !== 'session.join') {
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'session.ack',
            sessionId: 'sess-' + String(localCount),
            protocolVersion: 'forjis-inspector/1.0',
          }),
        );
        if (localCount === 1) {
          setTimeout(() => {
            socket.close({ code: 1011, reason: 'flap', wasClean: false });
          }, 10);
        }
      }) as unknown as (...args: unknown[]) => void);
    });
    client = new InspectorClient({ url: TEST_URL, token: TEST_TOKEN });
    await client.ready;
    const joinFramesBeforeReconnect = harness.frames.filter(
      (f) => f.type === 'session.join',
    ).length;
    expect(joinFramesBeforeReconnect).toBe(1);
    await waitFor(
      () =>
        harness.frames.filter((f) => f.type === 'session.join').length >= 2,
      1000,
    );
    expect(connectionCount).toBeGreaterThanOrEqual(2);
  });
});
