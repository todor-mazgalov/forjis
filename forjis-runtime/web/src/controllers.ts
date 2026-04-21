/**
 * Controller functions for the Forjis web dashboard API endpoints.
 *
 * Each controller is a thin async function that parses request parameters,
 * delegates to the appropriate service interface, and serializes the response.
 * Controllers contain no business logic — all data access and transformation
 * is performed by service implementations (backend layer).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { sendJson, sendError, parseQuery } from './helpers.js';
import type { TaskService } from './services.js';
import type { PlanService } from './services.js';
import type { EventService } from './services.js';
import type { ResourceService } from './services.js';
import type { TokenUsageService } from './services.js';
import type { FileService } from './services.js';
import type { PluginFileService } from './services.js';
import type { TaskFileService } from './services.js';
import type { ManifestService } from './services.js';
import type { ConfigService } from './services.js';
import type { RuntimeService } from './services.js';
import type { TaskEvent } from '@forjis/shared';
import { stringToColor, firstLetter } from '@forjis/shared';

/**
 * Extension → Content-Type map for the built SolidJS client. Covers the
 * asset types emitted by the Vite build (JS bundles, HTML entry, fonts,
 * images, source maps). Extensions not in this map are rejected with 404
 * which prevents accidental exposure of non-asset files.
 */
const CLIENT_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * Returns the task list as JSON.
 *
 * Delegates to taskService.listTasks() which returns tasks already
 * sorted for display (running > queued > pending > needs_clarification > done > failed).
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param taskService - The task data service.
 */
export async function handleTaskList(
  _req: IncomingMessage,
  res: ServerResponse,
  taskService: TaskService
): Promise<void> {
  try {
    const tasks = await taskService.listTasks();
    sendJson(res, 200, tasks);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the pipeline plan for a specific task.
 *
 * Checks that the task exists via taskService.taskExists(), then
 * retrieves the plan via planService.getPlan(). Returns 404 if the
 * task does not exist or has no plan.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param planService - The pipeline plan data service.
 */
export async function handlePlan(
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  planService: PlanService
): Promise<void> {
  try {
    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const plan = await planService.getPlan(taskId);
    if (plan === null) {
      sendError(res, 404, 'TASK_NOT_FOUND', `No plan found for task "${taskId}"`);
      return;
    }

    sendJson(res, 200, plan);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns events for a specific task.
 *
 * Validates the optional "since" query parameter as an ISO 8601 timestamp,
 * checks task existence, then retrieves events via eventService.getEvents().
 * Returns 400 for invalid "since" values and 404 for non-existent tasks.
 *
 * @param req - The incoming HTTP request (used to parse query parameters).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param eventService - The event data service.
 */
export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  eventService: EventService
): Promise<void> {
  try {
    const query = parseQuery(req.url ?? '/');
    const since = query.get('since') ?? undefined;

    if (since !== undefined) {
      const parsed = new Date(since);
      if (isNaN(parsed.getTime())) {
        sendError(res, 400, 'INVALID_PARAMETER', 'Invalid "since" parameter', {
          parameter: 'since',
          message: 'Must be a valid ISO 8601 timestamp',
        });
        return;
      }
    }

    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const org = query.get('org') ?? undefined;
    const team = query.get('team') ?? undefined;
    const role = query.get('role') ?? undefined;

    let events: TaskEvent[];
    if (org && team && role) {
      events = await eventService.getEventsForRole(
        taskId,
        { org, team, role },
        since,
      );
    } else if (role) {
      events = await eventService.getEventsByRole(taskId, role, since);
    } else {
      events = await eventService.getEvents(taskId, since);
    }
    sendJson(res, 200, events);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns all loaded runtime resources as JSON.
 *
 * Delegates to resourceService.getResources() which returns the full
 * resource tree organized by type (orgs, agents, skills, hooks, plugins).
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param resourceService - The resource data service.
 */
export function handleResources(
  _req: IncomingMessage,
  res: ServerResponse,
  resourceService: ResourceService
): void {
  try {
    const resources = resourceService.getResources();
    sendJson(res, 200, resources);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns all resolved configuration data as JSON.
 *
 * Returns 503 SERVICE_UNAVAILABLE when the config service is not
 * configured, and 200 with a ConfigResponse JSON body otherwise.
 *
 * When `projectDir` is provided by the caller (wired from
 * `WebServerOptions.projectDir` in the router), it is merged into the
 * returned `ConfigResponse.projectDir` field so the client TopBar can
 * render the breadcrumb + project icon. A missing / empty `projectDir`
 * leaves the field absent — the client falls back to neutral defaults.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param configService - Optional config data service.
 * @param projectDir - Optional absolute path of the target project directory.
 */
export async function handleConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  configService?: ConfigService,
  projectDir?: string,
): Promise<void> {
  try {
    if (!configService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Config service is not configured');
      return;
    }

    const config = await configService.getConfig();
    if (typeof projectDir === 'string' && projectDir.length > 0) {
      config.projectDir = projectDir;
    }
    sendJson(res, 200, config);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the current runtime/process state as JSON.
 *
 * Returns 503 SERVICE_UNAVAILABLE when the runtime service is not
 * configured, and 200 with a RuntimeResponse JSON body otherwise.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param runtimeService - Optional runtime data service.
 */
export async function handleRuntime(
  _req: IncomingMessage,
  res: ServerResponse,
  runtimeService?: RuntimeService,
): Promise<void> {
  try {
    if (!runtimeService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Runtime service is not configured');
      return;
    }

    const runtime = await runtimeService.getRuntime();
    sendJson(res, 200, runtime);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Establishes an SSE connection for live event streaming.
 *
 * Checks task existence first (sends 404 JSON if not found), then
 * switches to SSE mode with appropriate headers. Polls for new events
 * every 1 second via eventService.getEventsSince() and sends keepalive
 * comments every 15 seconds. Cleans up intervals on client disconnect.
 *
 * @param req - The incoming HTTP request (used for close event).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param eventService - The event data service for polling new events.
 */
export async function handleEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  eventService: EventService
): Promise<void> {
  try {
    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const query = parseQuery(req.url ?? '/');
    const org = query.get('org') ?? undefined;
    const team = query.get('team') ?? undefined;
    const role = query.get('role') ?? undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    let lastTimestamp = new Date().toISOString();
    let closed = false;

    const pollInterval = setInterval(async () => {
      if (closed) {
        return;
      }
      try {
        let events: TaskEvent[];
        if (org && team && role) {
          events = await eventService.getEventsForRole(
            taskId,
            { org, team, role },
            lastTimestamp,
          );
        } else if (role) {
          events = await eventService.getEventsByRole(taskId, role, lastTimestamp);
        } else {
          events = await eventService.getEventsSince(taskId, lastTimestamp);
        }
        for (const event of events) {
          if (closed) {
            break;
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          lastTimestamp = event.timestamp;
        }
      } catch {
        // Silently ignore poll errors; the connection will be cleaned up on close.
      }
    }, 1000);

    const keepaliveInterval = setInterval(() => {
      if (!closed) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    req.on('close', () => {
      closed = true;
      clearInterval(pollInterval);
      clearInterval(keepaliveInterval);
      if (!res.writableEnded) {
        res.end();
      }
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the current token usage snapshot as JSON.
 *
 * Returns 503 SERVICE_UNAVAILABLE when the token usage service is not
 * configured, and 200 with a TokenUsageResponse JSON body otherwise.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param tokenUsageService - Optional token usage data service.
 */
export function handleTokenUsage(
  _req: IncomingMessage,
  res: ServerResponse,
  tokenUsageService?: TokenUsageService,
): void {
  try {
    if (!tokenUsageService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Token usage service is not configured');
      return;
    }

    const usage = tokenUsageService.getTokenUsage();
    sendJson(res, 200, usage);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the content of an OpenSpec change artifact file.
 *
 * Reads the "path" query parameter, validates the task exists, and
 * delegates to fileService.getFileContent(). Returns 503 when the
 * file service is not configured, 400 for missing path parameter,
 * 404 for non-existent tasks or files.
 *
 * @param req - The incoming HTTP request (used to parse query parameters).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param fileService - Optional file content service.
 */
export async function handleFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  fileService?: FileService,
): Promise<void> {
  try {
    if (!fileService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'File service is not configured');
      return;
    }

    const query = parseQuery(req.url ?? '/');
    const filePath = query.get('path');

    if (!filePath) {
      sendError(res, 400, 'MISSING_PARAMETER', 'Missing required "path" query parameter');
      return;
    }

    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const result = await fileService.getFileContent(taskId, filePath);
    if (result === null) {
      sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
      return;
    }

    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the list of `.md` files in a task's directory.
 *
 * Validates that the task exists via taskService.taskExists(), then
 * delegates to taskFileService.listMdFiles(). Returns 503 when the
 * task file service is not configured, 404 for non-existent tasks.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param taskFileService - Optional task file listing service.
 */
export async function handleTaskFileList(
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  taskFileService?: TaskFileService,
): Promise<void> {
  try {
    if (!taskFileService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Task file service is not configured');
      return;
    }

    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const files = await taskFileService.listMdFiles(taskId);
    sendJson(res, 200, { files });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the content of a `.md` file from a task's directory.
 *
 * Reads the "path" query parameter, validates the task exists, and
 * delegates to taskFileService.getTaskFileContent(). Returns 503 when
 * the task file service is not configured, 400 for missing path
 * parameter, 404 for non-existent tasks or files.
 *
 * @param req - The incoming HTTP request (used to parse query parameters).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param taskFileService - Optional task file content service.
 */
export async function handleTaskFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  taskFileService?: TaskFileService,
): Promise<void> {
  try {
    if (!taskFileService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Task file service is not configured');
      return;
    }

    const query = parseQuery(req.url ?? '/');
    const filePath = query.get('path');

    if (!filePath) {
      sendError(res, 400, 'MISSING_PARAMETER', 'Missing required "path" query parameter');
      return;
    }

    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const result = await taskFileService.getTaskFileContent(taskId, filePath);
    if (result === null) {
      sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
      return;
    }

    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the output file manifest for a specific task.
 *
 * Validates task existence, then retrieves the manifest via
 * manifestService.getManifest(). Returns 503 when the manifest
 * service is not configured, 404 for non-existent tasks.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param taskId - The task identifier extracted from the URL path.
 * @param taskService - The task data service for existence checks.
 * @param manifestService - Optional manifest data service.
 */
export async function handleManifest(
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  taskService: TaskService,
  manifestService?: ManifestService,
): Promise<void> {
  try {
    if (!manifestService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Manifest service is not configured');
      return;
    }

    const exists = await taskService.taskExists(taskId);
    if (!exists) {
      sendError(res, 404, 'TASK_NOT_FOUND', `Task "${taskId}" not found`);
      return;
    }

    const manifest = await manifestService.getManifest(taskId);
    sendJson(res, 200, manifest);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns file content resolved against the project directory.
 *
 * Used by the dashboard to load files from project-relative paths
 * provided by the output manifest. Returns 503 when the file service
 * is not configured, 400 for missing path, 404 for missing files.
 *
 * @param req - The incoming HTTP request (used to parse query parameters).
 * @param res - The HTTP server response object.
 * @param taskService - The task data service for existence checks.
 * @param fileService - Optional file content service.
 */
export async function handleProjectFile(
  req: IncomingMessage,
  res: ServerResponse,
  taskService: TaskService,
  fileService?: FileService,
): Promise<void> {
  try {
    if (!fileService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'File service is not configured');
      return;
    }

    const query = parseQuery(req.url ?? '/');
    const filePath = query.get('path');

    if (!filePath) {
      sendError(res, 400, 'MISSING_PARAMETER', 'Missing required "path" query parameter');
      return;
    }

    if (!fileService.getFileByProjectPath) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Project file resolution is not supported');
      return;
    }

    const result = await fileService.getFileByProjectPath(filePath);
    if (result === null) {
      sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
      return;
    }

    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns the raw content of a plugin `.md` file.
 *
 * Contract for GET /api/plugins/file?path=<relative>:
 *   - 503 SERVICE_UNAVAILABLE when no plugin file service is wired
 *   - 400 MISSING_PARAMETER when `path` is absent
 *   - 400 TRAVERSAL when the raw query contains `..`, is absolute, or a
 *     symlink resolves outside every whitelisted plugin root
 *   - 404 FILE_NOT_FOUND when no whitelisted root owns the requested file
 *   - 200 text/plain; charset=utf-8 with the file content on success
 */
export async function handlePluginFile(
  req: IncomingMessage,
  res: ServerResponse,
  pluginFileService?: PluginFileService,
): Promise<void> {
  try {
    if (!pluginFileService) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Plugin file service is not configured');
      return;
    }

    const query = parseQuery(req.url ?? '/');
    const filePath = query.get('path');

    if (!filePath) {
      sendError(res, 400, 'MISSING_PARAMETER', 'Missing required "path" query parameter');
      return;
    }

    if (filePath.includes('..')) {
      sendError(res, 400, 'TRAVERSAL', 'Path contains parent directory references');
      return;
    }

    const result = await pluginFileService.getPluginFile(filePath);

    if (result.kind === 'traversal') {
      sendError(res, 400, 'TRAVERSAL', 'Requested path escapes the plugin root whitelist');
      return;
    }

    if (result.kind === 'notFound') {
      sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(result.content);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Returns a 404 JSON response for unknown routes.
 *
 * Used as the catch-all handler when no defined endpoint matches
 * the incoming request path.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 */
export function handleNotFound(
  _req: IncomingMessage,
  res: ServerResponse
): void {
  sendError(res, 404, 'NOT_FOUND', 'Not found');
}

// -- Favicon (SVG) route ----------------------------------------------------

/** Rendered SVG dimensions (px). Used both as `width`/`height` attributes and
 *  the right edge of the viewBox. The rounded-square is the full canvas. */
const FAVICON_SIZE = 32;
/** Corner radius (px) applied to the background rect — matches the TopBar
 *  `ProjectIcon` primitive so favicon and in-app icon are visually identical. */
const FAVICON_CORNER_RADIUS = 4;
/** Horizontal center of the canvas — the letter anchors here. */
const FAVICON_CENTER_X = FAVICON_SIZE / 2;
/** Vertical baseline offset for the letter. Nudged one pixel below the
 *  geometric center so visually the glyph appears balanced (matches the
 *  legacy canvas-drawn favicon). */
const FAVICON_TEXT_Y = FAVICON_CENTER_X + 1;
/** Font size (px) for the uppercase letter — large enough to fill the icon
 *  while leaving a margin at 32×32. */
const FAVICON_FONT_SIZE = 20;
/** Neutral grey background for the fallback icon shown when `projectDir`
 *  is unknown. Matches the app's muted-text token family visually. */
const FAVICON_FALLBACK_BG = '#6b7280';
/** Letter rendered when `projectDir` is unknown / yields no usable char. */
const FAVICON_FALLBACK_LETTER = 'F';
/** Regex stripping anything outside ASCII A-Z / 0-9 from the candidate
 *  letter. The source is already one uppercased character from `firstLetter`
 *  so this is a defence-in-depth filter against any stray glyph that could
 *  appear in path segments (unicode, whitespace, punctuation, `<`, `&`). */
const FAVICON_LETTER_SAFE = /[^A-Z0-9]/g;

/**
 * In-memory cache of rendered favicon SVGs keyed by `projectDir`.
 *
 * The cardinality is one entry per project the server has ever served —
 * effectively ≤ 1 in the typical one-process-per-project deployment. No
 * eviction is needed; entries live for the lifetime of the process.
 */
const faviconCache = new Map<string, string>();

/**
 * Derives the project name (last path segment) from an absolute directory.
 *
 * Splits on both POSIX and Windows separators so the backend produces the
 * same letter as the client-side `new URL()`-based split. Trailing
 * separators are tolerated — an empty final segment falls back to the
 * preceding non-empty one.
 *
 * @param projectDir - Absolute path of the project directory.
 * @returns The last path segment, or an empty string when none exists.
 */
function projectNameFromPath(projectDir: string): string {
  const segments = projectDir.split(/[\\/]/).filter(s => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/**
 * Sanitizes a candidate letter down to a safe single ASCII glyph.
 *
 * The input is expected to be a single uppercased character produced by
 * `firstLetter`. Strips anything outside `A-Z0-9`. If the result is empty
 * (e.g. the source was unicode or punctuation), falls back to `F`.
 *
 * @param candidate - The candidate letter from `firstLetter(projectName)`.
 * @returns A single safe uppercase ASCII character.
 */
function sanitizeFaviconLetter(candidate: string): string {
  const stripped = candidate.toUpperCase().replace(FAVICON_LETTER_SAFE, '');
  if (stripped.length === 0) {
    return FAVICON_FALLBACK_LETTER;
  }
  return stripped.charAt(0);
}

/**
 * Builds the favicon SVG body for the given background color and letter.
 *
 * No external font references — uses a `system-ui` stack so every OS
 * renders a native-feeling glyph without a network font fetch.
 *
 * @param background - CSS color literal for the rounded-square fill.
 * @param letter - Single sanitized ASCII letter to center in the icon.
 * @returns The complete SVG document as a string.
 */
function renderFaviconSvg(background: string, letter: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FAVICON_SIZE}" height="${FAVICON_SIZE}" viewBox="0 0 ${FAVICON_SIZE} ${FAVICON_SIZE}">` +
    `<rect width="${FAVICON_SIZE}" height="${FAVICON_SIZE}" rx="${FAVICON_CORNER_RADIUS}" fill="${background}"/>` +
    `<text x="${FAVICON_CENTER_X}" y="${FAVICON_TEXT_Y}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#fff" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="700" font-size="${FAVICON_FONT_SIZE}">${letter}</text>` +
    `</svg>`
  );
}

/**
 * Computes — or returns a cached — favicon SVG for the given project dir.
 *
 * Cache key is the raw `projectDir` string so two semantically-different
 * paths (`/a/proj` vs `/b/proj`) correctly receive different colors. A
 * falsy `projectDir` resolves to the shared neutral fallback entry keyed
 * by the empty string.
 *
 * @param projectDir - Absolute project directory path, or `undefined`.
 * @returns The SVG document string to send as the response body.
 */
function getFaviconSvg(projectDir: string | undefined): string {
  const key = typeof projectDir === 'string' ? projectDir : '';
  const cached = faviconCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let svg: string;
  if (key.length === 0) {
    svg = renderFaviconSvg(FAVICON_FALLBACK_BG, FAVICON_FALLBACK_LETTER);
  } else {
    const background = stringToColor(key);
    const letter = sanitizeFaviconLetter(firstLetter(projectNameFromPath(key)));
    svg = renderFaviconSvg(background, letter);
  }
  faviconCache.set(key, svg);
  return svg;
}

/**
 * Clears the in-memory favicon cache.
 *
 * Exposed for tests so each case starts from a clean slate — production
 * code never needs to invalidate (project identity is stable for the
 * lifetime of the process).
 */
export function clearFaviconCache(): void {
  faviconCache.clear();
}

/**
 * Serves the project-branded favicon as an SVG document.
 *
 * Computes a deterministic `hsl()` background color from the absolute
 * `projectDir` and a single uppercase letter from the last path segment,
 * reusing the exact `stringToColor` / `firstLetter` helpers that the
 * TopBar `ProjectIcon` uses. The resulting SVG is cached in-memory so
 * repeated browser requests do not re-render.
 *
 * Unauthenticated by design — browsers cannot attach an `Authorization`
 * header to favicon requests. The response contains only derived data
 * (a color + one letter), no filesystem reads, no user-supplied input.
 *
 * @param _req - The incoming HTTP request (unused).
 * @param res - The HTTP server response object.
 * @param projectDir - Optional absolute path of the target project directory.
 */
export function handleFavicon(
  _req: IncomingMessage,
  res: ServerResponse,
  projectDir?: string,
): void {
  try {
    const svg = getFaviconSvg(projectDir);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(svg);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal server error');
  }
}

/**
 * Serves a file from the configured built-client directory.
 *
 * Given a URL pathname (e.g., `/` or `/assets/app-abc.js`), resolves
 * it against `clientDir`. For `/` or empty paths, serves `index.html`.
 * For paths whose resolved file does not exist and whose extension is
 * absent (deep-link client routes), falls back to `index.html` so the
 * SPA router can handle the path. Any request with an extension that
 * resolves outside the client directory returns 404 without touching
 * the filesystem.
 *
 * @param pathname - The URL pathname (starts with `/`).
 * @param res - The HTTP server response object.
 * @param clientDir - Absolute path to the built client directory.
 */
export async function handleClient(
  pathname: string,
  res: ServerResponse,
  clientDir: string
): Promise<void> {
  const normalizedPath = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  const relativePath = normalizedPath.replace(/^\/+/, '');
  const resolved = normalize(join(clientDir, relativePath));
  const clientRoot = normalize(clientDir);

  if (resolved !== clientRoot && !resolved.startsWith(clientRoot + sep)) {
    sendError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }

  const ext = extname(resolved).toLowerCase();
  if (ext.length === 0) {
    await serveClientFile(join(clientDir, 'index.html'), '.html', res);
    return;
  }

  const contentType = CLIENT_CONTENT_TYPES[ext];
  if (contentType === undefined) {
    sendError(res, 404, 'NOT_FOUND', 'Not found');
    return;
  }

  try {
    await serveClientFile(resolved, ext, res);
  } catch {
    if (ext === '.html') {
      sendError(res, 404, 'NOT_FOUND', 'Not found');
      return;
    }
    await serveClientFile(join(clientDir, 'index.html'), '.html', res);
  }
}

/**
 * Reads a file from disk and writes it to the response with the
 * appropriate Content-Type and cache headers. Rethrows read errors
 * so the caller can implement SPA fallback behavior.
 */
async function serveClientFile(
  filePath: string,
  ext: string,
  res: ServerResponse
): Promise<void> {
  const data = await readFile(filePath);
  const contentType = CLIENT_CONTENT_TYPES[ext] ?? 'application/octet-stream';
  const cacheControl = ext === '.html'
    ? 'no-cache'
    : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });
  res.end(data);
}
