/**
 * fileViewerStore — module-level signal store for the file-viewer modal.
 *
 * Any view in the app can open the viewer by importing `openFile` from this
 * module; there is no context provider and no prop drilling. The backing
 * state is a plain `createSignal` declared at module scope, which Solid
 * treats as a reactive global — `FileViewer` subscribes via `currentFile`
 * and updates whenever any caller writes. The chosen scope matches the
 * intent of a singleton app-global modal rather than a scoped sub-tree
 * primitive. See redesign-010 design.md § D-1 (why not a context) and § D-6
 * (store shape).
 *
 * Three public accessors are exported:
 *   - `currentFile()`    — read the active request or `null`.
 *   - `openFile(...)`    — write a new request; always constructs a fresh
 *                          object so subscribers notify even when the new
 *                          shape matches the previous one.
 *   - `closeFile()`      — clear the request (sets the signal to `null`).
 */

import type { Accessor } from 'solid-js';
import { createSignal } from 'solid-js';

/**
 * Provenance bucket for a file the viewer should open.
 * - `task` files live under the target project's task tree and are addressed
 *   by a path relative to the task root (`.forjis/tasks/<taskId>/`).
 * - `plugin` files live under a resolved plugin cache and are addressed by a
 *   plugin-root-relative path.
 * - `project` files are project-relative paths addressed via
 *   `GET /api/project-file?path=<encoded>` (arbitrary project files).
 */
export type FileViewerSource = 'task' | 'plugin' | 'project';

/**
 * Request payload the store holds while the modal is open. `taskId` is
 * `null` for `plugin` and `project` sources (those paths are
 * task-independent) and is also stored as `null` when a `task` source is
 * opened without a taskId — the modal renders the generic error state for
 * that case instead of attempting an ill-formed fetch.
 */
export interface FileViewerRequest {
  /** Path to the file, relative to the root implied by {@link source}. */
  path: string;
  /** Which root the path is relative to. */
  source: FileViewerSource;
  /**
   * Task id for `source === 'task'` requests; `null` for `'plugin'` and
   * `'project'` sources (project-file requests are task-independent).
   */
  taskId: string | null;
}

/**
 * Module-scope signal holding the active request. Private to this module;
 * readers use {@link currentFile} and writers use {@link openFile} /
 * {@link closeFile}. Keeping the setter hidden is what makes the three
 * exported accessors the only legal writes, which is the property tests
 * and callers rely on.
 */
const [request, setRequest] = createSignal<FileViewerRequest | null>(null);

/**
 * Read accessor for the active file-viewer request. Returns `null` while
 * the modal is closed. Subscribed to by {@link FileViewer} via a
 * `createMemo` that keys a `createResource` off the returned value.
 */
export const currentFile: Accessor<FileViewerRequest | null> = request;

/**
 * Request that the file-viewer modal open `path` sourced from `source`.
 * Always constructs a fresh object reference so Solid's default identity
 * equality triggers subscribers even when the caller re-opens the same
 * file — the modal treats that as "re-fetch".
 *
 * When `source === 'task'` and no `taskId` is supplied, the stored taskId
 * falls back to `null`; the modal short-circuits the fetch and shows the
 * generic error state.
 *
 * @param path - Path to the file, relative to the implied root.
 * @param source - Which root the path is relative to.
 * @param taskId - Task id when `source === 'task'`; omitted for `'plugin'`.
 */
export function openFile(
  path: string,
  source: FileViewerSource,
  taskId?: string,
): void {
  setRequest({ path, source, taskId: taskId ?? null });
}

/**
 * Close the file-viewer modal by clearing the stored request. Subscribers
 * see `currentFile()` flip back to `null`; the modal unmounts its overlay
 * and tears down its Esc listener.
 */
export function closeFile(): void {
  setRequest(null);
}
