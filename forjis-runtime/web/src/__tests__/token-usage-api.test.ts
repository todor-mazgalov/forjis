/**
 * Unit tests for the token usage API: handleTokenUsage controller and router.
 *
 * Requirements validated:
 *   FR-004 — GET /api/token-usage endpoint returns correct response
 *   FR-005 — TokenUsageService integration with controller
 *   FR-006 — Error handling (503 when service absent, 500 on throw)
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleTokenUsage } from '../controllers.js';
import { createRouter } from '../router.js';
import type { TokenUsageService } from '../services.js';
import type { TokenUsageResponse, WebServerOptions, ErrorResponse } from '../types.js';

// ===========================================================================
// Mock helpers (same pattern as api-layer.test.ts)
// ===========================================================================

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

// ===========================================================================
// handleTokenUsage controller tests
// ===========================================================================

describe('handleTokenUsage controller', () => {
  it('returns 503 with SERVICE_UNAVAILABLE code when tokenUsageService is undefined', () => {
    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();

    handleTokenUsage(req, res, undefined);

    expect(res.statusCode).toBe(503);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error).toContain('Token usage service');
  });

  it('returns 200 with valid TokenUsageResponse JSON when service is provided', () => {
    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();

    const mockUsage: TokenUsageResponse = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      windowStartedAt: '2026-03-25T10:00:00.000Z',
      lastUpdatedAt: '2026-03-25T10:05:00.000Z',
      budget: null,
    };

    const mockService: TokenUsageService = {
      getTokenUsage() { return mockUsage; },
    };

    handleTokenUsage(req, res, mockService);

    expect(res.statusCode).toBe(200);
    const body = parseBody<TokenUsageResponse>(res);
    expect(body.inputTokens).toBe(1000);
    expect(body.outputTokens).toBe(500);
    expect(body.totalTokens).toBe(1500);
    expect(body.windowStartedAt).toBe('2026-03-25T10:00:00.000Z');
    expect(body.lastUpdatedAt).toBe('2026-03-25T10:05:00.000Z');
    expect(body.budget).toBeNull();
  });

  it('returns 200 with budget info when budget is configured', () => {
    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();

    const mockUsage: TokenUsageResponse = {
      inputTokens: 5000,
      outputTokens: 3000,
      totalTokens: 8000,
      windowStartedAt: '2026-03-25T10:00:00.000Z',
      lastUpdatedAt: '2026-03-25T10:05:00.000Z',
      budget: { maxTokens: 100_000, resetWindowMs: 3_600_000 },
    };

    const mockService: TokenUsageService = {
      getTokenUsage() { return mockUsage; },
    };

    handleTokenUsage(req, res, mockService);

    expect(res.statusCode).toBe(200);
    const body = parseBody<TokenUsageResponse>(res);
    expect(body.budget).not.toBeNull();
    expect(body.budget!.maxTokens).toBe(100_000);
    expect(body.budget!.resetWindowMs).toBe(3_600_000);
  });

  it('returns 500 with INTERNAL_ERROR when service throws', () => {
    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();

    const mockService: TokenUsageService = {
      getTokenUsage() { throw new Error('Tracker exploded'); },
    };

    handleTokenUsage(req, res, mockService);

    expect(res.statusCode).toBe(500);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).toContain('Tracker exploded');
  });
});

// ===========================================================================
// Router tests for /api/token-usage
// ===========================================================================

describe('Router /api/token-usage', () => {
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
      },
      resourceService: {
        getResources() { return { orgs: [], agents: [], skills: [], hooks: [], plugins: [] }; },
      },
      ...overrides,
    };
  }

  it('GET /api/token-usage routes to handleTokenUsage', () => {
    const mockUsage: TokenUsageResponse = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      windowStartedAt: '2026-03-25T10:00:00.000Z',
      lastUpdatedAt: '2026-03-25T10:00:01.000Z',
      budget: null,
    };

    const mockService: TokenUsageService = {
      getTokenUsage() { return mockUsage; },
    };

    const options = makeMinimalOptions({ tokenUsageService: mockService });
    const router = createRouter(options);

    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();
    router(req, res);

    expect(res.statusCode).toBe(200);
    const body = parseBody<TokenUsageResponse>(res);
    expect(body.inputTokens).toBe(100);
    expect(body.totalTokens).toBe(150);
  });

  it('GET /api/token-usage returns 503 when tokenUsageService is not configured', () => {
    const options = makeMinimalOptions(); // no tokenUsageService
    const router = createRouter(options);

    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();
    router(req, res);

    expect(res.statusCode).toBe(503);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('route is matched before the 404 catch-all', () => {
    const options = makeMinimalOptions(); // no tokenUsageService
    const router = createRouter(options);

    const req = makeMockReq('/api/token-usage');
    const res = makeMockRes();
    router(req, res);

    // Should get 503 (service unavailable), NOT 404 (not found)
    expect(res.statusCode).toBe(503);
    expect(res.statusCode).not.toBe(404);
  });
});
