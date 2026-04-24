/**
 * Cross-task exploration overlap selector.
 *
 * Surfaces up to `limit` supplementary `.forjis/exploration/*.md`
 * entries whose `files_touched` intersects the current task's
 * candidate-path set. Feeds the "Prior explorations" section the
 * orchestrator Step 8 composes for Analyst and Architect.
 *
 * Admission criteria:
 *   - frontmatter `status: valid`
 *   - frontmatter `taskId !== currentTaskId`
 *   - frontmatter has non-empty `files_touched` (legacy entries excluded)
 *   - path-set intersection with `candidatePaths` non-empty
 *
 * Sorted by `createdAt` DESC. Default `limit` is 3 (spec R4 cap).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  extractFilesTouched,
  parseExplorationFile,
} from './frontmatter.js';

/** Warning-line prefix. */
const WARN_PREFIX = '[context-cache]:';

/** Default cap for the returned entries. */
const DEFAULT_LIMIT = 3;

/** Options accepted by {@link findOverlappingExplorations}. */
export interface OverlapOptions {
  /** Absolute project root. */
  projectDir: string;
  /** Task ID of the current dispatch (excluded from the result). */
  currentTaskId: string;
  /** Project-relative POSIX paths in the current task's candidate set. */
  candidatePaths: string[];
  /** Max supplementary entries to return. Default: {@link DEFAULT_LIMIT}. */
  limit?: number;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/** One entry returned to the caller. */
export interface OverlapEntry {
  /** taskId pulled from the file's frontmatter. */
  taskId: string;
  /** Body bytes after the closing `---` fence. */
  body: string;
  /** ISO-8601 timestamp from frontmatter. */
  createdAt: string;
}

/**
 * Scans `.forjis/exploration/*.md`, filters by the admission criteria
 * above, sorts by `createdAt` DESC, and returns up to `limit` entries.
 *
 * Never throws — malformed files are skipped with a warning.
 *
 * @param opts - Overlap selection options.
 * @returns Up to `limit` matching entries.
 */
export async function findOverlappingExplorations(
  opts: OverlapOptions,
): Promise<OverlapEntry[]> {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const expDir = join(opts.projectDir, '.forjis', 'exploration');
  const candidateSet = new Set(opts.candidatePaths);
  if (candidateSet.size === 0) return [];

  let files: string[];
  try {
    files = await readdir(expDir);
  } catch {
    return [];
  }

  const entries: OverlapEntry[] = [];
  for (const name of files) {
    if (!name.endsWith('.md')) continue;
    try {
      const matched = await readMatching(
        join(expDir, name),
        candidateSet,
        opts.currentTaskId,
      );
      if (matched !== null) entries.push(matched);
    } catch (err) {
      warn(
        `${WARN_PREFIX} overlap scan skipped one entry — ${errorMessage(err)}`
      );
    }
  }

  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries.slice(0, limit);
}

/**
 * Reads one exploration file and returns an {@link OverlapEntry} when
 * it passes the admission criteria. Returns `null` otherwise.
 */
async function readMatching(
  absPath: string,
  candidateSet: Set<string>,
  currentTaskId: string,
): Promise<OverlapEntry | null> {
  const content = await readFile(absPath, 'utf-8');
  const parsed = parseExplorationFile(content);
  if (parsed === null) return null;

  if (parsed.frontmatter['status'] !== 'valid') return null;

  const taskId = parsed.frontmatter['taskId'];
  if (typeof taskId !== 'string' || taskId === currentTaskId) return null;

  const createdAt = parsed.frontmatter['createdAt'];
  if (typeof createdAt !== 'string' || createdAt.length === 0) return null;

  const touched = extractFilesTouched(parsed.frontmatter);
  if (touched.length === 0) return null;

  const overlap = touched.some((t) => candidateSet.has(t.path));
  if (!overlap) return null;

  return { taskId, body: parsed.body, createdAt };
}

/** Extracts a string message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
