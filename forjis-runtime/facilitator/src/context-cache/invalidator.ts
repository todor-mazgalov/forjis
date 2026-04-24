/**
 * Post-commit invalidation pass for `.forjis/exploration/*.md`.
 *
 * After the facilitator transitions a task's queue row to `done`, this
 * module scans every cached exploration file. For each entry whose
 * frontmatter has `status: valid` and whose `files_touched` list
 * intersects the commit's changeset, the frontmatter is rewritten to:
 *
 *   - flip `status: valid → invalid`
 *   - stamp `invalidatedAt: <iso8601>`
 *   - stamp `invalidatedBy: <taskId>`
 *
 * The body (bytes after the closing `---`) is preserved verbatim.
 *
 * Never throws. Per-file failure logs one line and the scan continues
 * for remaining files. Legacy entries without `files_touched` are
 * skipped (R3 / R11).
 */

import { readdir } from 'node:fs/promises';
import type { readFile as readFileType, writeFile as writeFileType } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  extractFilesTouched,
  parseExplorationFile,
  serializeExplorationFile,
} from './frontmatter.js';

/** Warning-line prefix. */
const WARN_PREFIX = '[context-cache]:';

/** Options accepted by {@link invalidateExplorations}. */
export interface InvalidateOptions {
  /** Absolute project root. */
  projectDir: string;
  /** ID of the task whose commit triggered the scan. */
  taskId: string;
  /**
   * Paths changed by the commit. Values can be bare paths or
   * `git diff-tree --name-status` lines (e.g. `R100\told\tnew`).
   * The invalidator parses both forms so the caller can pass raw
   * `git diff-tree` output directly.
   */
  changedPaths: string[];
  /** ISO-8601 stamp to write into invalidated entries. */
  now: Date;
  /** Injection seam for `fs.readFile`. */
  readFileImpl?: typeof readFileType;
  /** Injection seam for `fs.writeFile`. */
  writeFileImpl?: typeof writeFileType;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/** Return shape of {@link invalidateExplorations}. */
export interface InvalidateResult {
  /** Count of entries whose status flipped this run. */
  invalidatedCount: number;
  /** Entries skipped because they lacked files_touched or were already invalid. */
  skippedCount: number;
}

/** Initial zero-counts. */
const ZERO_RESULT: InvalidateResult = {
  invalidatedCount: 0,
  skippedCount: 0,
};

/**
 * Walks `.forjis/exploration/*.md` and flips the status of every valid
 * entry whose `files_touched` intersects `changedPaths`.
 *
 * Never throws — per-file failures log + continue.
 *
 * @param opts - Invalidation options.
 * @returns Counts of invalidated and skipped entries.
 */
export async function invalidateExplorations(
  opts: InvalidateOptions,
): Promise<InvalidateResult> {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const readImpl = opts.readFileImpl ?? readFile;
  const writeImpl = opts.writeFileImpl ?? writeFile;

  const expDir = join(opts.projectDir, '.forjis', 'exploration');
  const changedSet = normaliseChangedPaths(opts.changedPaths);
  if (changedSet.size === 0) {
    return ZERO_RESULT;
  }

  let files: string[];
  try {
    files = await readdir(expDir);
  } catch {
    return ZERO_RESULT;
  }

  let invalidatedCount = 0;
  let skippedCount = 0;

  for (const name of files) {
    if (!name.endsWith('.md')) continue;
    const abs = join(expDir, name);
    try {
      const flipped = await tryFlipOne(
        abs,
        changedSet,
        opts.taskId,
        opts.now,
        readImpl,
        writeImpl,
      );
      if (flipped === 'flipped') invalidatedCount++;
      else skippedCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`${WARN_PREFIX} post-commit invalidation skipped — ${msg}`);
      skippedCount++;
    }
  }

  return { invalidatedCount, skippedCount };
}

/** Signals whether the per-file flip actually mutated the file. */
type FlipOutcome = 'flipped' | 'skipped';

/**
 * Flip logic for a single file.
 *
 * Returns `'flipped'` when the file was rewritten, `'skipped'` when
 * the entry did not qualify (legacy, already-invalid, non-overlapping).
 */
async function tryFlipOne(
  abs: string,
  changedSet: Set<string>,
  taskId: string,
  now: Date,
  readImpl: typeof readFileType,
  writeImpl: typeof writeFileType,
): Promise<FlipOutcome> {
  const content = await readImpl(abs, 'utf-8');
  const parsed = parseExplorationFile(content as string);
  if (parsed === null) return 'skipped';

  if (parsed.frontmatter['status'] !== 'valid') return 'skipped';
  const touched = extractFilesTouched(parsed.frontmatter);
  if (touched.length === 0) return 'skipped';

  const overlaps = touched.some((entry) => changedSet.has(entry.path));
  if (!overlaps) return 'skipped';

  parsed.frontmatter['status'] = 'invalid';
  parsed.frontmatter['invalidatedAt'] = now.toISOString();
  parsed.frontmatter['invalidatedBy'] = taskId;

  const rewritten = serializeExplorationFile(parsed.frontmatter, parsed.body);
  await writeImpl(abs, rewritten, 'utf-8');
  return 'flipped';
}

/**
 * Normalises the `changedPaths` input.
 *
 * Accepts (a) plain `path` strings and (b) `git diff-tree
 * --name-status` lines of the form `A\tpath`, `M\tpath`, or
 * `R100\told\tnew` / `C75\told\tnew`. For rename / copy status,
 * both `old` and `new` are treated as changed (R3 rename-support
 * scenario).
 */
function normaliseChangedPaths(paths: string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of paths) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Detect a status-letter prefix terminated by a tab. R/C lines have
    // a similarity score (e.g. `R100`) glued to the letter; still
    // terminated by a tab before the paths.
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) {
      set.add(line);
      continue;
    }
    const status = line.slice(0, firstTab);
    const rest = line.slice(firstTab + 1);
    if (/^[A-Z]\d*$/.test(status)) {
      const parts = rest.split('\t').filter((p) => p.length > 0);
      for (const p of parts) set.add(p);
    } else {
      // Not a recognised status prefix — treat the whole line as a path.
      set.add(line);
    }
  }
  return set;
}
