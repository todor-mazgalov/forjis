/**
 * Shell API client — thin wrappers around `fetch` for endpoints consumed by
 * the app shell. Components must not call `fetch` directly; every server
 * interaction flows through a function in this module so request/response
 * concerns stay out of the view layer. See design.md decision D-6
 * (redesign-004).
 *
 * Errors (non-2xx responses, network failures, JSON parse failures) resolve
 * to `null` rather than throwing. Callers treat `null` as "endpoint
 * unavailable" and render their fallback UI.
 */

import type {
  ConfigResponse,
  ManifestResponse,
  PipelinePlanResponse,
  ResourcesResponse,
  RuntimeResponse,
  TaskEvent,
  TaskListItem,
  TokenUsageResponse,
} from '@forjis/shared';

/** Endpoint path for the resolved configuration. */
const CONFIG_ENDPOINT = '/api/config';

/** Endpoint path for the task list. */
const TASKS_ENDPOINT = '/api/tasks';

/** Endpoint path for the loaded runtime resources. */
const RESOURCES_ENDPOINT = '/api/resources';

/** Endpoint path for the token-usage snapshot. */
const TOKEN_USAGE_ENDPOINT = '/api/token-usage';

/** Endpoint path for the runtime/process state snapshot. */
const RUNTIME_ENDPOINT = '/api/runtime';

/**
 * Fetch the resolved configuration from the dashboard API.
 *
 * Returns the parsed `ConfigResponse` on a 2xx response, or `null` for any
 * non-2xx status, network failure, or JSON parse failure. Never throws. The
 * view layer uses `null` to decide whether to render a fallback (e.g. the
 * literal project name `'forjis'`).
 */
export async function fetchConfig(): Promise<ConfigResponse | null> {
  try {
    const response = await fetch(CONFIG_ENDPOINT);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as ConfigResponse;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the current token-usage snapshot. Mirrors {@link fetchConfig}'s
 * errors-to-null convention: any non-2xx status, network failure, or JSON
 * parse failure resolves to `null`. Never throws. The Config view uses a
 * `null` result to render an "unavailable" fallback in the Tokens panel.
 */
export async function fetchTokenUsage(): Promise<TokenUsageResponse | null> {
  try {
    const response = await fetch(TOKEN_USAGE_ENDPOINT);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as TokenUsageResponse;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the current runtime/process-state snapshot (version, workers,
 * optional cost, git branch). Mirrors {@link fetchConfig}'s errors-to-null
 * convention: any non-2xx status, network failure, or JSON parse failure
 * resolves to `null`. Never throws. The StatusBar uses a `null` result to
 * fall back to the stubbed connection-health label without version /
 * worker chips.
 */
export async function fetchRuntime(): Promise<RuntimeResponse | null> {
  try {
    const response = await fetch(RUNTIME_ENDPOINT);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as RuntimeResponse;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the current task list from the dashboard API.
 *
 * Returns the parsed `TaskListItem[]` on a 2xx response, or `null` for any
 * non-2xx status, network failure, or JSON parse failure. Never throws.
 * Callers treat `null` as "endpoint unavailable" and may render a fallback
 * or retain the previously loaded list. No business logic is performed
 * here — just fetch, parse, return.
 */
export async function getTasks(): Promise<TaskListItem[] | null> {
  try {
    const response = await fetch(TASKS_ENDPOINT);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as TaskListItem[];
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the pipeline plan for a single task.
 *
 * Returns the parsed `PipelinePlanResponse` on a 2xx response, or `null` for
 * any non-2xx status, network failure, or JSON parse failure. Never throws.
 * Callers treat `null` as "endpoint unavailable" and render a fallback empty
 * state. The `taskId` is URL-encoded before being appended to the path.
 *
 * @param taskId - The task whose plan should be fetched.
 */
export async function getPlan(taskId: string): Promise<PipelinePlanResponse | null> {
  try {
    const response = await fetch(`${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/plan`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as PipelinePlanResponse;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the loaded runtime resources (orgs/teams/roles + agents/skills/hooks).
 *
 * Returns the parsed `ResourcesResponse` on a 2xx response, or `null` for any
 * non-2xx status, network failure, or JSON parse failure. Never throws. Used
 * by the pipeline view to resolve a `RoleResource` for each step.
 */
export async function getResources(): Promise<ResourcesResponse | null> {
  try {
    const response = await fetch(RESOURCES_ENDPOINT);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as ResourcesResponse;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the output-file manifest for a task.
 *
 * Returns the parsed `ManifestResponse` on a 2xx response, or `null` for any
 * non-2xx status, network failure, or JSON parse failure. Never throws.
 * Mirrors the "errors-to-null" convention shared with `getPlan` and
 * `getResources`. The `taskId` is URL-encoded before being appended to the
 * path. Used by the Files-touched tab in the detail pane.
 *
 * @param taskId - The task whose manifest should be fetched.
 */
export async function getManifest(taskId: string): Promise<ManifestResponse | null> {
  try {
    const response = await fetch(`${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/manifest`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as ManifestResponse;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fetch the list of `.md` files in a task's directory under
 * `.forjis/tasks/<taskId>/`. Used by the OpenSpec tab, which surfaces the
 * same per-task markdown artifacts that the pre-redesign orchestrator tab
 * bar listed (see `dashboard-orchestrator-tabs-review.test.ts`).
 *
 * Unwraps the server's `{ files: string[] }` envelope into a flat array so
 * callers never need to know the transport shape. Returns `null` for any
 * non-2xx status, network failure, JSON parse failure, or malformed payload.
 * Never throws.
 *
 * @param taskId - The task whose markdown directory should be listed.
 */
export async function getTaskFiles(taskId: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/task-files`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { files?: string[] };
    if (!Array.isArray(payload.files)) {
      return null;
    }
    return payload.files;
  } catch {
    return null;
  }
}

/**
 * Optional query parameters honoured by both event endpoints. `org`, `team`,
 * and `role` are all optional individually; the controller only dispatches to
 * `getEventsForRole` when all three are present (see `fix-roles-display`),
 * falling back to `getEventsByRole` / `getEvents` otherwise.
 */
export interface EventQueryOpts {
  /** `org` segment of the structured role identity filter. */
  org?: string;
  /** `team` segment of the structured role identity filter. */
  team?: string;
  /** `role` segment of the structured role identity filter. */
  role?: string;
  /** ISO 8601 timestamp; only events strictly newer are returned. */
  since?: string;
  /** Optional pre-shared bearer token for SSE deployments — query-param form. */
  token?: string;
}

/**
 * Build a URL for the events history endpoint. Encodes the task id and any
 * non-undefined query parameters via `URLSearchParams` so values containing
 * `&` or `=` cannot break the query string. Private to this module.
 */
function buildEventsUrl(taskId: string, opts: EventQueryOpts = {}): string {
  const params = new URLSearchParams();
  if (opts.org !== undefined) params.set('org', opts.org);
  if (opts.team !== undefined) params.set('team', opts.team);
  if (opts.role !== undefined) params.set('role', opts.role);
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return `${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/events${qs ? `?${qs}` : ''}`;
}

/**
 * Build a URL for the events SSE stream endpoint. Mirrors `buildEventsUrl`
 * but appends `token` (when present) so deployments with `--token` enabled
 * can authenticate the connection — `EventSource` cannot send custom headers.
 */
function buildEventStreamUrl(taskId: string, opts: EventQueryOpts = {}): string {
  const params = new URLSearchParams();
  if (opts.org !== undefined) params.set('org', opts.org);
  if (opts.team !== undefined) params.set('team', opts.team);
  if (opts.role !== undefined) params.set('role', opts.role);
  if (opts.token !== undefined) params.set('token', opts.token);
  const qs = params.toString();
  return `${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/events/stream${qs ? `?${qs}` : ''}`;
}

/**
 * Fetch the historical event list for a task, optionally filtered by
 * `team`/`role` and bounded below by `since`.
 *
 * Returns the parsed `TaskEvent[]` on a 2xx response, or `null` for any
 * non-2xx status, network failure, or JSON parse failure. Never throws —
 * mirrors the existing `getPlan` / `getResources` "errors-to-null" convention
 * so the view layer can fall back to its empty state without try/catch.
 *
 * @param taskId - The task whose events should be fetched.
 * @param opts - Optional `team` / `role` / `since` query parameters.
 */
export async function getTaskEvents(
  taskId: string,
  opts: EventQueryOpts = {},
): Promise<TaskEvent[] | null> {
  try {
    const response = await fetch(buildEventsUrl(taskId, opts));
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as TaskEvent[];
    return payload;
  } catch {
    return null;
  }
}

/**
 * Open a native `EventSource` against the task's SSE stream endpoint.
 *
 * Returns the `EventSource` directly so the caller owns its lifecycle
 * (handler binding, `close()`). No try/catch — the constructor only throws
 * on a malformed URL, which the encoders inside the URL builder prevent.
 *
 * @param taskId - The task whose live stream should be opened.
 * @param opts - Optional `team` / `role` filter and `token` for auth.
 */
export function openTaskEventStream(
  taskId: string,
  opts: { org?: string; team?: string; role?: string; token?: string } = {},
): EventSource {
  const url = buildEventStreamUrl(taskId, opts);
  return new EventSource(url);
}

/**
 * Discriminated-union result of a file-content fetch. Breaks from the
 * "errors-to-null" convention used by the other helpers in this module
 * because the file viewer needs to render three differentiated UI states
 * (whitelist rejection, missing file, generic unavailable). A `null`
 * return would collapse those distinctions. See redesign-010 design.md
 * § D-3 for the rationale.
 */
export type FileFetchResult =
  | { ok: true; content: string }
  | { ok: false; kind: 'not-allowed' }
  | { ok: false; kind: 'not-found' }
  | { ok: false; kind: 'unavailable' };

/** Endpoint path for plugin-rooted file content (text/plain response body). */
const PLUGIN_FILE_ENDPOINT = '/api/plugins/file';

/** Endpoint path for project-relative file content (`text/plain` body). */
const PROJECT_FILE_ENDPOINT = '/api/project-file';

/**
 * Map a non-2xx response `status` code to the matching {@link FileFetchResult}
 * failure kind. `400` (whitelist / traversal / missing-param) becomes
 * `'not-allowed'`, `404` becomes `'not-found'`, and every other status —
 * including 503 and 5xx — becomes `'unavailable'` so callers render the
 * generic "Unable to load file" message. Shared by both file fetchers.
 */
function classifyFileStatus(status: number): FileFetchResult {
  if (status === 400) return { ok: false, kind: 'not-allowed' };
  if (status === 404) return { ok: false, kind: 'not-found' };
  return { ok: false, kind: 'unavailable' };
}

/**
 * Fetch a plugin-rooted file via `GET /api/plugins/file?path=<encoded>`. The
 * server responds with `text/plain; charset=utf-8` on success; the body is
 * read via `.text()` and returned as `content`. The `path` is URL-encoded so
 * values containing `&`, `=`, or spaces cannot break the query string.
 *
 * Never throws. All failure modes — network exception, text-decode throw,
 * and every non-2xx status — resolve to a `{ ok: false, kind: … }` result.
 * See redesign-010 design.md § D-3 for the status → kind table.
 *
 * @param path - Plugin-root-relative path; URL-encoded before interpolation.
 */
export async function getPluginFile(path: string): Promise<FileFetchResult> {
  try {
    const response = await fetch(
      `${PLUGIN_FILE_ENDPOINT}?path=${encodeURIComponent(path)}`,
    );
    if (!response.ok) {
      return classifyFileStatus(response.status);
    }
    const content = await response.text();
    return { ok: true, content };
  } catch {
    return { ok: false, kind: 'unavailable' };
  }
}

/**
 * Fetch a task-rooted file via
 * `GET /api/tasks/<encoded>/task-file?path=<encoded>`. The server wraps the
 * body in a `{ content: string }` JSON envelope; this helper unwraps it and
 * returns the raw string as `content`. Both `taskId` and `path` are
 * URL-encoded before interpolation.
 *
 * Never throws. A thrown `fetch`/`.json()`, a non-2xx status, or a payload
 * missing the `content` string field all resolve to a failure result. See
 * redesign-010 design.md § D-3.
 *
 * @param taskId - Task identifier; URL-encoded before interpolation.
 * @param path - Task-root-relative path; URL-encoded before interpolation.
 */
export async function getTaskFile(
  taskId: string,
  path: string,
): Promise<FileFetchResult> {
  try {
    const response = await fetch(
      `${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/task-file?path=${encodeURIComponent(path)}`,
    );
    if (!response.ok) {
      return classifyFileStatus(response.status);
    }
    const payload = (await response.json()) as { content?: unknown };
    if (typeof payload?.content !== 'string') {
      return { ok: false, kind: 'unavailable' };
    }
    return { ok: true, content: payload.content };
  } catch {
    return { ok: false, kind: 'unavailable' };
  }
}

/**
 * Fetch a project-relative file via `GET /api/project-file?path=<encoded>`.
 * The server responds with `text/plain; charset=utf-8` on success; the body
 * is read via `.text()` and returned as `content`. The `path` is URL-encoded
 * so values containing `&`, `=`, or spaces cannot break the query string.
 *
 * Used by {@link FileViewer} for `source === 'project'` requests — covers
 * manifest entries whose project-relative path falls outside the task dir
 * (e.g. `openspec/changes/<taskId>/*.md`). The endpoint already exists in
 * the web server (`handleProjectFile`).
 *
 * Never throws. All failure modes resolve to a `{ ok: false, kind: … }` result
 * using the same status-classification rules as `getPluginFile`.
 *
 * @param path - Project-relative path; URL-encoded before interpolation.
 */
export async function getProjectFile(path: string): Promise<FileFetchResult> {
  try {
    const response = await fetch(
      `${PROJECT_FILE_ENDPOINT}?path=${encodeURIComponent(path)}`,
    );
    if (!response.ok) {
      return classifyFileStatus(response.status);
    }
    const content = await response.text();
    return { ok: true, content };
  } catch {
    return { ok: false, kind: 'unavailable' };
  }
}
