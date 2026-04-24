/**
 * Incremental refresh pipeline for `.forjis/context/tree.yaml` +
 * `.forjis/context/index.md`.
 *
 * Pipeline:
 *   1. Enumerate candidates — `git ls-files` (tracked) ∪ `git status
 *      --porcelain` lines starting with `?? ` (untracked-not-ignored).
 *   2. Deduplicate; drop paths > 256 KB or with a NUL byte in the first
 *      8 KB (binary heuristic).
 *   3. Compute in-process oid per surviving candidate.
 *   4. Diff against previous `tree.yaml`:
 *        - unchanged: preserve old summary.
 *        - changed or new: re-summarise via `summarizeImpl`.
 *        - dropped: absent from the new file.
 *   5. Build `index.md` via `buildIndexMd`.
 *   6. Atomic-write both files.
 *
 * Any failure of the outer pipeline (git unavailable, workspace
 * unreadable) is logged once and the function returns zero counts
 * without side effects — pre-existing files stay untouched. This is
 * the FR-011 best-effort contract.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';

import { ensureDir } from '../state.js';
import { computeBlobOid } from './oid.js';
import { buildIndexMd, type GitResult } from './index-md.js';
import { summarizeFile } from './summarize.js';
import {
  readTreeYaml,
  writeTreeYaml,
  type TreeEntry,
  type TreeYaml,
} from './tree-yaml.js';
import { atomicWriteFile } from '../state.js';

/** Default max file size, in bytes (256 KB). */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Default binary-sniff window, in bytes (8 KB). */
const DEFAULT_BINARY_SNIFF_BYTES = 8 * 1024;

/** Default high-traffic commit window. */
const DEFAULT_HIGH_TRAFFIC_COMMITS = 200;

/** Warning-line prefix shared with the rest of the context-cache module. */
const WARN_PREFIX = '[context-cache]:';

/** Options accepted by {@link refreshTreeYaml}. */
export interface RefreshOptions {
  /** Absolute project root. */
  repoRoot: string;
  /** Skip files exceeding this size, in bytes. Default: 256 * 1024. */
  maxBytes?: number;
  /** First-N-bytes window for NUL-byte binary heuristic. Default: 8 * 1024. */
  binarySniffBytes?: number;
  /** High-traffic commit window for index.md. Default: 200. */
  highTrafficCommits?: number;
  /** Injection seam for git. */
  gitImpl?: (args: string[], cwd: string) => Promise<GitResult>;
  /** Injection seam for the summariser. Must match `summarizeFile`'s shape. */
  summarizeImpl?: typeof summarizeFile;
  /** Injection seam for `Date.now()`. Reserved for future use. */
  now?: () => Date;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/** Return shape of {@link refreshTreeYaml}. */
export interface RefreshResult {
  /** Files re-summarised this run (oid-changed or newly added). */
  summarizedCount: number;
  /** Files whose previous summary was preserved (oid unchanged). */
  keptCount: number;
  /** Files removed from the new tree.yaml (path no longer in candidate set). */
  droppedCount: number;
  /** Files skipped for binary / oversize. */
  skippedCount: number;
}

/** Zero-result when the pipeline bails out early. */
const ZERO_RESULT: RefreshResult = {
  summarizedCount: 0,
  keptCount: 0,
  droppedCount: 0,
  skippedCount: 0,
};

/**
 * Runs the incremental refresh pipeline.
 *
 * Never throws. On failure emits a single warning and returns
 * {@link ZERO_RESULT} with no side effects.
 *
 * @param opts - Refresh options.
 * @returns Count of summarised / kept / dropped / skipped files.
 */
export async function refreshTreeYaml(
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  try {
    return await runPipeline(opts, warn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`${WARN_PREFIX} refresh skipped — ${msg}`);
    return ZERO_RESULT;
  }
}

/** Actual pipeline; extracted so the outer wrapper can own try/catch cleanly. */
async function runPipeline(
  opts: RefreshOptions,
  warn: (msg: string) => void,
): Promise<RefreshResult> {
  const repoRoot = resolvePath(opts.repoRoot);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const sniffBytes = opts.binarySniffBytes ?? DEFAULT_BINARY_SNIFF_BYTES;
  const commitWindow = opts.highTrafficCommits ?? DEFAULT_HIGH_TRAFFIC_COMMITS;
  const git = opts.gitImpl ?? runGit;
  const summarize = opts.summarizeImpl ?? summarizeFile;

  const candidates = await enumerateCandidates(git, repoRoot);
  const contextDir = join(repoRoot, '.forjis', 'context');
  const treePath = join(contextDir, 'tree.yaml');
  const indexPath = join(contextDir, 'index.md');

  const previous = await readTreeYaml(treePath, { warn });
  const oldByPath = new Map<string, TreeEntry>();
  for (const entry of previous.files) {
    oldByPath.set(entry.path, entry);
  }

  const newFiles: TreeEntry[] = [];
  let summarizedCount = 0;
  let keptCount = 0;
  let skippedCount = 0;

  for (const relPath of candidates) {
    const filtered = await filterAndRead(
      repoRoot,
      relPath,
      maxBytes,
      sniffBytes,
    );
    if (filtered === null) {
      skippedCount++;
      continue;
    }
    const { content } = filtered;
    const oid = computeBlobOid(content);
    const old = oldByPath.get(relPath);
    if (old && old.oid === oid) {
      newFiles.push({ path: relPath, oid, summary: old.summary });
      keptCount++;
      continue;
    }
    const result = await summarize(
      { path: relPath, content },
      { warn },
    );
    newFiles.push({ path: relPath, oid, summary: result.summary });
    summarizedCount++;
  }

  // dropped: old entries no longer in the candidate set (including those
  // that still exist but are now skipped for binary/oversize).
  const candidateSet = new Set(candidates);
  let droppedCount = 0;
  for (const oldPath of oldByPath.keys()) {
    if (!candidateSet.has(oldPath)) {
      droppedCount++;
    } else {
      // present in candidate set but not in newFiles (skipped for binary/size).
      const stillIncluded = newFiles.some((f) => f.path === oldPath);
      if (!stillIncluded) {
        droppedCount++;
      }
    }
  }

  // Deterministic ordering — sort by path ASC so the serialised file is
  // byte-stable across runs that see identical candidate sets.
  newFiles.sort((a, b) => a.path.localeCompare(b.path));

  const newTree: TreeYaml = { files: newFiles };
  const indexBody = await buildIndexMd({
    repoRoot,
    tree: newTree,
    commitWindow,
    gitImpl: git,
  });

  await ensureDir(contextDir);
  await writeTreeYaml(treePath, newTree);
  await atomicWriteFile(indexPath, indexBody);

  return {
    summarizedCount,
    keptCount,
    droppedCount,
    skippedCount,
  };
}

/**
 * Builds the candidate-path set: tracked files (`git ls-files`) plus
 * untracked-not-ignored (`git status --porcelain` lines starting with
 * `?? `). Returns POSIX-normalised, deduplicated, sorted paths.
 *
 * On git failure the candidate set is empty (the pipeline then
 * produces a `{files: []}` result + an empty index.md).
 */
async function enumerateCandidates(
  git: (args: string[], cwd: string) => Promise<GitResult>,
  repoRoot: string,
): Promise<string[]> {
  const tracked = await git(['ls-files'], repoRoot);
  const status = await git(['status', '--porcelain'], repoRoot);

  const set = new Set<string>();
  if (tracked.exitCode === 0) {
    for (const line of tracked.stdout.split('\n')) {
      const p = line.trim();
      if (p.length > 0) set.add(p);
    }
  }
  if (status.exitCode === 0) {
    for (const line of status.stdout.split('\n')) {
      if (line.startsWith('?? ')) {
        const p = line.slice(3).trim();
        if (p.length > 0 && !p.endsWith('/')) set.add(p);
      }
    }
  }

  return Array.from(set).sort();
}

/**
 * Stat-and-read a candidate, applying binary + size skip rules.
 *
 * Returns `null` when the file should be skipped (does not exist,
 * oversized, or a NUL byte appears in the first `sniffBytes`). Returns
 * the full working-tree bytes otherwise.
 */
async function filterAndRead(
  repoRoot: string,
  relPath: string,
  maxBytes: number,
  sniffBytes: number,
): Promise<{ content: Buffer } | null> {
  const absPath = join(repoRoot, relPath);
  let size: number;
  try {
    const info = await stat(absPath);
    size = info.size;
  } catch {
    return null;
  }
  if (size > maxBytes) return null;

  let content: Buffer;
  try {
    content = await readFile(absPath);
  } catch {
    return null;
  }

  // Binary heuristic: a NUL byte anywhere in the first sniffBytes
  // indicates binary content per git's own `is_binary` check.
  const sniffLen = Math.min(sniffBytes, content.length);
  for (let i = 0; i < sniffLen; i++) {
    if (content[i] === 0) return null;
  }

  return { content };
}

/**
 * Default git runner via `child_process.spawn`. Collects stdout and
 * resolves with the final exit code. Does not reject on error.
 */
function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', () => {
      resolve({ stdout: '', exitCode: -1 });
    });
    child.on('close', (code) => {
      resolve({ stdout, exitCode: code ?? -1 });
    });
  });
}
