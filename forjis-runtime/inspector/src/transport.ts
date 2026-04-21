/**
 * Inspector WebSocket transport state machine for the browser SDK.
 *
 * `InspectorClient` owns a single logical Inspector session. It opens a
 * WebSocket, sends `session.join` as the first frame, waits for `session.ack`,
 * resolves a `ready` promise, flushes any queued outbound messages, and
 * transparently reconnects with jittered exponential backoff after an
 * unexpected close.
 *
 * The transport is intentionally decoupled from the DOM: `mount.ts` owns the
 * root `<div>` and the caller-visible handle. Tests inject a
 * `webSocketFactory` to drive the state machine with `mock-socket` while the
 * surrounding jsdom environment satisfies `document.body`.
 *
 * State-machine reference: see
 * `openspec/changes/inspector-007-inspector-package-scaffold/design.md` D2.
 */

import type { InspectorMessage, Platform } from '@forjis/shared';

// ---------------------------------------------------------------------------
// State-machine + queue + reconnect constants
// ---------------------------------------------------------------------------

/**
 * Internal state of an {@link InspectorClient} instance.
 *
 * See design D2 for the full transition table. `CLOSED` is both the initial
 * state and the terminal state after {@link InspectorClient.close}.
 */
type ClientState =
  | 'CLOSED'
  | 'CONNECTING'
  | 'AWAITING_ACK'
  | 'READY'
  | 'RECONNECTING';

/** Maximum outbound messages retained while the socket is not {@link ClientState.READY}. */
const MAX_QUEUE_SIZE = 1000;

/** Base delay used for the first reconnect attempt, before jitter. */
const RECONNECT_BASE_MS = 500;

/** Multiplicative factor applied to successive reconnect delays. */
const RECONNECT_FACTOR = 2;

/** Maximum delay any single reconnect attempt may wait, before jitter. */
const RECONNECT_CAP_MS = 30_000;

/** Symmetric jitter proportion applied to the computed raw delay. */
const RECONNECT_JITTER = 0.2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Union of session-error codes the SDK surfaces to callers.
 *
 * The enumerated members mirror the facilitator's server-side codes. The
 * trailing `string` admits forward-compatible codes introduced by future
 * server releases without breaking type-narrowing on the enumerated members.
 */
export type InspectorSessionErrorCode =
  | 'INVALID_JSON'
  | 'MALFORMED_FRAME'
  | 'MALFORMED_SESSION_JOIN'
  | 'UNKNOWN_PLATFORM'
  | 'TOKEN_MISMATCH'
  | 'EXPECTED_SESSION_JOIN'
  | 'SESSION_CLOSED_BEFORE_ACK'
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  | string;

/**
 * Typed error thrown from `ready` rejections and `onError` callbacks.
 *
 * Carries the protocol-level {@link code} plus an optional WebSocket
 * {@link closeCode} so callers can distinguish transport-level aborts from
 * server-side session errors.
 */
export class InspectorSessionError extends Error {
  /** Protocol-level error code identifying the failure category. */
  public readonly code: InspectorSessionErrorCode;

  /** Optional WebSocket close code observed alongside the error. */
  public readonly closeCode?: number;

  /**
   * Construct a new {@link InspectorSessionError}.
   *
   * @param code - Protocol-level code identifying the failure.
   * @param message - Human-readable message for logs and developer tooling.
   * @param closeCode - Optional WebSocket close code (1xxx range).
   */
  public constructor(
    code: InspectorSessionErrorCode,
    message: string,
    closeCode?: number,
  ) {
    super(message);
    this.name = 'InspectorSessionError';
    this.code = code;
    if (closeCode !== undefined) {
      this.closeCode = closeCode;
    }
  }
}

/**
 * Construction options for {@link InspectorClient}.
 */
export interface InspectorClientOptions {
  /** Absolute WebSocket URL including the `?t=<token>` query parameter. */
  readonly url: string;

  /** Session token sent in the `session.join` payload. */
  readonly token: string;

  /** Reported platform identifier; defaults to `"web"` for the browser SDK. */
  readonly platform?: Platform;

  /** Client identifier used in `session.join`; defaults to a random UUID. */
  readonly clientId?: string;

  /** Callback invoked for every inbound {@link InspectorMessage}. */
  readonly onMessage?: (msg: InspectorMessage) => void;

  /** Callback invoked whenever a session error is observed. */
  readonly onError?: (err: InspectorSessionError) => void;

  /**
   * Test seam for injecting a non-default WebSocket factory.
   *
   * Production code omits this field and relies on the default
   * `(url) => new WebSocket(url)` that picks up `mock-socket`'s global shim
   * under jsdom.
   */
  readonly webSocketFactory?: (url: string) => WebSocket;
}

// ---------------------------------------------------------------------------
// InspectorClient
// ---------------------------------------------------------------------------

/**
 * Manages a single Inspector session: handshake, queue, and reconnect.
 *
 * Instances open their socket synchronously in the constructor. The `ready`
 * promise resolves on the first `session.ack` and never re-resolves — later
 * reconnects transparently re-establish state without observable churn for
 * the caller. Call {@link InspectorClient.close} to perform a clean teardown.
 */
export class InspectorClient {
  private state: ClientState = 'CLOSED';

  private socket: WebSocket | null = null;

  private readonly queue: InspectorMessage[] = [];

  private attempt = 0;

  private currentSocketJoined = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readyResolved = false;

  private readonly resolveReady: () => void;

  private readonly rejectReady: (err: InspectorSessionError) => void;

  /** Resolves on the first `session.ack`, rejects on first-connect failure. */
  public readonly ready: Promise<void>;

  private readonly options: InspectorClientOptions;

  private readonly clientId: string;

  private readonly platform: Platform;

  private readonly factory: (url: string) => WebSocket;

  /**
   * Construct a new {@link InspectorClient} and open the underlying socket.
   *
   * @param options - Session configuration, including URL and token.
   */
  public constructor(options: InspectorClientOptions) {
    this.options = options;
    this.platform = options.platform ?? 'web';
    this.clientId = options.clientId ?? generateClientId();
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    let resolveFn: () => void = () => undefined;
    let rejectFn: (err: InspectorSessionError) => void = () => undefined;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.resolveReady = resolveFn;
    this.rejectReady = rejectFn;
    this.openSocket();
  }

  /**
   * Send an Inspector message, queueing when the socket is not yet ready.
   *
   * Messages sent before the current socket reaches `READY` are queued in
   * call order and flushed after `session.ack`. The queue is capped at
   * {@link MAX_QUEUE_SIZE}; on overflow the oldest message is dropped with a
   * `console.warn` so recent intent is preserved (design D3).
   *
   * @param msg - Inspector message to deliver.
   */
  public send(msg: InspectorMessage): void {
    if (this.state === 'READY' && this.currentSocketJoined && this.socket) {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    if (this.state === 'CLOSED') {
      return;
    }
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
      // eslint-disable-next-line no-console
      console.warn(
        '[forjis-inspector] outbound queue capped at ' +
          String(MAX_QUEUE_SIZE) +
          '; dropping oldest message',
      );
    }
    this.queue.push(msg);
  }

  /**
   * Close the session and terminate any pending reconnect.
   *
   * Idempotent — calling {@link close} a second time is a no-op. Clears the
   * outbound queue (any unsent messages are silently discarded) and requests
   * a clean `1000` close on the underlying socket when one is attached.
   */
  public close(): void {
    if (this.state === 'CLOSED') {
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.state = 'CLOSED';
    this.currentSocketJoined = false;
    this.queue.length = 0;
    if (socket) {
      try {
        socket.close(1000, 'CLIENT_UNMOUNT');
      } catch {
        // Browsers may throw on close() of an already-closing socket; ignore.
      }
    }
    this.socket = null;
  }

  /**
   * Open a fresh WebSocket and wire the handshake handlers.
   *
   * Callers invoke this in three contexts: construction, the reconnect timer,
   * and after an `AWAITING_ACK` failure. It transitions the machine to
   * `CONNECTING` and installs the `open`/`message`/`close`/`error` handlers
   * that drive subsequent transitions.
   */
  private openSocket(): void {
    if (this.state === 'CLOSED' && this.attempt > 0) {
      // `close()` was called while a reconnect was armed; do not open.
      return;
    }
    this.state = 'CONNECTING';
    this.attempt += 1;
    this.currentSocketJoined = false;
    const socket = this.factory(this.options.url);
    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen(socket));
    socket.addEventListener('message', (evt) => this.handleMessage(evt));
    socket.addEventListener('close', (evt) => this.handleClose(evt));
    socket.addEventListener('error', () => this.handleError());
  }

  /**
   * Handle the socket's `open` event by emitting `session.join`.
   *
   * Invariant (R-003): `session.join` is sent synchronously inside this
   * handler so the server's 5 s handshake timer observes the join before the
   * client could schedule anything else on the event loop. Do NOT refactor to
   * queue or defer this emit.
   *
   * @param socket - The socket whose `open` event fired.
   */
  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket || this.state !== 'CONNECTING') {
      return;
    }
    this.state = 'AWAITING_ACK';
    const joinFrame: InspectorMessage = {
      type: 'session.join',
      token: this.options.token,
      platform: this.platform,
      clientId: this.clientId,
    };
    socket.send(JSON.stringify(joinFrame));
  }

  /**
   * Route an inbound WebSocket message to the appropriate state handler.
   *
   * Bad JSON is surfaced via the `onError` callback and ignored — the server
   * is authoritative for session lifecycle, so a malformed frame does not
   * by itself transition the machine.
   *
   * @param evt - The WebSocket message event carrying the raw payload.
   */
  private handleMessage(evt: MessageEvent): void {
    let parsed: InspectorMessage;
    try {
      parsed = JSON.parse(typeof evt.data === 'string' ? evt.data : '') as InspectorMessage;
    } catch {
      this.emitError(
        new InspectorSessionError('INVALID_JSON', 'failed to parse inbound frame'),
      );
      return;
    }
    if (parsed.type === 'session.ack') {
      this.handleAck();
      return;
    }
    if (parsed.type === 'session.error') {
      this.handleSessionError(parsed.code, parsed.message);
      return;
    }
    if (this.options.onMessage) {
      this.options.onMessage(parsed);
    }
  }

  /**
   * Transition the machine to `READY`, resolve `ready`, and flush the queue.
   *
   * Only called from the message handler when a `session.ack` frame arrives
   * on the current socket. Earlier sockets' acks are impossible because the
   * per-socket closure ensures the current socket is the only active one.
   */
  private handleAck(): void {
    this.state = 'READY';
    this.currentSocketJoined = true;
    this.attempt = 0;
    if (!this.readyResolved) {
      this.readyResolved = true;
      this.resolveReady();
    }
    this.flushQueue();
  }

  /**
   * Drain the outbound queue onto the current socket in FIFO order.
   *
   * Precondition: {@link state} is `READY` and {@link currentSocketJoined} is
   * `true`. The caller guarantees this by invoking {@link flushQueue} only
   * from within {@link handleAck}.
   */
  private flushQueue(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next !== undefined) {
        socket.send(JSON.stringify(next));
      }
    }
  }

  /**
   * React to a server-sent `session.error` frame.
   *
   * On the first connect attempt this terminates the session with a
   * rejection on `ready`. After a successful ack, the same error arms a
   * reconnect — the server closed this socket but future sockets may
   * succeed once the underlying condition clears.
   *
   * @param code - Protocol-level error code from the server.
   * @param message - Human-readable message from the server.
   */
  private handleSessionError(code: string, message: string): void {
    const err = new InspectorSessionError(code, message);
    this.emitError(err);
    const wasReady = this.readyResolved;
    try {
      this.socket?.close(1002, 'SESSION_ERROR');
    } catch {
      // Ignore — the server is already tearing down the socket.
    }
    if (!wasReady) {
      this.rejectReadyOnce(err);
      this.state = 'CLOSED';
      this.socket = null;
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * React to the underlying socket's `close` event.
   *
   * Behaviour depends on the state at the moment of the close:
   * - `READY` closes unexpectedly — arm a reconnect.
   * - `CONNECTING` / `AWAITING_ACK` on the very first attempt — reject
   *   `ready` with `SESSION_CLOSED_BEFORE_ACK` and transition to `CLOSED`.
   * - `CONNECTING` / `AWAITING_ACK` after a prior successful ack — arm a
   *   reconnect so the caller does not observe the transient failure.
   *
   * @param evt - The close event carrying the WebSocket close code.
   */
  private handleClose(evt: CloseEvent): void {
    if (this.state === 'CLOSED') {
      return;
    }
    if (evt.code === 1000) {
      this.state = 'CLOSED';
      this.socket = null;
      return;
    }
    if (this.state === 'READY') {
      this.socket = null;
      this.scheduleReconnect();
      return;
    }
    // CONNECTING or AWAITING_ACK path.
    if (!this.readyResolved) {
      const err = new InspectorSessionError(
        'SESSION_CLOSED_BEFORE_ACK',
        'socket closed before session.ack (code=' + String(evt.code) + ')',
        evt.code,
      );
      this.rejectReadyOnce(err);
      this.state = 'CLOSED';
      this.socket = null;
      return;
    }
    this.socket = null;
    this.scheduleReconnect();
  }

  /**
   * Surface a WebSocket `error` event to the optional `onError` callback.
   *
   * The browser fires `error` immediately before `close`; the close handler
   * drives state. This method exists to propagate a generic transport
   * failure without altering state.
   */
  private handleError(): void {
    this.emitError(new InspectorSessionError('WS_ERROR', 'WebSocket error event'));
  }

  /**
   * Arm the reconnect timer using the jittered exponential-backoff curve.
   *
   * Delay formula per design D4. The first attempt fires within 600 ms (the
   * cap of `base + jitter`), well under the 1 s acceptance bound (FR-006).
   */
  private scheduleReconnect(): void {
    this.state = 'RECONNECTING';
    this.currentSocketJoined = false;
    const delay = computeBackoffDelay(this.attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== 'RECONNECTING') {
        return;
      }
      this.openSocket();
    }, delay);
  }

  /**
   * Reject the `ready` promise exactly once, no-op after it already settled.
   *
   * @param err - Error to reject with.
   */
  private rejectReadyOnce(err: InspectorSessionError): void {
    if (this.readyResolved) {
      return;
    }
    this.readyResolved = true;
    this.rejectReady(err);
  }

  /**
   * Forward an error to the optional `onError` callback, swallowing throws.
   *
   * @param err - Error to surface.
   */
  private emitError(err: InspectorSessionError): void {
    if (!this.options.onError) {
      return;
    }
    try {
      this.options.onError(err);
    } catch {
      // Caller-supplied error callbacks must not break the state machine.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the jittered backoff delay in milliseconds for the given attempt.
 *
 * Uses a capped exponential curve with symmetric jitter (design D4). Attempt
 * numbers are 1-indexed so the first reconnect uses the base delay.
 *
 * @param attempt - 1-indexed reconnect attempt number.
 * @returns Non-negative delay in milliseconds.
 */
function computeBackoffDelay(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(
    RECONNECT_CAP_MS,
    RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, exponent),
  );
  const jitter = raw * RECONNECT_JITTER * (Math.random() * 2 - 1);
  return Math.max(0, raw + jitter);
}

/**
 * Generate a non-empty client identifier for `session.join`.
 *
 * Prefers the standardised `crypto.randomUUID()` when available (modern
 * browsers and jsdom >=22). Falls back to a timestamp + random hex blob so
 * the SDK never emits an empty `clientId` (the facilitator's validator
 * rejects it).
 *
 * @returns Non-empty client identifier string.
 */
function generateClientId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  return 'client-' + String(Date.now()) + '-' + rand;
}
