/**
 * Manifest recorder for engine-driven file writes.
 *
 * Replaces the LLM-driven `cat >> output-files.yaml` contract with a
 * facilitator-side append that fires once per `tool_call` event for
 * `Write`, `Edit`, or `NotebookEdit`. Entries are de-duplicated in-process
 * by `(taskId, role, projectRelativePath)` so the same role writing the
 * same file twice during one process never emits two manifest rows.
 *
 * The on-disk format matches `ManifestServiceImpl`'s expectations:
 *   files:
 *     - role: <role>
 *       path: <projectRelativePath>
 *       label: <label>
 *       createdAt: "<ISO-8601>"
 *
 * File-system errors (EPERM, disk full, etc.) are swallowed and surfaced
 * by returning false; recording is best-effort to match the behaviour of
 * the existing `appendEvent` hook in `commands/run.ts`.
 */

import { appendFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ensureDir } from '../state.js';

/** In-process dedupe set keyed by `<taskId>|<role>|<projectRelativePath>`. */
const seen: Set<string> = new Set();

/**
 * Resets the in-process dedupe set. Test-only helper.
 *
 * Lets unit tests evaluate first-call vs. duplicate-call behaviour without
 * leaking state across test cases.
 */
export function __resetSeen(): void {
  seen.clear();
}

/**
 * Resolves a tool-call file path against the project directory.
 *
 * Returns the project-relative path with forward slashes when the resolved
 * path falls inside `projectDir`; returns null when the path escapes the
 * project root or cannot be normalised. Blocks both literal `..` segments
 * and absolute paths that point outside the project.
 *
 * @param projectDir - Absolute project root path.
 * @param filePath - Path from the tool call payload (absolute or relative).
 * @returns Project-relative path with forward slashes, or null when out of project.
 */
function toProjectRelative(projectDir: string, filePath: string): string | null {
  const projectRoot = resolve(projectDir);
  const absolutePath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(projectRoot, filePath);

  if (absolutePath !== projectRoot && !absolutePath.startsWith(projectRoot + sep)) {
    return null;
  }

  const rel = relative(projectRoot, absolutePath);
  if (rel.length === 0) return null;
  return rel.split(sep).join('/');
}

/**
 * Records one output file in the manifest if not already recorded.
 *
 * - Resolves `filePath` against `projectDir`. If the resolved path does
 *   NOT fall under `projectDir`, returns false (drop — out of project).
 * - If `(taskId, role, projectRelativePath)` is already in the in-process
 *   dedupe set, returns false (drop — duplicate).
 * - Otherwise line-appends one YAML entry to
 *   `<projectDir>/.forjis/tasks/<taskId>/output-files.yaml`, creating the
 *   file with the `files:` header on first write, and inserts the key into
 *   the dedupe set. Returns true.
 *
 * Uses appendFile (line-append, NEVER full-rewrite) so concurrent role
 * writes cannot trample each other.
 *
 * @param projectDir - Absolute project root path.
 * @param taskId - Task identifier.
 * @param role - Role name from `event.role`. NEVER 'orchestrator' (caller filters).
 * @param filePath - Tool-call file path (may be absolute or relative).
 * @param label - Optional display label; defaults to basename(filePath).
 * @param createdAt - Optional ISO timestamp; defaults to now.
 * @returns True when the manifest was extended, false when the entry was dropped.
 */
export async function appendManifestEntry(
  projectDir: string,
  taskId: string,
  role: string,
  filePath: string,
  label?: string,
  createdAt?: string,
): Promise<boolean> {
  const projectRelative = toProjectRelative(projectDir, filePath);
  if (projectRelative === null) {
    return false;
  }

  const dedupeKey = `${taskId}|${role}|${projectRelative}`;
  if (seen.has(dedupeKey)) {
    return false;
  }

  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);
  const manifestPath = join(taskDir, 'output-files.yaml');
  const displayLabel = label ?? basename(projectRelative);
  const timestamp = createdAt ?? new Date().toISOString();

  try {
    await ensureDir(taskDir);

    let exists = false;
    try {
      await stat(manifestPath);
      exists = true;
    } catch {
      exists = false;
    }

    const entry =
      `  - role: ${role}\n` +
      `    path: ${projectRelative}\n` +
      `    label: ${displayLabel}\n` +
      `    createdAt: "${timestamp}"\n`;

    const payload = exists ? entry : `files:\n${entry}`;
    await appendFile(manifestPath, payload, 'utf-8');
    seen.add(dedupeKey);
    return true;
  } catch {
    return false;
  }
}
