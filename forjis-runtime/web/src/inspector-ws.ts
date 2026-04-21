/**
 * Server-side Inspector WebSocket transport.
 *
 * This module implements the on-the-wire WebSocket transport for the
 * Inspector v1.0 protocol frozen in `@forjis/shared/src/inspector-types.ts`.
 * It is designed to compose into the existing facilitator HTTP server
 * (`createWebServer`) without touching the `/api/*` or SSE routes:
 *
 *   1. {@link createInspectorWebSocketServer} builds a no-server
 *      `WebSocketServer` plus a client registry and returns a handle that
 *      satisfies the `InspectorTransport` contract from `@forjis/shared`.
 *   2. {@link attachInspectorUpgradeListener} subscribes the handle's
 *      upgrade behaviour to an existing `node:http.Server` via the
 *      `upgrade` event. Connection gating (token check, path filter) runs
 *      before any WebSocket handshake bytes are emitted.
 *
 * The transport is a local-only debug channel: the facilitator binds to
 * `127.0.0.1` by default, the session token (query parameter `?t=<token>`)
 * is the bearer credential, and no TLS / `Origin` check is performed.
 *
 * See `openspec/changes/inspector-002-facilitator-websocket/design.md` for
 * the close-code matrix (D9), the handshake state machine (D8), and the
 * heartbeat algorithm (D12).
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import {
  type RawData,
  WebSocket,
  WebSocketServer,
} from 'ws';
import {
  PROTOCOL_VERSION,
  type InspectorMessage,
  type InspectorTransport,
  type Platform,
  type SessionTokenRegistryLike,
} from '@forjis/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path the upgrade listener filters on. */
const DEFAULT_PATH = '/inspector/ws';

/** Default heartbeat interval — server pings every client this often. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default window after which a non-responsive client is terminated. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

/** Default time a just-upgraded socket has to send `session.join`. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Time {@link InspectorWebSocketServer.close} waits for clients to drain. */
const SHUTDOWN_GRACE_MS = 1_000;

/** Closed set of platforms accepted in `session.join.platform`. */
const ALLOWED_PLATFORMS: readonly Platform[] = ['web', 'compose', 'swiftui'];

/** Property tag used to detect duplicate attach on the same HTTP server. */
const ATTACHED_SYMBOL = Symbol.for('@forjis/inspector-ws.attached');

// ---------------------------------------------------------------------------
// Module-local types
// ---------------------------------------------------------------------------

/** Lifecycle of a single connected client, as tracked by the registry. */
type ClientState = 'awaiting_join' | 'joined' | 'closed';

/** Per-connection bookkeeping kept alongside each live WebSocket. */
interface Client {
  /** Server-assigned connection identifier. */
  readonly clientId: string;
  /** Underlying WebSocket. */
  readonly socket: WebSocket;
  /** Current state in the handshake state machine. */
  state: ClientState;
  /** Token pulled from `?t=<token>` at upgrade time; used for mismatch check. */
  readonly upgradeToken: string;
  /** Armed during `awaiting_join`; cleared on successful join or close. */
  handshakeTimer: NodeJS.Timeout | null;
  /** Heartbeat flag — see the `ws` README `isAlive` pattern. */
  isAlive: boolean;
  /** ISO-8601 timestamp of `session.ack`, or `null` before the join succeeds. */
  joinedAt: string | null;
}

/** Shape of a validated `session.join` payload. */
interface SessionJoinPayload {
  readonly type: 'session.join';
  readonly token: string;
  readonly platform: Platform;
  readonly clientId: string;
}

/** Result of {@link validateSessionJoin}. */
type SessionJoinValidation =
  | { ok: true; value: SessionJoinPayload }
  | { ok: false; reason: 'MALFORMED_SESSION_JOIN' | 'UNKNOWN_PLATFORM' };

/**
 * `IncomingMessage` extended with the upgrade-time session token.
 *
 * The upgrade listener stamps `__forjisUpgradeToken` on the request after
 * {@link SessionTokenRegistryLike.validate} succeeds so the `connection`
 * handler can pick it up without depending on module-global state.
 */
interface InspectorUpgradeRequest extends IncomingMessage {
  __forjisUpgradeToken?: string;
}

// ---------------------------------------------------------------------------
// Exported types and errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link attachInspectorUpgradeListener} when invoked a second
 * time against the same HTTP server instance.
 *
 * The first attach is sticky for the server's lifetime; attaching twice
 * would double-fire every upgrade event, so we fail loudly.
 */
export class InspectorUpgradeListenerAlreadyAttachedError extends Error {
  /** Static name matches the class to aid `err.name`-based diagnostics. */
  public override readonly name = 'InspectorUpgradeListenerAlreadyAttachedError';

  /** Construct with a fixed, non-leaky message. */
  constructor() {
    super(
      'An Inspector upgrade listener has already been attached to this http.Server instance.',
    );
  }
}

/**
 * Options accepted by {@link createInspectorWebSocketServer}.
 *
 * Every heartbeat / handshake interval is expressed in milliseconds and
 * has a production-safe default; tests override them to keep deterministic
 * timings within the jest budget.
 */
export interface CreateInspectorWebSocketServerOptions {
  /** Registry consulted at upgrade time to gate incoming connections. */
  tokenRegistry: SessionTokenRegistryLike;
  /** Path filter applied at upgrade time. Defaults to `/inspector/ws`. */
  path?: string;
  /** How often the server sends ping control frames. Defaults to 30 s. */
  heartbeatIntervalMs?: number;
  /** Deadline after which a non-responsive client is terminated. Defaults to 60 s. */
  heartbeatTimeoutMs?: number;
  /** Time an upgraded client has to send `session.join`. Defaults to 5 s. */
  handshakeTimeoutMs?: number;
}

/**
 * Server-side Inspector WebSocket transport handle.
 *
 * Implements the `InspectorTransport` contract from `@forjis/shared` plus
 * {@link InspectorWebSocketServer.close} for graceful teardown (used by
 * tests and by the CLI on `forjis dev` shutdown).
 */
export interface InspectorWebSocketServer extends InspectorTransport {
  /**
   * Gracefully tear down the transport.
   *
   * Clears the heartbeat interval, emits a 1001 `SERVER_SHUTDOWN` close to
   * every live client, and resolves once every socket has fired `close` or
   * a 1 s grace period elapses.
   *
   * @returns A promise that resolves once the transport is quiescent.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-local bridge: InspectorWebSocketServer → internal WebSocketServer
// ---------------------------------------------------------------------------

/**
 * Internal bridge keyed by the public handle. Lets
 * {@link attachInspectorUpgradeListener} reach the private `WebSocketServer`
 * without exposing it on the public interface.
 */
const internalBridge = new WeakMap<
  InspectorWebSocketServer,
  { wss: WebSocketServer; options: CreateInspectorWebSocketServerOptions }
>();

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Minimal framing check for inbound frames in the `joined` state.
 *
 * Per-case field validation is deferred to inspector-003; this guard only
 * confirms that the parsed value is a non-null object with a string `type`
 * field, so the discriminated-union narrowing in downstream handlers is
 * type-safe.
 *
 * @param value - Value produced by `JSON.parse`.
 * @returns `true` when `value` has the minimum Inspector framing shape.
 */
function isInspectorMessage(value: unknown): value is InspectorMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Validate a parsed `session.join` payload.
 *
 * @param value - Value produced by `JSON.parse`; assumed to already pass
 *   {@link isInspectorMessage}.
 * @returns Either a typed success envelope with the narrowed payload, or a
 *   failure envelope naming the first validation reason.
 */
function validateSessionJoin(value: unknown): SessionJoinValidation {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'MALFORMED_SESSION_JOIN' };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'session.join') {
    return { ok: false, reason: 'MALFORMED_SESSION_JOIN' };
  }
  if (typeof candidate.token !== 'string' || candidate.token.length === 0) {
    return { ok: false, reason: 'MALFORMED_SESSION_JOIN' };
  }
  if (typeof candidate.clientId !== 'string' || candidate.clientId.length === 0) {
    return { ok: false, reason: 'MALFORMED_SESSION_JOIN' };
  }
  if (typeof candidate.platform !== 'string') {
    return { ok: false, reason: 'MALFORMED_SESSION_JOIN' };
  }
  if (!ALLOWED_PLATFORMS.includes(candidate.platform as Platform)) {
    return { ok: false, reason: 'UNKNOWN_PLATFORM' };
  }
  return {
    ok: true,
    value: {
      type: 'session.join',
      token: candidate.token,
      clientId: candidate.clientId,
      platform: candidate.platform as Platform,
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a server-side Inspector WebSocket transport.
 *
 * Constructs a `WebSocketServer` in no-server mode (upgrades are routed
 * by {@link attachInspectorUpgradeListener}), initialises an empty client
 * registry, and arms the heartbeat interval. The returned handle
 * satisfies `InspectorTransport` so downstream facilitator code can inject
 * it wherever the interface is expected.
 *
 * @param options - Configuration bundle; see
 *   {@link CreateInspectorWebSocketServerOptions}.
 * @returns A fresh transport handle ready for
 *   {@link attachInspectorUpgradeListener}.
 */
export function createInspectorWebSocketServer(
  options: CreateInspectorWebSocketServerOptions,
): InspectorWebSocketServer {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<string, Client>();
  const connectHandlers: ((clientId: string) => void)[] = [];
  const messageHandlers: ((
    clientId: string,
    msg: InspectorMessage,
  ) => void)[] = [];
  const disconnectHandlers: ((clientId: string) => void)[] = [];

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    registerClient({
      wss,
      socket,
      req,
      clients,
      connectHandlers,
      messageHandlers,
      disconnectHandlers,
      handshakeTimeoutMs,
    });
  });

  const heartbeat = setInterval(() => {
    runHeartbeatTick(clients);
  }, heartbeatIntervalMs);
  heartbeat.unref();

  const handle: InspectorWebSocketServer = {
    onConnect(handler) {
      connectHandlers.push(handler);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onDisconnect(handler) {
      disconnectHandlers.push(handler);
    },
    send(clientId, msg) {
      deliverToClient(clients, clientId, msg);
    },
    broadcast(msg) {
      deliverToAllClients(clients, msg);
    },
    async close() {
      clearInterval(heartbeat);
      await gracefulShutdown(clients);
      wss.close();
    },
  };

  internalBridge.set(handle, { wss, options });
  return handle;
}

// ---------------------------------------------------------------------------
// Public upgrade wiring
// ---------------------------------------------------------------------------

/**
 * Subscribe the supplied transport to the supplied HTTP server's `upgrade`
 * event.
 *
 * Must be called before `httpServer.listen(...)` so that the very first
 * client upgrade after listen is handled. Calling twice on the same server
 * throws {@link InspectorUpgradeListenerAlreadyAttachedError}.
 *
 * The listener:
 *   1. Parses the request URL and filters on `options.path` (default
 *      `/inspector/ws`). Non-matching paths are ignored, preserving any
 *      other upgrade handler's routes.
 *   2. Reads `?t=<token>` and validates against `options.tokenRegistry`.
 *      Missing or unknown tokens yield a raw HTTP 400/401 response plus
 *      `socket.destroy()` — the WebSocket handshake never runs.
 *   3. Stamps the validated token on the request and delegates to the
 *      transport's `handleUpgrade` bridge. The internal `connection`
 *      handler then transitions the new socket into `awaiting_join`.
 *
 * @param httpServer - The existing HTTP server to attach to.
 * @param transport - A transport built by
 *   {@link createInspectorWebSocketServer}.
 * @param options - Must supply the token registry used at upgrade time;
 *   `path` overrides the default.
 * @throws {InspectorUpgradeListenerAlreadyAttachedError} When the same
 *   `httpServer` has already been attached.
 * @throws {TypeError} When `transport` was not produced by
 *   {@link createInspectorWebSocketServer}.
 */
export function attachInspectorUpgradeListener(
  httpServer: Server,
  transport: InspectorWebSocketServer,
  options: { tokenRegistry: SessionTokenRegistryLike; path?: string },
): void {
  const taggedServer = httpServer as Server & { [ATTACHED_SYMBOL]?: boolean };
  if (taggedServer[ATTACHED_SYMBOL] === true) {
    throw new InspectorUpgradeListenerAlreadyAttachedError();
  }
  taggedServer[ATTACHED_SYMBOL] = true;

  const bridge = internalBridge.get(transport);
  if (bridge === undefined) {
    throw new TypeError(
      'transport was not produced by createInspectorWebSocketServer',
    );
  }

  const path = options.path ?? DEFAULT_PATH;
  const { wss } = bridge;

  httpServer.on(
    'upgrade',
    (req: IncomingMessage, socket: Socket, head: Buffer) => {
      handleUpgrade({
        req,
        socket,
        head,
        path,
        tokenRegistry: options.tokenRegistry,
        wss,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Upgrade + connection helpers
// ---------------------------------------------------------------------------

/**
 * Core upgrade dispatcher. Parses the URL, enforces the path + token
 * gates, and either destroys the socket or hands the upgrade off to `ws`.
 *
 * @param args - Bundled upgrade context.
 */
function handleUpgrade(args: {
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  path: string;
  tokenRegistry: SessionTokenRegistryLike;
  wss: WebSocketServer;
}): void {
  const { req, socket, head, path, tokenRegistry, wss } = args;
  const parsed = new URL(req.url ?? '/', 'http://localhost');
  if (parsed.pathname !== path) {
    return;
  }

  const token = parsed.searchParams.get('t');
  if (token === null || token.length === 0) {
    respondAndDestroy(socket, 400, 'Bad Request');
    return;
  }
  if (token.length > 256) {
    respondAndDestroy(socket, 400, 'Bad Request');
    return;
  }
  if (tokenRegistry.validate(token) === null) {
    respondAndDestroy(socket, 401, 'Unauthorized');
    return;
  }

  const typedReq = req as InspectorUpgradeRequest;
  typedReq.__forjisUpgradeToken = token;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

/**
 * Write a bare HTTP status line to the raw socket and destroy it.
 *
 * Used for pre-handshake rejection (missing / invalid token, oversize
 * token). No body is emitted — the client only needs the status code.
 *
 * @param socket - Raw TCP socket from the `upgrade` event.
 * @param status - HTTP status code (400 or 401).
 * @param statusText - Short RFC 7231 reason phrase.
 */
function respondAndDestroy(
  socket: Socket,
  status: number,
  statusText: string,
): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\n\r\n`);
  socket.destroy();
}

/**
 * Register a freshly-upgraded WebSocket in the client map and wire its
 * state-machine handlers.
 *
 * @param args - Bundled registration context.
 */
function registerClient(args: {
  wss: WebSocketServer;
  socket: WebSocket;
  req: IncomingMessage;
  clients: Map<string, Client>;
  connectHandlers: ((clientId: string) => void)[];
  messageHandlers: ((clientId: string, msg: InspectorMessage) => void)[];
  disconnectHandlers: ((clientId: string) => void)[];
  handshakeTimeoutMs: number;
}): void {
  const {
    socket,
    req,
    clients,
    connectHandlers,
    messageHandlers,
    disconnectHandlers,
    handshakeTimeoutMs,
  } = args;

  const typedReq = req as InspectorUpgradeRequest;
  const upgradeToken = typedReq.__forjisUpgradeToken ?? '';
  const clientId = randomBytes(16).toString('base64url');

  const client: Client = {
    clientId,
    socket,
    state: 'awaiting_join',
    upgradeToken,
    handshakeTimer: null,
    isAlive: true,
    joinedAt: null,
  };
  clients.set(clientId, client);

  client.handshakeTimer = setTimeout(() => {
    if (client.state === 'awaiting_join') {
      socket.close(1008, 'HANDSHAKE_TIMEOUT');
    }
  }, handshakeTimeoutMs);

  socket.on('pong', () => {
    client.isAlive = true;
  });

  socket.on('message', (data: RawData) => {
    handleInboundFrame(client, data, messageHandlers, connectHandlers);
  });

  socket.on('close', () => {
    teardownClient(client, clients, disconnectHandlers);
  });

  socket.on('error', () => {
    teardownClient(client, clients, disconnectHandlers);
  });
}

/**
 * Dispatch a single inbound frame through the D8 state machine.
 *
 * Pre-join frames either complete the handshake or close the socket; once
 * `joined`, every parsable frame is forwarded verbatim to the registered
 * `onMessage` handlers.
 *
 * @param client - The client that produced the frame.
 * @param data - Raw WebSocket payload.
 * @param messageHandlers - Current `onMessage` subscribers.
 * @param connectHandlers - Current `onConnect` subscribers (fired on join).
 */
function handleInboundFrame(
  client: Client,
  data: RawData,
  messageHandlers: ((clientId: string, msg: InspectorMessage) => void)[],
  connectHandlers: ((clientId: string) => void)[],
): void {
  if (client.state === 'closed') {
    return;
  }

  const parsed = tryParseJson(data);
  if (parsed === undefined) {
    closeWithSessionError(client, 'INVALID_JSON', 'Frame was not valid JSON.', 1002, 'INVALID_JSON');
    return;
  }

  if (client.state === 'awaiting_join') {
    processJoinFrame(client, parsed, connectHandlers);
    return;
  }

  if (!isInspectorMessage(parsed)) {
    closeWithSessionError(
      client,
      'MALFORMED_FRAME',
      'Frame did not match the Inspector message envelope.',
      1002,
      'MALFORMED_FRAME',
    );
    return;
  }

  for (const handler of messageHandlers) {
    handler(client.clientId, parsed);
  }
}

/**
 * Run the `awaiting_join` → `joined` transition or close on failure.
 *
 * @param client - The client undergoing the handshake.
 * @param parsed - Payload parsed from the first frame.
 * @param connectHandlers - Subscribers notified on successful join.
 */
function processJoinFrame(
  client: Client,
  parsed: unknown,
  connectHandlers: ((clientId: string) => void)[],
): void {
  if (!isInspectorMessage(parsed)) {
    closeWithSessionError(
      client,
      'EXPECTED_SESSION_JOIN',
      'First frame must be session.join.',
      1002,
      'EXPECTED_SESSION_JOIN',
    );
    return;
  }

  if (parsed.type !== 'session.join') {
    closeWithSessionError(
      client,
      'EXPECTED_SESSION_JOIN',
      'First frame must be session.join.',
      1002,
      'EXPECTED_SESSION_JOIN',
    );
    return;
  }

  const validation = validateSessionJoin(parsed);
  if (!validation.ok) {
    const reason = validation.reason;
    const closeCode = reason === 'UNKNOWN_PLATFORM' ? 1002 : 1002;
    closeWithSessionError(
      client,
      reason,
      reason === 'UNKNOWN_PLATFORM'
        ? 'Unknown platform.'
        : 'session.join payload is malformed.',
      closeCode,
      reason,
    );
    return;
  }

  if (validation.value.token !== client.upgradeToken) {
    closeWithSessionError(
      client,
      'TOKEN_MISMATCH',
      'session.join.token does not match the upgrade token.',
      1008,
      'TOKEN_MISMATCH',
    );
    return;
  }

  completeJoin(client, connectHandlers);
}

/**
 * Transition a client to `joined` and emit `session.ack`.
 *
 * @param client - The client completing the handshake.
 * @param connectHandlers - Subscribers notified on successful join.
 */
function completeJoin(
  client: Client,
  connectHandlers: ((clientId: string) => void)[],
): void {
  if (client.handshakeTimer !== null) {
    clearTimeout(client.handshakeTimer);
    client.handshakeTimer = null;
  }
  client.state = 'joined';
  client.joinedAt = new Date().toISOString();

  const sessionId = randomBytes(16).toString('base64url');
  const ack: InspectorMessage = {
    type: 'session.ack',
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
  };
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(ack));
  }

  for (const handler of connectHandlers) {
    handler(client.clientId);
  }
}

/**
 * Send a `session.error` frame and close the socket with the matching
 * protocol close code.
 *
 * The error message sent to the client is a fixed, token-free string so
 * no internal state leaks out.
 *
 * @param client - Client to close.
 * @param code - Machine-readable error code placed in the
 *   `session.error.code` field.
 * @param message - Short human-readable error text.
 * @param wsCode - WebSocket close code (1002 for protocol, 1008 for policy).
 * @param reason - WebSocket close reason string.
 */
function closeWithSessionError(
  client: Client,
  code: string,
  message: string,
  wsCode: number,
  reason: string,
): void {
  if (client.state === 'closed') {
    return;
  }
  if (client.handshakeTimer !== null) {
    clearTimeout(client.handshakeTimer);
    client.handshakeTimer = null;
  }
  if (client.socket.readyState === WebSocket.OPEN) {
    const frame: InspectorMessage = { type: 'session.error', code, message };
    try {
      client.socket.send(JSON.stringify(frame));
    } catch {
      /* socket already torn down — fall through to close */
    }
  }
  try {
    client.socket.close(wsCode, reason);
  } catch {
    client.socket.terminate();
  }
}

/**
 * Remove a client from the registry and fire `onDisconnect` subscribers.
 *
 * Idempotent — calling twice (e.g. from both `close` and `error`) is a
 * no-op on the second call.
 *
 * @param client - Client record being torn down.
 * @param clients - Registry the client lives in.
 * @param disconnectHandlers - Subscribers notified on disconnect.
 */
function teardownClient(
  client: Client,
  clients: Map<string, Client>,
  disconnectHandlers: ((clientId: string) => void)[],
): void {
  if (client.state === 'closed') {
    return;
  }
  const wasJoined = client.state === 'joined';
  client.state = 'closed';
  if (client.handshakeTimer !== null) {
    clearTimeout(client.handshakeTimer);
    client.handshakeTimer = null;
  }
  clients.delete(client.clientId);
  if (wasJoined) {
    for (const handler of disconnectHandlers) {
      handler(client.clientId);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Run one heartbeat sweep.
 *
 * Any client flagged `isAlive === false` has not responded to the previous
 * ping and is terminated. Every remaining client is flagged
 * `isAlive = false` and pinged; the next tick (or the pong handler that
 * flips it back to `true`) resolves the outcome.
 *
 * @param clients - Client registry to sweep.
 */
function runHeartbeatTick(clients: Map<string, Client>): void {
  for (const client of clients.values()) {
    if (!client.isAlive) {
      client.socket.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.socket.ping();
    } catch {
      client.socket.terminate();
    }
  }
}

// ---------------------------------------------------------------------------
// Send / broadcast / shutdown
// ---------------------------------------------------------------------------

/**
 * Deliver a message to a single joined client.
 *
 * Silent-drop semantics per design D13: unknown client, non-joined state,
 * and closed sockets all short-circuit without throwing.
 *
 * @param clients - Client registry to look up in.
 * @param clientId - Server-assigned connection identifier.
 * @param msg - Inspector message to serialise and send.
 */
function deliverToClient(
  clients: Map<string, Client>,
  clientId: string,
  msg: InspectorMessage,
): void {
  const client = clients.get(clientId);
  if (client === undefined) {
    return;
  }
  if (client.state !== 'joined') {
    return;
  }
  if (client.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  client.socket.send(JSON.stringify(msg));
}

/**
 * Deliver a message to every joined client.
 *
 * The payload is serialised exactly once and reused across every socket
 * send.
 *
 * @param clients - Client registry.
 * @param msg - Inspector message to serialise and broadcast.
 */
function deliverToAllClients(
  clients: Map<string, Client>,
  msg: InspectorMessage,
): void {
  const payload = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (client.state !== 'joined') {
      continue;
    }
    if (client.socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    client.socket.send(payload);
  }
}

/**
 * Emit `SERVER_SHUTDOWN` close frames to every live client and wait for
 * their `close` events (capped at {@link SHUTDOWN_GRACE_MS}).
 *
 * @param clients - Client registry being drained.
 * @returns A promise that resolves when every socket has closed or the
 *   grace period has elapsed.
 */
async function gracefulShutdown(clients: Map<string, Client>): Promise<void> {
  const pendingCloses: Promise<void>[] = [];
  for (const client of clients.values()) {
    pendingCloses.push(closeOneClient(client));
  }
  await Promise.race([
    Promise.all(pendingCloses).then(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      timer.unref();
    }),
  ]);
}

/**
 * Send `close 1001 SERVER_SHUTDOWN` to a single client and resolve on its
 * `close` event.
 *
 * @param client - Client being closed.
 * @returns A promise resolving when the client's socket fires `close`.
 */
function closeOneClient(client: Client): Promise<void> {
  return new Promise<void>((resolve) => {
    client.socket.once('close', () => resolve());
    try {
      client.socket.close(1001, 'SERVER_SHUTDOWN');
    } catch {
      client.socket.terminate();
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// JSON helper
// ---------------------------------------------------------------------------

/**
 * Parse a WebSocket frame as JSON without throwing.
 *
 * Accepts any `RawData` shape (Buffer, ArrayBuffer, Buffer[]) because `ws`
 * does not normalise the incoming data.
 *
 * @param data - Raw WebSocket payload.
 * @returns The parsed JSON value, or `undefined` when parsing fails.
 */
function tryParseJson(data: RawData): unknown {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else if (Array.isArray(data)) {
    text = Buffer.concat(data).toString('utf8');
  } else {
    text = Buffer.from(data).toString('utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
