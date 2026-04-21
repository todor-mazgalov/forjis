/**
 * Contract tests for the GET /api/runtime endpoint (Phase L1 of
 * redesign-013-api-contract-extensions).
 *
 * Asserts:
 *   - 503 SERVICE_UNAVAILABLE when no runtimeService is wired.
 *   - 200 + RuntimeResponse JSON when the stub service returns a payload
 *     without a cost field — the cost field MUST be absent (not null, not 0).
 *   - 200 + RuntimeResponse JSON with cost present when the stub returns
 *     `cost: { total, currency }`.
 *   - The router dispatches GET /api/runtime to handleRuntime (not the
 *     404 catch-all).
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleRuntime } from '../controllers.js';
import { createRouter } from '../router.js';
import type { RuntimeService } from '../services.js';
import type {
  RuntimeResponse,
  WebServerOptions,
  ErrorResponse,
} from '../types.js';

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

function makeMockReq(url = '/', method = 'GET'): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.url = url;
  emitter.method = method;
  return emitter;
}

function parseBody<T>(res: ReturnType<typeof makeMockRes>): T {
  return JSON.parse(res.body) as T;
}

function makeMinimalOptions(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return {
    port: 0,
    taskService: {
      async listTasks() { return []; },
      async taskExists() { return true; },
    },
    planService: {
      async getPlan() { return null; },
    },
    eventService: {
      async getEvents() { return []; },
      async getEventsSince() { return []; },
      async getEventsForRole() { return []; },
      async getEventsByRole() { return []; },
    },
    resourceService: {
      getResources() { return { orgs: [], agents: [], skills: [], hooks: [], plugins: [] }; },
    },
    ...overrides,
  };
}

describe('handleRuntime controller', () => {
  it('returns 503 with SERVICE_UNAVAILABLE when runtimeService is undefined', async () => {
    const req = makeMockReq('/api/runtime');
    const res = makeMockRes();

    await handleRuntime(req, res, undefined);

    expect(res.statusCode).toBe(503);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error).toContain('Runtime service');
  });

  it('returns 200 with RuntimeResponse omitting cost when service omits cost', async () => {
    const req = makeMockReq('/api/runtime');
    const res = makeMockRes();

    const stub: RuntimeService = {
      async getRuntime() {
        return {
          version: '0.5.1',
          workers: { busy: 1, max: 3 },
          gitBranch: 'forjis/stage',
        };
      },
    };

    await handleRuntime(req, res, stub);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    const body = parseBody<RuntimeResponse>(res);
    expect(body.version).toBe('0.5.1');
    expect(body.workers).toEqual({ busy: 1, max: 3 });
    expect(body.gitBranch).toBe('forjis/stage');
    // The "do not invent zero" contract — cost must be absent, not 0, not null.
    expect('cost' in body).toBe(false);
    expect(body.cost).toBeUndefined();
  });

  it('returns 200 with RuntimeResponse including cost when service emits cost', async () => {
    const req = makeMockReq('/api/runtime');
    const res = makeMockRes();

    const stub: RuntimeService = {
      async getRuntime() {
        return {
          version: '0.5.1',
          workers: { busy: 0, max: 1 },
          cost: { total: 0.42, currency: 'USD' },
          gitBranch: null,
        };
      },
    };

    await handleRuntime(req, res, stub);

    expect(res.statusCode).toBe(200);
    const body = parseBody<RuntimeResponse>(res);
    expect(body.cost).toEqual({ total: 0.42, currency: 'USD' });
    expect(body.gitBranch).toBeNull();
  });

  it('returns 500 INTERNAL_ERROR when the service throws', async () => {
    const req = makeMockReq('/api/runtime');
    const res = makeMockRes();

    const stub: RuntimeService = {
      async getRuntime() { throw new Error('worker accessor crashed'); },
    };

    await handleRuntime(req, res, stub);

    expect(res.statusCode).toBe(500);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).toContain('worker accessor crashed');
  });
});

describe('Router GET /api/runtime', () => {
  it('routes GET /api/runtime to handleRuntime — returns 503 when no service', async () => {
    const options = makeMinimalOptions();
    const router = createRouter(options);

    const req = makeMockReq('/api/runtime');
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(res.statusCode).toBe(503);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('routes GET /api/runtime and returns 200 with runtime data when service is wired', async () => {
    const stub: RuntimeService = {
      async getRuntime() {
        return {
          version: '1.2.3',
          workers: { busy: 2, max: 4 },
          gitBranch: 'main',
        };
      },
    };

    const options = makeMinimalOptions({ runtimeService: stub });
    const router = createRouter(options);

    const req = makeMockReq('/api/runtime');
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(res.statusCode).toBe(200);
    const body = parseBody<RuntimeResponse>(res);
    expect(body.version).toBe('1.2.3');
    expect(body.workers).toEqual({ busy: 2, max: 4 });
    expect(body.gitBranch).toBe('main');
    expect('cost' in body).toBe(false);
  });

  it('POST /api/runtime returns 404 NOT_FOUND (method not allowed)', async () => {
    const options = makeMinimalOptions();
    const router = createRouter(options);

    const req = makeMockReq('/api/runtime', 'POST');
    const res = makeMockRes();
    router(req, res);

    expect(res.statusCode).toBe(404);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('NOT_FOUND');
  });
});
