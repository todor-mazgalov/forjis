/**
 * HTTP server factory for the Forjis web dashboard.
 *
 * Creates and starts a Node.js HTTP server using the router as the
 * request handler. The server listens on the configured port and
 * delegates all request processing to the router module. When the
 * caller supplies `options.inspector`, the factory also wires the
 * Inspector WebSocket upgrade listener onto the same HTTP server
 * before `listen(...)` so `/inspector/ws` is handled from the first
 * client connection.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import {
  attachInspectorUpgradeListener,
  type InspectorWebSocketServer,
} from './inspector-ws.js';
import { createRouter } from './router.js';
import type { WebServerOptions } from './types.js';

/**
 * Creates and starts the HTTP server for the web dashboard.
 *
 * Builds the request handler via createRouter() and starts listening
 * on the configured port. Returns the server instance so the caller
 * can manage its lifecycle (e.g., close on shutdown, call unref()).
 *
 * When `options.inspector` is present, the caller is responsible for
 * constructing `options.inspector.transport` via
 * `createInspectorWebSocketServer(...)` before invoking this factory.
 * The factory then attaches the upgrade listener to the newly-created
 * `http.Server` before `listen(...)`, guaranteeing that the very first
 * client upgrade after listen is handled. When `options.inspector` is
 * absent, behaviour is unchanged and no WebSocket endpoint is exposed.
 *
 * @param options - Server configuration including port and service
 *   implementations; optionally carries Inspector wiring.
 * @returns The created and listening http.Server instance.
 * @throws {TypeError} When `options.inspector.transport` is not a handle
 *   produced by `createInspectorWebSocketServer` (detected via the
 *   missing `close()` method sentinel).
 */
export function createWebServer(options: WebServerOptions): Server {
  const handler = createRouter(options);
  const server = createServer(handler);
  if (options.inspector !== undefined) {
    const transport = options.inspector.transport as Partial<InspectorWebSocketServer>;
    if (typeof transport.close !== 'function') {
      throw new TypeError(
        'options.inspector.transport must be an InspectorWebSocketServer (produced by createInspectorWebSocketServer)',
      );
    }
    attachInspectorUpgradeListener(
      server,
      transport as InspectorWebSocketServer,
      { tokenRegistry: options.inspector.tokenRegistry },
    );
  }
  server.listen(options.port, options.host ?? '127.0.0.1');
  return server;
}
