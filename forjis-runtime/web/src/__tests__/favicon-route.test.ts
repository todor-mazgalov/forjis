/**
 * Unit tests for the GET /favicon.svg route and its handleFavicon controller.
 *
 * Requirements validated:
 *   - FAVICON-001 Controller returns 200 with `Content-Type: image/svg+xml`
 *     and a `Cache-Control: public, max-age=86400` header.
 *   - FAVICON-002 Response body is a valid SVG containing the expected
 *     uppercased project letter derived from the project directory name.
 *   - FAVICON-003 Repeated calls with the same `projectDir` return the
 *     identical SVG byte-for-byte (in-memory cache hit).
 *   - FAVICON-004 Different `projectDir` values produce different SVGs —
 *     specifically different `hsl(...)` background colors — so two forjis
 *     instances are visually disambiguated in the browser tab strip.
 *   - FAVICON-005 Falsy `projectDir` renders a neutral fallback icon with
 *     an `F` letter rather than 500-ing.
 *   - FAVICON-006 Router dispatches GET /favicon.svg to handleFavicon
 *     without requiring authentication (browsers cannot attach an
 *     `Authorization` header to favicon fetches).
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleFavicon, clearFaviconCache } from '../controllers.js';
import { createRouter } from '../router.js';
import type { WebServerOptions } from '../types.js';
import { stringToColor } from '@forjis/shared';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as config-api.test.ts / runtime-api.test.ts)
// ---------------------------------------------------------------------------

/** Minimal `ServerResponse` stand-in that captures status, headers, and body. */
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

/** Minimal `IncomingMessage` stand-in with `url` + `method`. */
function makeMockReq(url = '/favicon.svg', method = 'GET'): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.url = url;
  emitter.method = method;
  return emitter;
}

/** Router options that satisfy the service-interface contract but omit the
 *  optional services the favicon path never touches. */
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

/** Extracts the `hsl(...)` background fill from a rendered favicon SVG. */
function extractBackgroundFill(svg: string): string | null {
  const match = svg.match(/<rect[^>]*fill="([^"]+)"/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Controller-level tests
// ---------------------------------------------------------------------------

describe('handleFavicon controller', () => {
  beforeEach(() => {
    clearFaviconCache();
  });

  it('returns 200 with Content-Type image/svg+xml and a day-long Cache-Control', () => {
    const req = makeMockReq();
    const res = makeMockRes();

    handleFavicon(req, res, 'D:/Z/forjis-v5');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('public, max-age=86400');
  });

  it('renders the uppercase first letter of the project directory name', () => {
    const req = makeMockReq();
    const res = makeMockRes();

    handleFavicon(req, res, '/home/developer/my-project');

    // The body must be a valid-looking SVG containing the letter "M" inside
    // a <text> element. We match on the tag boundary so we can't be fooled
    // by an accidental letter appearing in an attribute value.
    expect(res.body).toMatch(/^<svg /);
    expect(res.body).toContain('</svg>');
    expect(res.body).toMatch(/>M<\/text>/);
  });

  it('returns the identical SVG byte-for-byte for the same projectDir (cache hit)', () => {
    const firstReq = makeMockReq();
    const firstRes = makeMockRes();
    const secondReq = makeMockReq();
    const secondRes = makeMockRes();

    handleFavicon(firstReq, firstRes, '/home/dev/alpha');
    handleFavicon(secondReq, secondRes, '/home/dev/alpha');

    expect(firstRes.body).toBe(secondRes.body);
    expect(firstRes.body.length).toBeGreaterThan(0);
  });

  it('produces a different background color for a different projectDir', () => {
    const resAlpha = makeMockRes();
    const resBeta = makeMockRes();

    handleFavicon(makeMockReq(), resAlpha, '/home/dev/alpha');
    handleFavicon(makeMockReq(), resBeta, '/home/dev/beta');

    const fillAlpha = extractBackgroundFill(resAlpha.body);
    const fillBeta = extractBackgroundFill(resBeta.body);
    expect(fillAlpha).not.toBeNull();
    expect(fillBeta).not.toBeNull();
    expect(fillAlpha).not.toBe(fillBeta);
    // Cross-check: both must match the shared `stringToColor` output so the
    // favicon and the in-app `ProjectIcon` cannot drift apart.
    expect(fillAlpha).toBe(stringToColor('/home/dev/alpha'));
    expect(fillBeta).toBe(stringToColor('/home/dev/beta'));
  });

  it('renders a neutral fallback icon with letter "F" when projectDir is missing', () => {
    const req = makeMockReq();
    const res = makeMockRes();

    handleFavicon(req, res, undefined);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/>F<\/text>/);
    // The fallback uses a muted grey, not the hashed `hsl(...)` palette.
    const fill = extractBackgroundFill(res.body);
    expect(fill).not.toBeNull();
    expect(fill).not.toMatch(/^hsl\(/);
  });

  it('handles Windows-style backslash paths the same way as POSIX paths', () => {
    const req = makeMockReq();
    const res = makeMockRes();

    handleFavicon(req, res, 'D:\\Z\\forjis-v5');

    // Last segment is `forjis-v5`, first letter "F" uppercased.
    expect(res.body).toMatch(/>F<\/text>/);
  });
});

// ---------------------------------------------------------------------------
// Router integration: unauthenticated dispatch + projectDir plumbing
// ---------------------------------------------------------------------------

describe('Router GET /favicon.svg', () => {
  beforeEach(() => {
    clearFaviconCache();
  });

  it('dispatches GET /favicon.svg to handleFavicon with options.projectDir', async () => {
    const options = makeMinimalOptions({ projectDir: '/srv/projects/gamma' });
    const router = createRouter(options);

    const req = makeMockReq('/favicon.svg');
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 5));

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/svg+xml; charset=utf-8');
    // "gamma" → letter "G"
    expect(res.body).toMatch(/>G<\/text>/);
  });

  it('serves /favicon.svg WITHOUT authentication even when a token is configured', async () => {
    const options = makeMinimalOptions({
      projectDir: '/srv/projects/delta',
      token: 'secret-token',
    });
    const router = createRouter(options);

    const req = makeMockReq('/favicon.svg'); // no Authorization header
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 5));

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/>D<\/text>/);
  });

  it('POST /favicon.svg falls through (does not invoke the favicon handler)', async () => {
    const options = makeMinimalOptions({ projectDir: '/srv/projects/epsilon' });
    const router = createRouter(options);

    const req = makeMockReq('/favicon.svg', 'POST');
    const res = makeMockRes();
    router(req, res);

    await new Promise(resolve => setTimeout(resolve, 5));

    // Non-GET does not match the favicon branch — router proceeds and
    // eventually 404s.
    expect(res.headers['Content-Type']).not.toBe('image/svg+xml; charset=utf-8');
    expect(res.statusCode).toBe(404);
  });
});
