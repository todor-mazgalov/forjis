/**
 * Augments `.forjis/exploration/<taskId>.md` with a `files_touched`
 * frontmatter list.
 *
 * Called by the facilitator after the orchestrator has written the
 * cache file with its four-field frontmatter. The facilitator owns
 * this field (FR-001 "Facilitator, not persona, owns the field") —
 * we derive the oids from the Explorer's tool-call stream and inject
 * them here.
 *
 * Behaviour:
 *   - Empty `filesRead` → inject `files_touched: []`.
 *   - Non-empty list → dedupe, POSIX-normalise, drop paths outside
 *     `projectDir`, compute oid per path, sort by path ASC.
 *   - Body bytes after the closing `---` fence preserved verbatim.
 *   - Silent no-op when the file does not exist.
 *   - Never throws — per-step failures log + exit cleanly.
 */

import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { computeBlobOidForFile } from './oid.js';
import {
  parseExplorationFile,
  serializeExplorationFile,
} from './frontmatter.js';
import { atomicWriteFile } from '../state.js';

/** Warning-line prefix. */
const WARN_PREFIX = '[context-cache]:';

/** Options accepted by {@link augmentExplorationFilesTouched}. */
export interface AugmentOptions {
  /** Absolute project root. */
  projectDir: string;
  /** Task ID — file is `.forjis/exploration/<taskId>.md`. */
  taskId: string;
  /** Project-relative POSIX paths the Explorer read (dedupe'd internally). */
  filesRead: string[];
  /** Injection seam for oid computation. */
  oidImpl?: typeof computeBlobOidForFile;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/**
 * Reads the exploration cache file, computes oids for the passed
 * paths, and rewrites the frontmatter with the `files_touched` list.
 *
 * Silent no-op when the file does not exist (i.e. the cache write
 * never happened). Never throws.
 *
 * @param opts - Options.
 */
export async function augmentExplorationFilesTouched(
  opts: AugmentOptions,
): Promise<void> {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const oidImpl = opts.oidImpl ?? computeBlobOidForFile;

  const absCachePath = join(
    opts.projectDir,
    '.forjis',
    'exploration',
    `${opts.taskId}.md`,
  );

  try {
    await stat(absCachePath);
  } catch {
    return; // silent no-op when cache file absent
  }

  let content: string;
  try {
    content = await readFile(absCachePath, 'utf-8');
  } catch (err) {
    warn(
      `${WARN_PREFIX} exploration augment skipped — read failed: ${errorMessage(err)}`
    );
    return;
  }

  const parsed = parseExplorationFile(content);
  if (parsed === null) {
    warn(
      `${WARN_PREFIX} exploration augment skipped — malformed frontmatter at "${absCachePath}"`
    );
    return;
  }

  const normalised = deduplicateAndNormalise(opts.filesRead, opts.projectDir);
  const touched = await computeOidsForPaths(
    normalised,
    opts.projectDir,
    oidImpl,
    warn,
  );
  // Sort by path ASC for determinism.
  touched.sort((a, b) => a.path.localeCompare(b.path));

  parsed.frontmatter['files_touched'] = touched.map((t) => ({
    path: t.path,
    oid: t.oid,
  }));

  try {
    const rewritten = serializeExplorationFile(parsed.frontmatter, parsed.body);
    await atomicWriteFile(absCachePath, rewritten);
  } catch (err) {
    warn(
      `${WARN_PREFIX} exploration augment skipped — write failed: ${errorMessage(err)}`
    );
  }
}

/**
 * Dedupe input paths, normalise backslashes to POSIX, and drop any
 * path that escapes `projectDir`.
 */
function deduplicateAndNormalise(paths: string[], projectDir: string): string[] {
  const set = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const posix = raw.replace(/\\/g, '/');
    // Containment check — reject absolute paths outside projectDir,
    // reject any `..`-climb.
    if (posix.startsWith('/') && !posix.startsWith(projectDir.replace(/\\/g, '/'))) {
      continue;
    }
    const rel = toRelativePosix(posix, projectDir);
    if (rel === null) continue;
    if (rel.length === 0) continue;
    set.add(rel);
  }
  return Array.from(set);
}

/**
 * Convert an absolute or project-relative path to a stable
 * project-relative POSIX form. Returns `null` when the path escapes
 * `projectDir`.
 */
function toRelativePosix(path: string, projectDir: string): string | null {
  const posixRoot = projectDir.replace(/\\/g, '/');
  if (path.startsWith(posixRoot)) {
    let rel = path.slice(posixRoot.length);
    while (rel.startsWith('/')) rel = rel.slice(1);
    if (rel.includes('..')) return null;
    return rel;
  }
  if (path.startsWith('/')) {
    // Absolute path outside the project — drop.
    return null;
  }
  if (path.startsWith('..') || path.includes('/../')) return null;
  // Already project-relative.
  return path;
}

/**
 * Computes blob oid for each path; silently drops paths whose oid
 * computation throws (file deleted / read error).
 */
async function computeOidsForPaths(
  paths: string[],
  projectDir: string,
  oidImpl: typeof computeBlobOidForFile,
  warn: (msg: string) => void,
): Promise<Array<{ path: string; oid: string }>> {
  const out: Array<{ path: string; oid: string }> = [];
  for (const rel of paths) {
    try {
      const oid = await oidImpl(projectDir, rel);
      out.push({ path: rel, oid });
    } catch (err) {
      warn(
        `${WARN_PREFIX} files_touched oid computation failed for "${rel}": ${errorMessage(err)}`
      );
    }
  }
  return out;
}

/** Extracts a string message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
