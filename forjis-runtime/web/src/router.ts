/**
 * HTTP request router for the Forjis web dashboard API.
 *
 * Creates a request handler function compatible with http.createServer()
 * that matches incoming requests against defined endpoint patterns and
 * dispatches to the appropriate controller function. Uses simple string
 * splitting for path matching — no external routing framework.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  handleClient,
  handleTaskList,
  handlePlan,
  handleEvents,
  handleResources,
  handleConfig,
  handleRuntime,
  handleEventStream,
  handleTokenUsage,
  handleFileContent,
  handleTaskFileList,
  handleTaskFileContent,
  handleManifest,
  handleProjectFile,
  handlePluginFile,
  handleFavicon,
  handleNotFound,
} from './controllers.js';
import { extractPathParam } from './helpers.js';
import { isValidTaskId } from '@forjis/shared';
import { sendError } from './helpers.js';
import type { WebServerOptions } from './types.js';

/**
 * Creates the request handler for the web server.
 *
 * Returns a function compatible with http.createServer() that routes
 * incoming requests to the appropriate controller based on HTTP method
 * and URL path. Routes are matched in a specific order to prevent
 * ambiguous matches (e.g., /events/stream before /events).
 *
 * Route matching order (GET only):
 * 0.  GET /favicon.svg                   -> project-branded favicon SVG (unauthenticated)
 * 1.  GET /                              -> SolidJS client (index.html)
 * 2.  GET /api/tasks (exact)             -> task list
 * 3.  GET /api/tasks/:id/plan            -> pipeline plan
 * 4.  GET /api/tasks/:id/events/stream   -> SSE live events
 * 5.  GET /api/tasks/:id/events          -> task events
 * 6.  GET /api/tasks/:id/task-files      -> task directory file list
 * 7.  GET /api/tasks/:id/task-file       -> task directory file content
 * 8.  GET /api/tasks/:id/file            -> file content
 * 9.  GET /api/resources                 -> loaded resources
 * 10. GET /api/config                    -> resolved configuration
 * 11. GET /api/runtime                   -> runtime/process state
 * 12. GET /api/token-usage               -> token usage
 * 13. GET /api/plugins/file              -> plugin `.md` file content (text/plain)
 * 14. Any other non-/api GET             -> SolidJS client (SPA fallback)
 * 15. Everything else                    -> 404
 *
 * @param options - Server configuration including port and service implementations.
 * @returns A request handler function for http.createServer().
 */
export function createRouter(
  options: WebServerOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;
    const segments = pathname.split('/').filter(s => s !== '');

    // /favicon.svg is intentionally served BEFORE the auth gate.
    // Browsers cannot attach an `Authorization` header to favicon
    // requests, and the response is fully derived data (color + one
    // letter from the project directory name) — no filesystem access,
    // no secrets. Guard on method so non-GET still 404s.
    if (method === 'GET' && matchExact(segments, ['favicon.svg'])) {
      handleFavicon(req, res, options.projectDir);
      return;
    }

    if (!checkAuth(req, res, options.token)) {
      return;
    }

    if (method !== 'GET') {
      handleNotFound(req, res);
      return;
    }

    if (segments.length === 0) {
      if (options.clientDir !== undefined) {
        void handleClient('/', res, options.clientDir);
        return;
      }
      handleNotFound(req, res);
      return;
    }

    if (matchExact(segments, ['api', 'tasks'])) {
      void handleTaskList(req, res, options.taskService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'plan'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handlePlan(req, res, taskId, options.taskService, options.planService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'events', 'stream'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handleEventStream(req, res, taskId, options.taskService, options.eventService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'events'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handleEvents(req, res, taskId, options.taskService, options.eventService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'task-files'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handleTaskFileList(req, res, taskId, options.taskService, options.taskFileService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'task-file'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handleTaskFileContent(req, res, taskId, options.taskService, options.taskFileService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'manifest'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handleManifest(req, res, taskId, options.taskService, options.manifestService);
      return;
    }

    if (matchPattern(segments, ['api', 'tasks', null, 'file'])) {
      const taskId = extractPathParam(pathname, 2);
      if (!isValidTaskId(taskId)) {
        sendError(res, 400, 'INVALID_TASK_ID', `Invalid task ID: "${taskId}"`);
        return;
      }
      void handleFileContent(req, res, taskId, options.taskService, options.fileService);
      return;
    }

    if (matchExact(segments, ['api', 'project-file'])) {
      void handleProjectFile(req, res, options.taskService, options.fileService);
      return;
    }

    if (matchExact(segments, ['api', 'resources'])) {
      handleResources(req, res, options.resourceService);
      return;
    }

    if (matchExact(segments, ['api', 'config'])) {
      void handleConfig(req, res, options.configService, options.projectDir);
      return;
    }

    if (matchExact(segments, ['api', 'runtime'])) {
      void handleRuntime(req, res, options.runtimeService);
      return;
    }

    if (matchExact(segments, ['api', 'token-usage'])) {
      handleTokenUsage(req, res, options.tokenUsageService);
      return;
    }

    if (matchExact(segments, ['api', 'plugins', 'file'])) {
      void handlePluginFile(req, res, options.pluginFileService);
      return;
    }

    // Built-client fallback: when a client directory is configured, any
    // non-/api/* GET serves a file from the built SolidJS bundle or falls
    // back to index.html for SPA routes.
    if (
      options.clientDir !== undefined &&
      (segments[0] === undefined || segments[0] !== 'api')
    ) {
      void handleClient(pathname, res, options.clientDir);
      return;
    }

    handleNotFound(req, res);
  };
}

/** Pattern that matches the SSE streaming endpoint segments. */
const SSE_STREAM_PATTERN: (string | null)[] = ['api', 'tasks', null, 'events', 'stream'];

/**
 * Checks if the request is authenticated.
 *
 * Returns true if auth passes (or no token is configured).
 * Sends a 401 response and returns false if auth fails.
 *
 * Checks the Authorization header first. For the SSE streaming endpoint
 * only (`/api/tasks/:id/events/stream`), falls back to the `token` query
 * parameter because the `EventSource` API cannot set custom headers.
 * All other routes require the `Authorization: Bearer` header.
 *
 * @param req - The incoming HTTP request.
 * @param res - The server response to write 401 to on failure.
 * @param token - The expected token, or undefined if auth is disabled.
 * @returns True if the request is authorized.
 */
function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
): boolean {
  if (token === undefined) {
    return true;
  }

  const authHeader = req.headers['authorization'];
  if (authHeader !== undefined) {
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';
    if (bearerToken === token) {
      return true;
    }
    sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid authorization token');
    return false;
  }

  // Allow the ?token= query parameter only for the SSE streaming endpoint,
  // since EventSource cannot set custom headers.
  const url = req.url ?? '/';
  const parsed = new URL(url, 'http://localhost');
  const segments = parsed.pathname.split('/').filter(s => s !== '');
  if (matchPattern(segments, SSE_STREAM_PATTERN)) {
    const queryToken = parsed.searchParams.get('token');
    if (queryToken === token) {
      return true;
    }
  }

  sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid authorization token');
  return false;
}

/**
 * Checks if URL segments exactly match the expected fixed segments.
 *
 * Both length and every segment value must match.
 *
 * @param segments - The actual URL path segments (no empty strings).
 * @param expected - The expected segment values.
 * @returns True if the segments match exactly.
 */
function matchExact(segments: string[], expected: string[]): boolean {
  if (segments.length !== expected.length) {
    return false;
  }
  return expected.every((val, i) => segments[i] === val);
}

/**
 * Checks if URL segments match a pattern with optional wildcard positions.
 *
 * A null value in the expected array matches any segment value (wildcard).
 * Non-null values must match exactly. Segment counts must be equal.
 *
 * @param segments - The actual URL path segments (no empty strings).
 * @param expected - The expected pattern; null entries are wildcards.
 * @returns True if the segments match the pattern.
 */
function matchPattern(segments: string[], expected: (string | null)[]): boolean {
  if (segments.length !== expected.length) {
    return false;
  }
  return expected.every((val, i) => val === null || segments[i] === val);
}
