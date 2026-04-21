/**
 * Smoke test: `--web` serves the built SolidJS client.
 *
 * Boots the web server against the real `client/dist/` directory (built by
 * the package postbuild script) and verifies that `GET /` returns:
 *   - HTTP 200
 *   - `Content-Type: text/html`
 *   - a response body containing a `<script type="module"` tag referencing
 *     the Vite entry bundle under `/assets/`.
 *
 * When `client/dist/index.html` is missing (because the client build has
 * not yet run), the suite is skipped with a clear explanation instead of
 * failing — the repo root `npm run build` invokes the Vite build as part
 * of the web package's postbuild step and that is the supported path for
 * producing a shippable bundle.
 */

import { createWebServer } from '../server.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { WebServerOptions } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(__dirname, '..', '..', 'client', 'dist');
const clientIndex = join(clientDir, 'index.html');
const clientBuilt = existsSync(clientIndex);

/**
 * Constructs a WebServerOptions object pointing at the built SolidJS client.
 *
 * Only the fields required by the router are provided; services are stubbed
 * with minimal implementations since the smoke test never calls `/api/*`.
 */
function makeOptions(): WebServerOptions {
  return {
    port: 0,
    host: '127.0.0.1',
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
    },
    resourceService: {
      getResources() {
        return { orgs: [], agents: [], skills: [], hooks: [], plugins: [] };
      },
    },
    clientDir,
  };
}

/**
 * Issues `GET <path>` against the running server and returns status,
 * headers, and body. Uses `fetch` against the bound port.
 */
async function getText(port: number, path: string): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body,
  };
}

const describeOrSkip = clientBuilt ? describe : describe.skip;

describeOrSkip('--web serves built SolidJS client', () => {
  if (!clientBuilt) {
    // eslint-disable-next-line no-console
    console.warn(
      `[web-serves-solid-client] client/dist/index.html not present at ${clientIndex} — smoke test skipped. Run \`npm run build\` in forjis-runtime/ to build the client.`
    );
  }

  /**
   * Boots the server, runs the test function against its bound port, and
   * closes the server regardless of test outcome.
   */
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const server = createWebServer(makeOptions());
    try {
      await new Promise<void>((resolvePromise) => {
        server.once('listening', () => resolvePromise());
      });
      const addr = server.address() as AddressInfo;
      await fn(addr.port);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }

  test('GET / returns 200 with an HTML body', async () => {
    await withServer(async (port) => {
      const response = await getText(port, '/');
      expect(response.status).toBe(200);
      expect(response.contentType).toMatch(/text\/html/);
      expect(response.body).toMatch(/<!doctype html>/i);
    });
  });

  test('GET / body includes a <script type="module"> tag referencing the Vite bundle', async () => {
    await withServer(async (port) => {
      const response = await getText(port, '/');
      expect(response.body).toMatch(/<script\s+type="module"[^>]*src="\/assets\/[^"]+\.js"/);
    });
  });

  test('SPA deep-link falls back to index.html', async () => {
    await withServer(async (port) => {
      const response = await getText(port, '/tasks/some-task');
      expect(response.status).toBe(200);
      expect(response.contentType).toMatch(/text\/html/);
      expect(response.body).toMatch(/<script\s+type="module"/);
    });
  });
});
