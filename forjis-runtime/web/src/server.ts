/**
 * HTTP server factory for the Forjis web dashboard.
 *
 * Creates and starts a Node.js HTTP server using the router as the
 * request handler. The server listens on the configured port and
 * delegates all request processing to the router module.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createRouter } from './router.js';
import type { WebServerOptions } from './types.js';

/**
 * Creates and starts the HTTP server for the web dashboard.
 *
 * Builds the request handler via createRouter() and starts listening
 * on the configured port. Returns the server instance so the caller
 * can manage its lifecycle (e.g., close on shutdown, call unref()).
 *
 * @param options - Server configuration including port and service implementations.
 * @returns The created and listening http.Server instance.
 */
export function createWebServer(options: WebServerOptions): Server {
  const handler = createRouter(options);
  const server = createServer(handler);
  server.listen(options.port, options.host ?? '127.0.0.1');
  return server;
}
