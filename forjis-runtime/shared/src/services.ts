/**
 * Service interfaces for the Forjis web dashboard API.
 *
 * These interfaces define the data access contract between the API layer
 * (controllers) and the backend layer (service implementations). The API
 * layer calls these methods; the backend layer provides implementations
 * that read from TaskQueue, pipeline-plan.yaml, events.jsonl, and
 * RuntimeConfig/ResourceRegistry.
 *
 * Implemented by backend layer.
 */

import type {
  TaskListItem,
  PipelinePlanResponse,
  TaskEvent,
  ResourcesResponse,
  TokenUsageResponse,
  ManifestResponse,
  ConfigResponse,
  RuntimeResponse,
} from './types.js';

/**
 * Provides task data for the API layer.
 *
 * Implemented by backend layer by reading from TaskQueue.
 */
export interface TaskService {
  /**
   * Returns all tasks formatted for API response, sorted for display.
   *
   * Sort order: running > queued > pending > needs_clarification > done > failed.
   * Within same status: higher priority first, then earliest created first.
   *
   * @returns Array of TaskListItem sorted for display.
   */
  listTasks(): Promise<TaskListItem[]>;

  /**
   * Checks whether a task exists.
   *
   * @param taskId - The task identifier to check.
   * @returns True if the task exists, false otherwise.
   */
  taskExists(taskId: string): Promise<boolean>;
}

/**
 * Provides pipeline plan data for the API layer.
 *
 * Implemented by backend layer by reading pipeline-plan.yaml files.
 */
export interface PlanService {
  /**
   * Returns the pipeline execution plan for a task.
   *
   * @param taskId - The task identifier.
   * @returns The plan response, or null if the task has no plan.
   */
  getPlan(taskId: string): Promise<PipelinePlanResponse | null>;
}

/**
 * Provides stream event data for the API layer.
 *
 * Implemented by backend layer by reading events.jsonl files.
 */
export interface EventService {
  /**
   * Returns recent events for a task, optionally filtered by timestamp.
   *
   * @param taskId - The task identifier.
   * @param since - Optional ISO timestamp; only events after this time are returned.
   * @returns Array of TaskEvent in chronological order.
   */
  getEvents(taskId: string, since?: string): Promise<TaskEvent[]>;

  /**
   * Returns events added since the given timestamp, for SSE streaming.
   *
   * This is called repeatedly by the SSE controller to poll for new events.
   *
   * @param taskId - The task identifier.
   * @param since - ISO timestamp of the last known event.
   * @returns Array of new TaskEvent in chronological order.
   */
  getEventsSince(taskId: string, since: string): Promise<TaskEvent[]>;

  /**
   * Returns events for a specific role identity, optionally filtered by
   * timestamp.
   *
   * The `{org, team, role}` triple picks the canonical event file (see
   * `canonicalSlug`); passing the triple as a structured object keeps the
   * API off the composite-string path that used to drive drift.
   *
   * @param taskId - The task identifier.
   * @param identity - Structured role identity.
   * @param since - Optional ISO timestamp; only events after this time are returned.
   * @returns Array of TaskEvent in chronological order.
   */
  getEventsForRole(
    taskId: string,
    identity: { org: string; team: string; role: string },
    since?: string,
  ): Promise<TaskEvent[]>;

  /**
   * Returns events filtered by role across all event files (including events.jsonl).
   *
   * Reuses the existing readEvents substrate — equivalent to
   * `getEvents(taskId, since).filter(e => e.role === role)`.
   *
   * Differs from `getEventsForRole` in that it does NOT require a team and
   * does NOT read a per-role file — it scans every events*.jsonl and matches
   * on the `event.role` payload field. This is what makes
   * `?role=orchestrator` work (orchestrator events live in events.jsonl,
   * not in a per-role file).
   *
   * @param taskId - The task identifier.
   * @param role - The role identifier to filter by (matched against event.role).
   * @param since - Optional ISO timestamp; only events after this time are returned.
   * @returns Array of matching TaskEvent in chronological order.
   */
  getEventsByRole(taskId: string, role: string, since?: string): Promise<TaskEvent[]>;
}

/**
 * Provides resource data for the API layer.
 *
 * Implemented by backend layer by reading from RuntimeConfig and ResourceRegistry.
 */
export interface ResourceService {
  /**
   * Returns all loaded resources organized by type.
   *
   * @returns The full resources response.
   */
  getResources(): ResourcesResponse;
}

/**
 * Provides token usage data for the API layer.
 *
 * Implemented by backend layer by reading from the live TokenTracker instance.
 */
export interface TokenUsageService {
  /**
   * Returns the current token usage snapshot.
   *
   * @returns The token usage response with counts, timestamps, and budget info.
   */
  getTokenUsage(): TokenUsageResponse;
}

/**
 * Provides file content access for the API layer.
 *
 * Implemented by backend layer by reading OpenSpec change artifact files
 * from the project directory with path traversal protection.
 */
export interface FileService {
  /**
   * Returns the text content of a file within a task's change directory.
   *
   * Reads from `<projectDir>/openspec/changes/<taskId>/<relativePath>`.
   * Returns null if the file does not exist or the path escapes the
   * allowed base directory (path traversal attempt).
   *
   * @param taskId - The task identifier (used as directory name).
   * @param relativePath - The relative file path within the change directory.
   * @returns The file content wrapped in a JSON envelope, or null if not found.
   */
  getFileContent(taskId: string, relativePath: string): Promise<{ content: string } | null>;

  /**
   * Returns the text content of a file by project-relative path.
   *
   * Resolves the path against the project root directory with traversal
   * protection. Returns null if the file does not exist or the path
   * escapes the project directory.
   *
   * @param projectPath - The project-relative path to the file.
   * @returns The file content wrapped in a JSON envelope, or null if not found.
   */
  getFileByProjectPath?(projectPath: string): Promise<{ content: string } | null>;
}

/**
 * Result envelope returned by PluginFileService.getPluginFile.
 *
 * Discriminates between the three outcomes the controller must surface:
 * - "ok" for a successfully read file
 * - "traversal" for rejected paths (`..`, absolute paths, symlink escape)
 * - "notFound" when the resolved path does not exist under any whitelisted plugin root
 */
export type PluginFileResult =
  | { kind: 'ok'; content: string }
  | { kind: 'traversal' }
  | { kind: 'notFound' };

/**
 * Provides plugin markdown content for the API layer.
 *
 * Implemented by backend layer by reading `.md` files from the plugin root
 * whitelist resolved by the plugin loader. All requests are validated against
 * the whitelist (realpath-normalized prefix match) and the raw query is
 * rejected when it contains `..` or is absolute.
 */
export interface PluginFileService {
  /**
   * Returns the content of a plugin markdown file.
   *
   * @param relativePath - The requested path (expected to be plugin-root relative).
   * @returns A discriminated result describing success, traversal rejection, or missing file.
   */
  getPluginFile(relativePath: string): Promise<PluginFileResult>;
}

/**
 * Provides task-directory file access for the API layer.
 *
 * Implemented by backend layer by listing and reading `.md` files
 * from `.forjis/tasks/<taskId>/` with path traversal protection.
 */
export interface TaskFileService {
  /**
   * Lists `.md` files in a task's directory.
   *
   * Reads from `<projectDir>/.forjis/tasks/<taskId>/` and returns
   * only filenames ending in `.md`, sorted alphabetically.
   * Returns an empty array if the directory does not exist.
   *
   * @param taskId - The task identifier (used as directory name).
   * @returns Sorted array of `.md` filenames found in the task directory.
   */
  listMdFiles(taskId: string): Promise<string[]>;

  /**
   * Returns the text content of a `.md` file within a task's directory.
   *
   * Reads from `<projectDir>/.forjis/tasks/<taskId>/<filename>`.
   * Returns null if the file does not exist or the path escapes the
   * allowed base directory (path traversal attempt).
   *
   * @param taskId - The task identifier (used as directory name).
   * @param filename - The filename to read within the task directory.
   * @returns The file content wrapped in a JSON envelope, or null if not found.
   */
  getTaskFileContent(taskId: string, filename: string): Promise<{ content: string } | null>;
}

/**
 * Provides output file manifest data for the API layer.
 *
 * Implemented by backend layer by reading output-files.yaml from
 * the task's directory.
 */
export interface ManifestService {
  /**
   * Returns the output file manifest for a task.
   *
   * @param taskId - The task identifier.
   * @returns The manifest with a files array, or empty files if no manifest exists.
   */
  getManifest(taskId: string): Promise<ManifestResponse>;
}

/**
 * Provides resolved configuration data for the API layer.
 *
 * Implemented by backend layer by reading the six YAML config files
 * from the `.forjis/config/` directory and composing them into a
 * single response.
 */
export interface ConfigService {
  /**
   * Returns all resolved configuration data.
   *
   * Reads orgs.yaml, constraints.yaml, personas.yaml, tasks.yaml,
   * health-check.yaml, and token-budget.yaml, composing them into
   * a single ConfigResponse.
   *
   * @returns The full config response.
   */
  getConfig(): Promise<ConfigResponse>;
}

/**
 * Provides runtime/process state for the API layer.
 *
 * Implemented by backend layer by composing the orchestrator package
 * version, worker-slot accessor, token-tracker cost accumulator, and
 * one-shot git branch resolution.
 */
export interface RuntimeService {
  /**
   * Returns the current runtime/process state snapshot.
   *
   * Async to leave room for future I/O (e.g. re-resolving git branch
   * or polling a worker accessor over IPC).
   *
   * @returns The runtime response with version, workers, optional cost, and gitBranch.
   */
  getRuntime(): Promise<RuntimeResponse>;
}
