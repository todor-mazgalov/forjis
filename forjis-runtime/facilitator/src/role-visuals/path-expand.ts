/**
 * Path expansion helpers for the role-visuals facilitator module.
 *
 * Exports two async helpers:
 *   - `expandFileGlob(pattern, opts)` — resolves a `file://` glob relative
 *     to `projectDir`, returning absolute matching file paths whose
 *     realpath is inside the project root.
 *   - `expandDirRecursive(relativePath, opts)` — walks a `dir://` target
 *     recursively with depth and per-file size limits.
 *
 * Both helpers perform three-layer containment checks (raw `..` reject,
 * lexical `startsWith`, realpath re-check) so symlink-based escapes
 * cannot slip through. Implements FR-13, FR-14, NFR-08.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath, sep as pathSep } from 'node:path';

/** Common option bundle shared by both expansion helpers. */
export interface ExpandOptions {
  /** Absolute path to the project root used as the containment boundary. */
  projectDir: string;
  /** Max directory depth honoured by {@link expandDirRecursive}. Defaults to 3. */
  maxDepth?: number;
  /** Max per-file size in bytes honoured by {@link expandDirRecursive}. Defaults to 5 MB. */
  maxFileSize?: number;
}

/** Default recursive enumeration depth when `maxDepth` is omitted. */
const DEFAULT_MAX_DEPTH = 3;

/** Default per-file size limit (5 MB) when `maxFileSize` is omitted. */
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Result bundle returned by {@link expandFileGlob}. */
export interface FileGlobResult {
  /** Absolute paths whose realpath is inside `projectDir`. */
  paths: string[];
  /** Human-readable warnings (e.g. "path X escapes projectDir"). */
  escapeWarnings: string[];
}

/** Result bundle returned by {@link expandDirRecursive}. */
export interface DirExpandResult {
  /** Absolute paths retained after size + containment filters. */
  paths: string[];
  /** Per-file skip reasons for user-facing warnings. */
  skipped: { path: string; reason: 'too-large' | 'escape' }[];
}

/**
 * Expands a `file://` glob pattern into absolute paths contained inside
 * `projectDir`.
 *
 * Strips the `file://` scheme prefix, normalises Windows-style
 * backslashes to forward slashes, rejects raw `..` segments, resolves
 * the remainder relative to `projectDir`, then invokes Node's
 * `fs.glob()` for match enumeration. Every match is subjected to the
 * same realpath containment check used by the resolver's post-compose
 * pass — escaping matches are silently dropped with a warning returned
 * on the `escapeWarnings` channel (not thrown).
 *
 * @param pattern - The full `file://...` location string verbatim from
 *   the role's `VisualEntry.location`. Anything before the `://` marker
 *   is stripped; everything after is treated as the glob pattern.
 * @param opts - Containment options.
 * @returns Absolute matched paths and any escape warnings.
 */
export async function expandFileGlob(
  pattern: string,
  opts: ExpandOptions
): Promise<FileGlobResult> {
  const stripped = stripScheme(pattern);
  const normalised = stripped.replace(/\\/g, '/');

  if (containsDotDotSegment(normalised)) {
    return {
      paths: [],
      escapeWarnings: [`glob pattern "${pattern}" contains ".." segment — dropped`],
    };
  }

  const absPattern = isAbsolute(normalised)
    ? normalised
    : resolvePath(opts.projectDir, normalised);

  const realProjectDir = await safeRealpath(opts.projectDir);
  const matches = await globMatch(absPattern);

  const paths: string[] = [];
  const escapeWarnings: string[] = [];
  for (const match of matches) {
    const containedMatch = await verifyContainment(match, opts.projectDir, realProjectDir);
    if (containedMatch === null) {
      escapeWarnings.push(`"${match}" escapes projectDir — dropped`);
      continue;
    }
    paths.push(containedMatch);
  }
  paths.sort();
  return { paths, escapeWarnings };
}

/**
 * Recursively enumerates files under a `dir://` location.
 *
 * Strips the `dir://` scheme, normalises slashes, rejects raw `..`
 * segments, resolves relative to `projectDir`, then walks the tree
 * with `readdir({ withFileTypes: true, recursive: true })`. Each file
 * is filtered by:
 *   1. Containment (realpath inside `projectDir`) — escapes are
 *      dropped with a `reason: 'escape'` skip record.
 *   2. Size — files whose `stat().size` exceeds `maxFileSize` are
 *      dropped with `reason: 'too-large'`.
 *
 * Depth is measured by the number of path segments between the target
 * root and the file, e.g. `target/a.txt` is depth 1, `target/a/b.txt`
 * is depth 2. Files at depth > `maxDepth` are silently excluded (no
 * skip record).
 *
 * @param relativePath - The full `dir://...` location string verbatim.
 * @param opts - Containment + limits.
 * @returns Retained paths and per-file skip records.
 */
export async function expandDirRecursive(
  relativePath: string,
  opts: ExpandOptions
): Promise<DirExpandResult> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const stripped = stripScheme(relativePath);
  const normalised = stripped.replace(/\\/g, '/');

  if (containsDotDotSegment(normalised)) {
    return {
      paths: [],
      skipped: [{ path: relativePath, reason: 'escape' }],
    };
  }

  const absRoot = isAbsolute(normalised)
    ? normalised
    : resolvePath(opts.projectDir, normalised);

  const realProjectDir = await safeRealpath(opts.projectDir);
  const containedRoot = await verifyContainment(absRoot, opts.projectDir, realProjectDir);
  if (containedRoot === null) {
    return {
      paths: [],
      skipped: [{ path: absRoot, reason: 'escape' }],
    };
  }

  const entries = await safeReaddir(containedRoot);
  const paths: string[] = [];
  const skipped: DirExpandResult['skipped'] = [];

  for (const relEntry of entries) {
    const absEntry = resolvePath(containedRoot, relEntry);
    const depth = computeDepth(containedRoot, absEntry);
    if (depth > maxDepth) continue;
    await processDirEntry(absEntry, { realProjectDir, projectDir: opts.projectDir, maxFileSize }, paths, skipped);
  }
  paths.sort();
  return { paths, skipped };
}

/**
 * Reads the entries under `root` (recursive), returning relative paths.
 *
 * Includes regular files AND symbolic links — symlinks are enumerated
 * here so the containment check downstream can inspect the realpath
 * and decide whether to drop the entry. Directories themselves are
 * not emitted; only their descendant files are.
 */
async function safeReaddir(root: string): Promise<string[]> {
  try {
    const out = await readdir(root, { withFileTypes: true, recursive: true });
    // `fs.Dirent.isFile()` returns false for symlinks, even when the
    // target is a regular file. We therefore union files with
    // symlinks so escape tests can observe the dropped entry via the
    // downstream realpath check.
    return out
      .filter((dirent) => dirent.isFile() || dirent.isSymbolicLink())
      .map((dirent) => {
        // `parentPath` is stable on Node 20.12+; the older `path` alias
        // is still emitted by some runtimes. Fall back to `root` when
        // neither is populated.
        const direntAsRecord = dirent as unknown as Record<string, unknown>;
        const parent =
          (typeof direntAsRecord['parentPath'] === 'string' && direntAsRecord['parentPath']) ||
          (typeof direntAsRecord['path'] === 'string' && direntAsRecord['path']) ||
          root;
        const abs = resolvePath(parent as string, dirent.name);
        return relative(root, abs);
      });
  } catch {
    return [];
  }
}

/**
 * Applies containment + size filters to a single dir-walk entry and
 * appends the result to either `paths` or `skipped`.
 */
async function processDirEntry(
  absEntry: string,
  ctx: { realProjectDir: string; projectDir: string; maxFileSize: number },
  paths: string[],
  skipped: DirExpandResult['skipped']
): Promise<void> {
  const contained = await verifyContainment(absEntry, ctx.projectDir, ctx.realProjectDir);
  if (contained === null) {
    skipped.push({ path: absEntry, reason: 'escape' });
    return;
  }
  try {
    const st = await stat(contained);
    if (st.size > ctx.maxFileSize) {
      skipped.push({ path: contained, reason: 'too-large' });
      return;
    }
    paths.push(contained);
  } catch {
    /* File vanished between readdir and stat — silently skip. */
  }
}

/**
 * Computes depth of `abs` relative to `root`, where `root` itself is
 * depth 0 and a direct child is depth 1.
 */
function computeDepth(root: string, abs: string): number {
  const rel = relative(root, abs);
  if (rel === '') return 0;
  return rel.split(pathSep).length;
}

/**
 * Runs Node's `fs.glob` against an absolute pattern and returns the
 * collected absolute matches. When `fs.glob` is unavailable (older
 * Node), falls back to a minimal `readdir` walk rooted at the pattern's
 * literal prefix.
 *
 * @param absPattern - Absolute glob pattern (may contain `*` / `?`).
 */
async function globMatch(absPattern: string): Promise<string[]> {
  // Node 22+ ships `fs.glob` as a stable async generator. We dynamic-
  // import to stay compatible with Node 20.
  try {
    const fsMod = await import('node:fs/promises');
    const glob = (fsMod as unknown as { glob?: (pattern: string) => AsyncIterable<string> }).glob;
    if (typeof glob === 'function') {
      const out: string[] = [];
      for await (const path of glob(absPattern)) {
        out.push(path);
      }
      return out;
    }
  } catch {
    /* fall through to manual walk */
  }
  return fallbackGlob(absPattern);
}

/**
 * Minimal glob fallback for Node 20 when `fs.glob` is not available.
 *
 * Splits the pattern on the first wildcard, enumerates files under the
 * literal prefix, then filters them against a regex derived from the
 * wildcard tail. Supports `*` and `?` only (no `**` recursion,
 * no character classes) — sufficient for the simple `dir/*.png`
 * patterns the visuals spec calls out. The production path on Node 22+
 * goes through `fs.glob` and has full semantics.
 *
 * @param absPattern - Absolute glob pattern.
 */
async function fallbackGlob(absPattern: string): Promise<string[]> {
  const wildcardIdx = firstWildcardIndex(absPattern);
  if (wildcardIdx === -1) {
    // No wildcard — treat as a literal path lookup.
    try {
      await stat(absPattern);
      return [absPattern];
    } catch {
      return [];
    }
  }
  const lastSepBefore = absPattern.lastIndexOf(pathSep, wildcardIdx);
  const literalPrefix = absPattern.slice(0, lastSepBefore);
  const wildcardTail = absPattern.slice(lastSepBefore + 1);
  const regex = wildcardToRegex(wildcardTail);

  try {
    const entries = await readdir(literalPrefix, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && regex.test(e.name))
      .map((e) => resolvePath(literalPrefix, e.name));
  } catch {
    return [];
  }
}

/** Returns the first index of a glob wildcard (`*`, `?`, `[`), or -1. */
function firstWildcardIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '*' || ch === '?' || ch === '[') return i;
  }
  return -1;
}

/**
 * Converts a simple glob tail (with `*` and `?`) into an anchored
 * regex. Character classes and `**` are not supported by the fallback.
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Strips the first `://`-terminated scheme prefix from a location
 * string. If no `://` marker exists, returns the input verbatim.
 */
function stripScheme(input: string): string {
  const idx = input.indexOf('://');
  return idx === -1 ? input : input.slice(idx + '://'.length);
}

/**
 * Returns `true` when any forward-slash segment of `value` equals the
 * literal `..`. Backslashes are normalised upstream.
 */
function containsDotDotSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '..');
}

/**
 * Verifies `candidate` is inside `projectDir` at both the lexical and
 * realpath layers. Returns the realpath on success, or `null` when the
 * path escapes.
 *
 * Callers pass candidates that may already be real (e.g. they came
 * through an earlier `realpath` hop) or still virtual (e.g. a direct
 * child of the supplied `projectDir`). The check therefore accepts
 * containment against either the virtual `projectDir` OR the realpath
 * `realProjectDir`, and always returns the realpath form so downstream
 * consumers see a canonical path.
 */
async function verifyContainment(
  candidate: string,
  projectDir: string,
  realProjectDir: string
): Promise<string | null> {
  const absProjectDir = resolvePath(projectDir);
  const lexicallyInside =
    isLexicallyInside(candidate, absProjectDir) ||
    isLexicallyInside(candidate, realProjectDir);
  if (!lexicallyInside) {
    return null;
  }
  try {
    const real = await realpath(candidate);
    if (!isLexicallyInside(real, realProjectDir)) {
      return null;
    }
    return real;
  } catch {
    // File may not exist yet — a lexical match on a non-existent path
    // is safe because the caller treats missing files as no-op misses.
    return candidate;
  }
}

/**
 * Returns `true` when `candidate` is equal to `root` or sits below it
 * lexically. Path separator is platform-aware via `node:path`.
 */
function isLexicallyInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + pathSep);
}

/** Realpath wrapper that falls back to the lexical input on failure. */
async function safeRealpath(value: string): Promise<string> {
  try {
    return await realpath(resolvePath(value));
  } catch {
    return resolvePath(value);
  }
}
