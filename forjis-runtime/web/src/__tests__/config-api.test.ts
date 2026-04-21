/**
 * Unit tests for the config API: handleConfig controller and router.
 *
 * Requirements validated:
 *   CONFIG-001 — GET /api/config route is wired and reachable
 *   CONFIG-001 — Controller returns 503 when configService is not provided
 *   CONFIG-001 — Controller returns 200 with ConfigResponse when service is provided
 *   CONFIG-001 — Controller returns 500 when service throws
 *   CONFIG-002/003/004/005/006 — ConfigResponse shape passes through controller unchanged
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleConfig } from '../controllers.js';
import { createRouter } from '../router.js';
import type { ConfigService } from '../services.js';
import type {
  ConfigResponse,
  WebServerOptions,
  ErrorResponse,
} from '../types.js';

// ===========================================================================
// Mock helpers (same pattern as api-layer.test.ts and token-usage-api.test.ts)
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
// Fixture data
// ===========================================================================

/** A complete ConfigResponse fixture matching the design.md D3 structure. */
const fixtureConfigResponse: ConfigResponse = {
  orgs: {
    version: 1,
    orgs: [
      {
        name: 'my-org',
        teams: [
          {
            name: 'core',
            roles: [
              {
                name: 'developer',
                agent: '/abs/path/forjis-developer.md',
                skills: ['/abs/path/skill-ts.md'],
                hooks: { pre: [], validation: [], post: [] },
                outcomes: ['quality'],
                stage: 'developer',
                expertise: 'TypeScript expert',
              },
            ],
          },
        ],
      },
    ],
  },
  constraints: {
    mandatory: 'Never push to main.',
    optional: '',
    pillars: [{ path: 'docs/pillar.md', content: '# Pillar content' }],
  },
  personas: {
    dir: '/abs/personas',
    personas: [
      {
        name: 'terry',
        description: 'A helpful persona',
        tools: ['Read', 'Write'],
        model: 'claude-sonnet-4-5',
        content: '# Terry\nA persona file.',
      },
    ],
  },
  tasks: {
    source: 'local',
    path: '.forjis/tasks',
    poll_interval: '5s',
    max_concurrent: 2,
    auto_dependencies: true,
  },
  healthCheck: {
    interval: 300,
    max_retries: 3,
  },
  tokenBudget: {},
  outcomes: {
    defaultAction: 'halt',
    defaultMaxRetries: 2,
    outcomes: [
      {
        name: 'quality',
        metrics: {},
        rules: [],
      },
    ],
  },
};

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

// ===========================================================================
// handleConfig controller tests
// ===========================================================================

describe('handleConfig controller', () => {
  /**
   * CONFIG-001: When configService is not provided, the controller must
   * return 503 SERVICE_UNAVAILABLE (qa.md: "When configService is not wired,
   * returns 503 SERVICE_UNAVAILABLE").
   */
  it('returns 503 with SERVICE_UNAVAILABLE when configService is undefined', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    await handleConfig(req, res, undefined);

    expect(res.statusCode).toBe(503);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error).toContain('Config service');
  });

  /**
   * CONFIG-001: When configService is provided, the controller returns 200
   * with the ConfigResponse JSON from the service.
   */
  it('returns 200 with ConfigResponse JSON when service is provided', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { return fixtureConfigResponse; },
    };

    await handleConfig(req, res, mockService);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    const body = parseBody<ConfigResponse>(res);
    expect(body.orgs.version).toBe(1);
    expect(body.orgs.orgs).toHaveLength(1);
    expect(body.orgs.orgs[0].name).toBe('my-org');
  });

  /**
   * CONFIG-002: Org hierarchy present in the response.
   */
  it('passes through orgs hierarchy including teams and roles', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { return fixtureConfigResponse; },
    };

    await handleConfig(req, res, mockService);

    const body = parseBody<ConfigResponse>(res);
    const org = body.orgs.orgs[0];
    expect(org.teams).toHaveLength(1);
    expect(org.teams[0].name).toBe('core');
    expect(org.teams[0].roles).toHaveLength(1);
    const role = org.teams[0].roles[0];
    expect(role.name).toBe('developer');
    expect(role.agent).toBe('/abs/path/forjis-developer.md');
    expect(role.skills).toEqual(['/abs/path/skill-ts.md']);
    expect(role.stage).toBe('developer');
    expect(role.expertise).toBe('TypeScript expert');
  });

  /**
   * CONFIG-003: Constraints section present in the response.
   */
  it('passes through constraints including mandatory text and pillars', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { return fixtureConfigResponse; },
    };

    await handleConfig(req, res, mockService);

    const body = parseBody<ConfigResponse>(res);
    expect(body.constraints.mandatory).toBe('Never push to main.');
    expect(body.constraints.optional).toBe('');
    expect(body.constraints.pillars).toHaveLength(1);
    expect(body.constraints.pillars[0].path).toBe('docs/pillar.md');
  });

  /**
   * CONFIG-004: Personas section present in the response with all fields.
   */
  it('passes through personas section with full persona data', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { return fixtureConfigResponse; },
    };

    await handleConfig(req, res, mockService);

    const body = parseBody<ConfigResponse>(res);
    expect(body.personas.personas).toHaveLength(1);
    const persona = body.personas.personas[0];
    expect(persona.name).toBe('terry');
    expect(persona.model).toBe('claude-sonnet-4-5');
    expect(persona.tools).toEqual(['Read', 'Write']);
  });

  /**
   * CONFIG-005: Task settings section present in the response.
   */
  it('passes through tasks and healthCheck sections', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { return fixtureConfigResponse; },
    };

    await handleConfig(req, res, mockService);

    const body = parseBody<ConfigResponse>(res);
    expect(body.tasks.source).toBe('local');
    expect(body.tasks.max_concurrent).toBe(2);
    expect(body.healthCheck.interval).toBe(300);
    expect(body.healthCheck.max_retries).toBe(3);
  });

  /**
   * CONFIG-006: Empty tokenBudget passes through as an empty object.
   */
  it('passes through empty tokenBudget as empty object', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { return { ...fixtureConfigResponse, tokenBudget: {} }; },
    };

    await handleConfig(req, res, mockService);

    const body = parseBody<ConfigResponse>(res);
    expect(body.tokenBudget).toEqual({});
  });

  /**
   * CONFIG-001: When the service throws, the controller returns 500
   * with INTERNAL_ERROR.
   */
  it('returns 500 with INTERNAL_ERROR when service throws', async () => {
    const req = makeMockReq('/api/config');
    const res = makeMockRes();

    const mockService: ConfigService = {
      async getConfig() { throw new Error('YAML parse failure'); },
    };

    await handleConfig(req, res, mockService);

    expect(res.statusCode).toBe(500);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).toContain('YAML parse failure');
  });
});

// ===========================================================================
// Router tests for GET /api/config
// ===========================================================================

describe('Router GET /api/config', () => {
  /**
   * CONFIG-001: The route GET /api/config is registered and dispatches to
   * handleConfig (not the 404 catch-all).
   */
  it('routes GET /api/config to handleConfig — returns 503 when no service', async () => {
    const options = makeMinimalOptions(); // no configService
    const router = createRouter(options);

    const req = makeMockReq('/api/config');
    const res = makeMockRes();
    router(req, res);

    // Wait for the async handler to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(res.statusCode).toBe(503);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  /**
   * CONFIG-001: Route must not fall through to 404.
   */
  it('route is matched before the 404 catch-all', async () => {
    const options = makeMinimalOptions(); // no configService
    const router = createRouter(options);

    const req = makeMockReq('/api/config');
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 10));

    // Should get 503 (service unavailable), NOT 404 (not found)
    expect(res.statusCode).toBe(503);
    expect(res.statusCode).not.toBe(404);
  });

  /**
   * CONFIG-001: Route returns 200 with ConfigResponse when service is provided.
   */
  it('routes GET /api/config and returns 200 with config data when service is wired', async () => {
    const mockService: ConfigService = {
      async getConfig() { return fixtureConfigResponse; },
    };

    const options = makeMinimalOptions({ configService: mockService });
    const router = createRouter(options);

    const req = makeMockReq('/api/config');
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(res.statusCode).toBe(200);
    const body = parseBody<ConfigResponse>(res);
    expect(body.orgs).toBeDefined();
    expect(body.constraints).toBeDefined();
    expect(body.personas).toBeDefined();
    expect(body.tasks).toBeDefined();
    expect(body.healthCheck).toBeDefined();
    expect(body.tokenBudget).toBeDefined();
    expect(body.outcomes).toBeDefined();
  });

  /**
   * Routing should not match POST /api/config (method guard).
   */
  it('POST /api/config returns 404 NOT_FOUND (method not allowed)', async () => {
    const options = makeMinimalOptions();
    const router = createRouter(options);

    const req = makeMockReq('/api/config', 'POST');
    const res = makeMockRes();
    router(req, res);

    expect(res.statusCode).toBe(404);
    const body = parseBody<ErrorResponse>(res);
    expect(body.code).toBe('NOT_FOUND');
  });
});
