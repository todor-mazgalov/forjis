/**
 * Integration tests for the server-side Inspector WebSocket transport.
 *
 * Spins up an ephemeral `node:http.Server` bound to `127.0.0.1:0`, attaches
 * the transport via {@link attachInspectorUpgradeListener}, and exercises
 * the contract using the `ws` library as a client. Every test tears the
 * server down in `afterEach` so jest workers stay clean.
 *
 * Timer handling: the transport is constructed with small heartbeat /
 * handshake intervals so the "dead client" and "handshake timeout" tests
 * complete within the 60 s jest slot.
 *
 * Requirements covered (see design.md FR-/NFR- matrix):
 *   FR-007  — factory returns an InspectorWebSocketServer handle
 *   FR-008  — attach helper subscribes to http.Server upgrade
 *   FR-009  — path filter `/inspector/ws`
 *   FR-010  — token-gated upgrade with pre-handshake rejection
 *   FR-011  — post-upgrade handshake state machine
 *   FR-012  — session.ack carries PROTOCOL_VERSION
 *   FR-014  — heartbeat drops unresponsive clients
 *   FR-015  — InspectorTransport surface (send / broadcast / on*)
 *   FR-019  — existing HTTP routes unaffected
 *   NFR-002 — pre-handshake rejection uses 400 / 401
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createServer, get as httpGet } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type InspectorMessage,
  type SessionMetadataLike,
  type SessionTokenRegistryLike,
} from '@forjis/shared';
import {
  attachInspectorUpgradeListener,
  createInspectorWebSocketServer,
  InspectorUpgradeListenerAlreadyAttachedError,
  type InspectorWebSocketServer,
} from '../inspector-ws.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory stand-in for the facilitator's SessionTokenRegistry. */
class FakeRegistry implements SessionTokenRegistryLike {
  private readonly tokens = new Map<string, SessionMetadataLike>();

  register(token: string, metadata: SessionMetadataLike): void {
    this.tokens.set(token, metadata);
  }

  validate(token: string): SessionMetadataLike | null {
    return this.tokens.get(token) ?? null;
  }
}

/** Start an http.Server on 127.0.0.1 with an OS-assigned port. */
async function listenOnEphemeralPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  return addr.port;
}

/**
 * Await close of an http.Server, bounded by a short grace window.
 *
 * Detached upgrade sockets (e.g. from the "wrong path" test) are not
 * tracked by http.Server's internal pool, so `closeAllConnections()` does
 * not reap them and `server.close()`'s callback can hang indefinitely.
 * The grace window lets teardown proceed — `--forceExit` on the jest
 * runner ensures any remaining handles do not keep the process alive.
 */
function closeHttpServer(server: Server): Promise<void> {
  const serverWithClose = server as Server & {
    closeAllConnections?: () => void;
  };
  serverWithClose.closeAllConnections?.();
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    server.close(() => settle());
    const timer = setTimeout(settle, 300);
    timer.unref();
  });
}

/** Wait for the next `message` frame on a client, timing out after `ms`. */
function waitForMessage(client: WebSocket, ms = 2000): Promise<InspectorMessage> {
  return new Promise<InspectorMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for message'));
    }, ms);
    timer.unref();
    client.once('message', (data) => {
      clearTimeout(timer);
      try {
        const text = data.toString();
        resolve(JSON.parse(text) as InspectorMessage);
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

/** Wait for a WebSocket `open` event (or reject on `error` / `close`). */
function waitForOpen(client: WebSocket, ms = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for open'));
    }, ms);
    timer.unref();
    client.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    client.once('close', () => {
      clearTimeout(timer);
      reject(new Error('Closed before open'));
    });
  });
}

/** Wait for a close event and return { code, reason }. */
function waitForClose(
  client: WebSocket,
  ms = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for close'));
    }, ms);
    timer.unref();
    client.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Wait for an `unexpected-response` (HTTP rejection) with its status code. */
function waitForHttpStatus(client: WebSocket, ms = 2000): Promise<number> {
  // Swallow any late `error` after the primary outcome to avoid unhandled
  // error events when the server destroys the socket post-rejection.
  client.on('error', () => {
    /* intentionally ignored */
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(-2);
    }, ms);
    timer.unref();
    client.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode ?? 0);
      // Drain the response so Node frees the connection handle.
      res.resume();
    });
    client.once('close', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}

/** Perform the full `session.join` handshake and return the server-side clientId. */
async function joinClient(
  port: number,
  token: string,
  onConnectIds: string[],
): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/inspector/ws?t=${token}`);
  await waitForOpen(client);
  const initialLength = onConnectIds.length;
  client.send(
    JSON.stringify({
      type: 'session.join',
      token,
      platform: 'web',
      clientId: 'test-client',
    }),
  );
  const ack = await waitForMessage(client);
  expect(ack.type).toBe('session.ack');
  // Server fires onConnect synchronously in completeJoin; wait a beat.
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 500;
    const check = (): void => {
      if (onConnectIds.length > initialLength) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(check, 5).unref();
    };
    check();
  });
  return client;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  httpServer: Server;
  transport: InspectorWebSocketServer;
  registry: FakeRegistry;
  port: number;
  token: string;
  connectIds: string[];
  messages: { clientId: string; msg: InspectorMessage }[];
  disconnectIds: string[];
}

async function setupFixture(extraRequestHandler?: (port: number) => void): Promise<Fixture> {
  const registry = new FakeRegistry();
  const token = 'valid-token-for-tests';
  registry.register(token, { label: 'test', createdAt: '2026-04-21T00:00:00Z' });

  const httpServer = createServer();
  const transport = createInspectorWebSocketServer({
    tokenRegistry: registry,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 100,
    handshakeTimeoutMs: 200,
  });
  attachInspectorUpgradeListener(httpServer, transport, { tokenRegistry: registry });

  const connectIds: string[] = [];
  const messages: { clientId: string; msg: InspectorMessage }[] = [];
  const disconnectIds: string[] = [];
  transport.onConnect((clientId) => connectIds.push(clientId));
  transport.onMessage((clientId, msg) => messages.push({ clientId, msg }));
  transport.onDisconnect((clientId) => disconnectIds.push(clientId));

  const port = await listenOnEphemeralPort(httpServer);
  extraRequestHandler?.(port);
  return { httpServer, transport, registry, port, token, connectIds, messages, disconnectIds };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createInspectorWebSocketServer', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setupFixture();
  });

  afterEach(async () => {
    await fx.transport.close();
    await closeHttpServer(fx.httpServer);
  });

  describe('upgrade gate', () => {
    it('rejects an upgrade without ?t=', async () => {
      const client = new WebSocket(`ws://127.0.0.1:${fx.port}/inspector/ws`);
      const status = await waitForHttpStatus(client);
      // 400 from the explicit rejection, -1 when `close` fires before the
      // HTTP response is parsed by ws.
      expect([400, -1]).toContain(status);
    });

    it('rejects an upgrade with an unknown token', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=definitely-not-real`,
      );
      const status = await waitForHttpStatus(client);
      expect([401, -1]).toContain(status);
    });

    it('rejects an upgrade at the wrong path', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/wrong?t=${fx.token}`,
      );
      client.on('error', () => {
        /* intentionally ignored — we expect the connection to fail */
      });
      // No handler claims the path — the connection should fail before open.
      const outcome = await Promise.race([
        waitForOpen(client).then(() => 'open' as const).catch(() => 'failed' as const),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), 300).unref();
        }),
      ]);
      expect(outcome).not.toBe('open');
      // Force-close the client so afterEach's server.close() can complete —
      // Node leaves the socket open when no upgrade handler claims the path.
      client.terminate();
    });
  });

  describe('post-upgrade handshake', () => {
    it('answers a valid session.join with session.ack carrying PROTOCOL_VERSION', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      client.send(
        JSON.stringify({
          type: 'session.join',
          token: fx.token,
          platform: 'web',
          clientId: 'c1',
        }),
      );
      const ack = await waitForMessage(client);
      expect(ack).toMatchObject({
        type: 'session.ack',
        protocolVersion: PROTOCOL_VERSION,
      });
      if (ack.type === 'session.ack') {
        expect(typeof ack.sessionId).toBe('string');
        expect(ack.sessionId.length).toBeGreaterThan(0);
      }
      client.close();
    });

    it('closes with 1002 EXPECTED_SESSION_JOIN when first frame is not session.join', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      const received: InspectorMessage[] = [];
      client.on('message', (data) => {
        received.push(JSON.parse(data.toString()) as InspectorMessage);
      });
      client.send(JSON.stringify({ type: 'pin.ack', pinId: 'p' }));
      const close = await waitForClose(client);
      expect(close.code).toBe(1002);
      expect(close.reason).toContain('EXPECTED_SESSION_JOIN');
      expect(received.some((m) => m.type === 'session.error')).toBe(true);
    });

    it('closes with 1002 INVALID_JSON on unparsable first frame', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      client.send('not json');
      const close = await waitForClose(client);
      expect(close.code).toBe(1002);
      expect(close.reason).toContain('INVALID_JSON');
    });

    it('closes with 1008 TOKEN_MISMATCH when session.join.token differs from upgrade token', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      const received: InspectorMessage[] = [];
      client.on('message', (data) => {
        received.push(JSON.parse(data.toString()) as InspectorMessage);
      });
      client.send(
        JSON.stringify({
          type: 'session.join',
          token: 'different',
          platform: 'web',
          clientId: 'c1',
        }),
      );
      const close = await waitForClose(client);
      expect(close.code).toBe(1008);
      expect(close.reason).toContain('TOKEN_MISMATCH');
      const err = received.find((m) => m.type === 'session.error');
      expect(err).toBeDefined();
      if (err !== undefined && err.type === 'session.error') {
        expect(err.code).toBe('TOKEN_MISMATCH');
      }
    });

    it('closes with 1002 UNKNOWN_PLATFORM on an unsupported platform string', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      client.send(
        JSON.stringify({
          type: 'session.join',
          token: fx.token,
          platform: 'android',
          clientId: 'c1',
        }),
      );
      const close = await waitForClose(client);
      expect(close.code).toBe(1002);
      expect(close.reason).toContain('UNKNOWN_PLATFORM');
    });

    it('closes with 1002 MALFORMED_SESSION_JOIN when required fields are missing', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      client.send(
        JSON.stringify({
          type: 'session.join',
          token: fx.token,
          platform: 'web',
          // no clientId
        }),
      );
      const close = await waitForClose(client);
      expect(close.code).toBe(1002);
      expect(close.reason).toContain('MALFORMED_SESSION_JOIN');
    });

    it('closes with 1008 HANDSHAKE_TIMEOUT when no frame arrives in time', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      const close = await waitForClose(client, 1000);
      expect(close.code).toBe(1008);
      expect(close.reason).toContain('HANDSHAKE_TIMEOUT');
    });
  });

  describe('InspectorTransport', () => {
    it('fires onConnect only after a successful join', async () => {
      // First client opens and waits (no join) — should not fire onConnect.
      const noJoin = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(noJoin);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50).unref();
      });
      expect(fx.connectIds).toHaveLength(0);

      // Second client joins.
      const joined = await joinClient(fx.port, fx.token, fx.connectIds);
      expect(fx.connectIds.length).toBeGreaterThanOrEqual(1);
      expect(typeof fx.connectIds[0]).toBe('string');
      expect(fx.connectIds[0].length).toBeGreaterThan(0);

      joined.close();
      noJoin.removeAllListeners();
      noJoin.terminate();
    });

    it('fires onMessage for frames received after join', async () => {
      const client = await joinClient(fx.port, fx.token, fx.connectIds);
      client.send(JSON.stringify({ type: 'pin.ack', pinId: 'p1' }));
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 1000;
        const check = (): void => {
          if (fx.messages.length > 0) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(check, 10).unref();
        };
        check();
      });
      expect(fx.messages.length).toBe(1);
      expect(fx.messages[0].msg).toEqual({ type: 'pin.ack', pinId: 'p1' });
      expect(fx.messages[0].clientId).toBe(fx.connectIds[0]);
      client.close();
    });

    it('does not fire onMessage for frames received before join', async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${fx.port}/inspector/ws?t=${fx.token}`,
      );
      await waitForOpen(client);
      client.send(JSON.stringify({ type: 'pin.ack', pinId: 'p1' }));
      await waitForClose(client);
      expect(fx.messages.length).toBe(0);
    });

    it('send delivers to exactly one client', async () => {
      const clientA = await joinClient(fx.port, fx.token, fx.connectIds);
      const clientB = await joinClient(fx.port, fx.token, fx.connectIds);
      expect(fx.connectIds.length).toBe(2);
      const [idA] = fx.connectIds;

      const receivedA: InspectorMessage[] = [];
      const receivedB: InspectorMessage[] = [];
      clientA.on('message', (data) => {
        receivedA.push(JSON.parse(data.toString()) as InspectorMessage);
      });
      clientB.on('message', (data) => {
        receivedB.push(JSON.parse(data.toString()) as InspectorMessage);
      });

      fx.transport.send(idA, {
        type: 'task.status',
        batchId: 'b',
        status: 'running',
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100).unref();
      });
      expect(receivedA).toHaveLength(1);
      expect(receivedA[0].type).toBe('task.status');
      expect(receivedB).toHaveLength(0);

      clientA.close();
      clientB.close();
    });

    it('send silently drops when clientId is unknown', async () => {
      expect(() => {
        fx.transport.send('no-such-client', {
          type: 'task.status',
          batchId: 'b',
          status: 'running',
        });
      }).not.toThrow();
    });

    it('broadcast delivers to every joined client', async () => {
      const clientA = await joinClient(fx.port, fx.token, fx.connectIds);
      const clientB = await joinClient(fx.port, fx.token, fx.connectIds);

      const receivedA: InspectorMessage[] = [];
      const receivedB: InspectorMessage[] = [];
      clientA.on('message', (data) => {
        receivedA.push(JSON.parse(data.toString()) as InspectorMessage);
      });
      clientB.on('message', (data) => {
        receivedB.push(JSON.parse(data.toString()) as InspectorMessage);
      });

      fx.transport.broadcast({
        type: 'task.status',
        batchId: 'b',
        status: 'running',
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100).unref();
      });
      expect(receivedA).toHaveLength(1);
      expect(receivedB).toHaveLength(1);
      expect(receivedA[0]).toEqual(receivedB[0]);

      clientA.close();
      clientB.close();
    });

    it('fires onDisconnect on clean close', async () => {
      const client = await joinClient(fx.port, fx.token, fx.connectIds);
      const [clientId] = fx.connectIds;
      client.close();
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 1000;
        const check = (): void => {
          if (fx.disconnectIds.includes(clientId)) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(check, 10).unref();
        };
        check();
      });
      expect(fx.disconnectIds).toContain(clientId);
    });
  });

  describe('heartbeat', () => {
    it('terminates a client that does not respond to ping within the timeout', async () => {
      const client = await joinClient(fx.port, fx.token, fx.connectIds);
      const [clientId] = fx.connectIds;

      // Suppress the automatic pong reply so the server sees the client as dead.
      const clientWithPong = client as WebSocket & { pong: (...args: unknown[]) => void };
      clientWithPong.pong = (): void => {
        /* swallow — simulate a deaf client */
      };

      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 1000;
        const check = (): void => {
          if (fx.disconnectIds.includes(clientId)) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(check, 25).unref();
        };
        check();
      });
      expect(fx.disconnectIds).toContain(clientId);
    });

    it('keeps a healthy client alive across multiple ticks', async () => {
      const client = await joinClient(fx.port, fx.token, fx.connectIds);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250).unref();
      });
      expect(fx.disconnectIds).toHaveLength(0);
      client.send(JSON.stringify({ type: 'pin.ack', pinId: 'p2' }));
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 500;
        const check = (): void => {
          if (fx.messages.length > 0) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(check, 10).unref();
        };
        check();
      });
      expect(fx.messages.some((entry) => entry.msg.type === 'pin.ack')).toBe(true);
      client.close();
    });
  });

  describe('duplicate attach', () => {
    it('throws on second attachInspectorUpgradeListener for the same server', () => {
      expect(() => {
        attachInspectorUpgradeListener(fx.httpServer, fx.transport, {
          tokenRegistry: fx.registry,
        });
      }).toThrow(InspectorUpgradeListenerAlreadyAttachedError);
    });
  });
});

describe('coexistence with existing HTTP routes', () => {
  it('does not interfere with non-upgrade HTTP requests on the same server', async () => {
    const registry = new FakeRegistry();
    const token = 'coexist-token';
    registry.register(token, { label: 't', createdAt: '2026-04-21T00:00:00Z' });

    const httpServer = createServer((req, res) => {
      if (req.url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const transport = createInspectorWebSocketServer({
      tokenRegistry: registry,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 2000,
      handshakeTimeoutMs: 1000,
    });
    attachInspectorUpgradeListener(httpServer, transport, { tokenRegistry: registry });
    const port = await listenOnEphemeralPort(httpServer);

    const body = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for /hello response'));
      }, 2000);
      timer.unref();
      httpGet(`http://127.0.0.1:${port}/hello`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      }).on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(body).toBe('ok');

    await transport.close();
    await closeHttpServer(httpServer);
  });
});
