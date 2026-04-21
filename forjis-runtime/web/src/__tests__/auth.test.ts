/**
 * Authentication tests for checkAuth (exercised via createRouter).
 *
 * The checkAuth function is the sole security boundary for the web API.
 * It is not exported directly, so these tests drive it through createRouter,
 * which calls checkAuth on every incoming request.
 *
 * Test matrix:
 *  1. No token configured → all requests pass regardless of headers/params
 *  2. Valid Authorization: Bearer <token> header → passes
 *  3. Authorization header present but wrong token → 401
 *  4. Authorization: Bearer with empty token value → 401
 *  5. Authorization header without "Bearer " prefix → 401
 *  6. No Authorization header, valid ?token= on SSE endpoint → passes
 *  7. No Authorization header, wrong ?token= on SSE endpoint → 401
 *  8. No Authorization header, valid ?token= on non-SSE endpoint → 401
 *  9. No Authorization header, no ?token= at all → 401
 * 10. Empty-string token value in query param → 401
 * 11. Empty-string configured token → matched correctly when header matches
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { createRouter } from '../router.js';

import type {
  TaskService,
  PlanService,
  EventService,
  ResourceService,
  FileService,
  TaskFileService,
  WebServerOptions,
  ResourcesResponse,
  ErrorResponse,
} from '../types.js';

// ===========================================================================
// Mock helpers
// ===========================================================================

/**
 * Builds a minimal mock ServerResponse that records written headers, status
 * code, and body. Only the subset of the interface used by helpers/controllers
 * is implemented.
 */
function makeMockRes() {
  const mock = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    ended: false,
    writeHead(status: number, hdrs?: Record<string, string>) {
      if (this.headersSent) return;
      this.statusCode = status;
      if (hdrs) Object.assign(this.headers, hdrs);
      this.headersSent = true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      this.ended = true;
    },
    write(chunk: string) {
      this.body += chunk;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    writableEnded: false,
    on(_event: string, _cb: () => void) { return this; },
  };
  return mock as unknown as ServerResponse & typeof mock;
}

/**
 * Builds a minimal mock IncomingMessage.
 * Pass `headers` to simulate Authorization or other headers.
 *
 * The returned value is also an EventEmitter; tests that exercise the SSE
 * route must call `(req as unknown as EventEmitter).emit('close')` after
 * invoking the router so that handleEventStream's cleanup handler clears
 * the poll and keepalive intervals it installs. See the
 * `openedSseRequests` tracker below — it emits 'close' on every SSE-path
 * request in afterEach so tests do not leak timers.
 */
function makeMockReq(
  url = '/',
  method = 'GET',
  headers: Record<string, string> = {},
): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.url = url;
  emitter.method = method;
  emitter.headers = headers as IncomingMessage['headers'];
  if (url.includes('/events/stream')) {
    openedSseRequests.push(emitter);
  }
  return emitter;
}

/**
 * Tracks every SSE-path request emitted by tests in this file so that the
 * global afterEach below can fire a 'close' event on each. The SSE handler
 * only installs intervals after checking taskExists resolves to true and
 * auth passes, but tracking all SSE requests is cheap and ensures no
 * cleanup is missed.
 */
const openedSseRequests: IncomingMessage[] = [];

afterEach(() => {
  while (openedSseRequests.length > 0) {
    const req = openedSseRequests.shift()!;
    try {
      (req as unknown as EventEmitter).emit('close');
    } catch {
      /* already cleaned up */
    }
  }
});

/** Parses the body of a mock response as JSON. */
function parseBody<T>(res: ReturnType<typeof makeMockRes>): T {
  return JSON.parse(res.body) as T;
}

// ===========================================================================
// Stub service factories
// ===========================================================================

function makeTaskService(overrides: Partial<TaskService> = {}): TaskService {
  return {
    async listTasks() { return []; },
    async taskExists() { return true; },
    ...overrides,
  };
}

function makePlanService(overrides: Partial<PlanService> = {}): PlanService {
  return {
    async getPlan() { return null; },
    ...overrides,
  };
}

function makeEventService(overrides: Partial<EventService> = {}): EventService {
  return {
    async getEvents() { return []; },
    async getEventsSince() { return []; },
    ...overrides,
  };
}

function makeResourceService(overrides: Partial<ResourceService> = {}): ResourceService {
  return {
    getResources(): ResourcesResponse {
      return { orgs: [], agents: [], skills: [], hooks: [], plugins: [] };
    },
    ...overrides,
  };
}

function makeWebServerOptions(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return {
    port: 9999,
    taskService: makeTaskService(),
    planService: makePlanService(),
    eventService: makeEventService(),
    resourceService: makeResourceService(),
    ...overrides,
  };
}

/** A well-known task ID used across tests (must pass isValidTaskId). */
const TASK_ID = 'task-1';

/** The SSE streaming URL for the well-known task. */
const SSE_URL = `/api/tasks/${TASK_ID}/events/stream`;

/** A non-SSE API URL. */
const TASKS_URL = '/api/tasks';

// ===========================================================================
// 1. No token configured → all requests pass
// ===========================================================================

describe('checkAuth — no token configured (token: undefined)', () => {
  const router = createRouter(makeWebServerOptions({ token: undefined }));

  test('allows request without any Authorization header', () => {
    const req = makeMockReq(TASKS_URL);
    const res = makeMockRes();
    router(req, res);
    // 401 would be the only sign of checkAuth failure; anything else is ok
    expect(res.statusCode).not.toBe(401);
  });

  test('allows request with an Authorization header present', () => {
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: 'Bearer sometoken' });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).not.toBe(401);
  });

  test('allows SSE endpoint request without headers or query params', () => {
    const req = makeMockReq(SSE_URL);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).not.toBe(401);
  });
});

// ===========================================================================
// 2. Token configured — Authorization header cases
// ===========================================================================

describe('checkAuth — token configured, Authorization header', () => {
  const SECRET = 'my-secret-token';
  const router = createRouter(makeWebServerOptions({ token: SECRET }));

  test('valid Bearer token in Authorization header → request is authorized', () => {
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: `Bearer ${SECRET}` });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).not.toBe(401);
  });

  test('wrong Bearer token in Authorization header → 401', () => {
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: 'Bearer wrong-token' });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  test('Authorization header without Bearer prefix → 401', () => {
    // e.g. "Basic ..." or just the raw token
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: SECRET });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('Authorization header with "Bearer " prefix but empty token → 401', () => {
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: 'Bearer ' });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('Authorization header present with empty string value → 401', () => {
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: '' });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('response body contains UNAUTHORIZED code on auth failure', () => {
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: 'Bearer bad' });
    const res = makeMockRes();
    router(req, res);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. Token configured — query-param token (SSE endpoint only)
// ===========================================================================

describe('checkAuth — token configured, query-param ?token= on SSE endpoint', () => {
  const SECRET = 'sse-secret';
  const router = createRouter(makeWebServerOptions({ token: SECRET }));

  test('valid ?token= on SSE endpoint → authorized (no header needed)', () => {
    const req = makeMockReq(`${SSE_URL}?token=${SECRET}`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).not.toBe(401);
  });

  test('wrong ?token= on SSE endpoint → 401', () => {
    const req = makeMockReq(`${SSE_URL}?token=wrong`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('empty ?token= on SSE endpoint → 401', () => {
    const req = makeMockReq(`${SSE_URL}?token=`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('no ?token= on SSE endpoint and no header → 401', () => {
    const req = makeMockReq(SSE_URL);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('?token= is accepted alongside a valid Authorization header on SSE endpoint', () => {
    // Header takes priority; if header is valid, we never even check query param.
    const req = makeMockReq(
      `${SSE_URL}?token=${SECRET}`,
      'GET',
      { authorization: `Bearer ${SECRET}` },
    );
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).not.toBe(401);
  });
});

// ===========================================================================
// 4. Token configured — query-param rejected on non-SSE endpoints
// ===========================================================================

describe('checkAuth — token configured, query-param ?token= on non-SSE endpoints', () => {
  const SECRET = 'header-only-secret';
  const router = createRouter(makeWebServerOptions({ token: SECRET }));

  test('valid ?token= on /api/tasks (non-SSE) → 401', () => {
    const req = makeMockReq(`${TASKS_URL}?token=${SECRET}`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('valid ?token= on /api/resources (non-SSE) → 401', () => {
    const req = makeMockReq(`/api/resources?token=${SECRET}`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('valid ?token= on /api/tasks/:id/events (not the stream sub-path) → 401', () => {
    const req = makeMockReq(`/api/tasks/${TASK_ID}/events?token=${SECRET}`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });

  test('valid ?token= on dashboard root / → 401', () => {
    const req = makeMockReq(`/?token=${SECRET}`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ===========================================================================
// 5. Edge cases
// ===========================================================================

describe('checkAuth — edge cases', () => {
  test('configured token that is an empty string is matched when header sends empty Bearer', () => {
    // If someone sets token: '', then Bearer  (space only) should slice to ''
    // and match. This verifies the slice(7) logic for empty token configs.
    const router = createRouter(makeWebServerOptions({ token: '' }));
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: 'Bearer ' });
    const res = makeMockRes();
    router(req, res);
    // 'Bearer '.slice(7) === '' which equals token ''
    expect(res.statusCode).not.toBe(401);
  });

  test('auth failure stops further routing — no controller response body overwritten', () => {
    const SECRET = 'stop-routing';
    const router = createRouter(makeWebServerOptions({ token: SECRET }));
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: 'Bearer wrong' });
    const res = makeMockRes();
    router(req, res);
    // Response must be ended (sendError calls res.end)
    expect(res.ended).toBe(true);
    // Status must be exactly 401
    expect(res.statusCode).toBe(401);
    // No second write should have occurred (Content-Type from sendError only)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
  });

  test('Authorization header check is case-insensitive for header name (node lower-cases headers)', () => {
    // Node.js lower-cases all incoming header names, so 'Authorization' arrives
    // as 'authorization'. Verify our mock matches this real-world behaviour.
    const SECRET = 'case-test';
    const router = createRouter(makeWebServerOptions({ token: SECRET }));
    const req = makeMockReq(TASKS_URL, 'GET', { authorization: `Bearer ${SECRET}` });
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).not.toBe(401);
  });

  test('query param and no header on SSE endpoint with mismatched token returns 401', () => {
    const SECRET = 'correct';
    const router = createRouter(makeWebServerOptions({ token: SECRET }));
    const req = makeMockReq(`${SSE_URL}?token=incorrect`);
    const res = makeMockRes();
    router(req, res);
    expect(res.statusCode).toBe(401);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('UNAUTHORIZED');
  });
});
