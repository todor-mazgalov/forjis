/**
 * Role-visuals orchestrator for the facilitator.
 *
 * Exports `resolveRoleVisuals` — the per-role entry point called from
 * `run.ts::invokeWithHealthCheck` once per pipeline attempt — and
 * `collectPinAssets`, which enumerates pin-capture outputs inside a
 * task directory. Writes the per-role data artefact YAML consumed by
 * the orchestrator (facilitator does NOT compose prompt text, per
 * pillars/architecture.md §Layer 2 hard rule).
 *
 * Entry-point behaviour:
 *
 *   1. Early-out when `role.visuals` is empty or absent → no artefact,
 *      no log lines (FR-19, FR-20).
 *   2. For each entry:
 *        - `http(s)://` → probe; on fail and `command` present,
 *          acquire subprocess + retry every 2 s up to 30 s wall-clock;
 *          release immediately on timeout.
 *        - `file://`    → glob expansion under `projectDir`.
 *        - `dir://`     → recursive enumeration, depth 3, 5 MB cap.
 *      `credentials` existence is probed via `stat` (no read, ever).
 *   3. Collect pin assets from `.forjis/tasks/<taskId>/pin-*.{png,json}`.
 *   4. Write `.forjis/tasks/<taskId>/visuals-<org>-<team>-<role>.yaml`.
 *   5. Return the refcount keys acquired so the caller can release them
 *      after `engine.invoke` returns.
 *
 * Implements FR-08, FR-09, FR-10, FR-13, FR-14, FR-15, FR-17, FR-18,
 * FR-19, FR-20, NFR-02, NFR-05, NFR-06, NFR-09.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stringify as stringifyYaml } from 'yaml';

import type { RuntimeRole, VisualEntry } from '@forjis/resolver';

import { atomicWriteFile, ensureDir } from '../state.js';
import { probeHttp } from './probe.js';
import type { ProbeResult } from './probe.js';
import { expandDirRecursive, expandFileGlob } from './path-expand.js';
import { acquire, release } from './command-runner.js';

/** Probe retry interval during command boot (ms). */
const RETRY_INTERVAL_MS = 2_000;

/** Total wall-clock budget for the probe→boot→probe loop (ms). */
const BOOT_DEADLINE_MS = 30_000;

/** Max depth honoured by dir:// expansion. */
const DIR_MAX_DEPTH = 3;

/** Max per-file size honoured by dir:// expansion (5 MB). */
const DIR_MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Log-line prefix shared across this module's warnings. */
const WARN_PREFIX = '[role-visuals]:';

/** One of the four schemes the resolver admits on `VisualEntry.location`. */
export type VisualScheme = 'http' | 'https' | 'file' | 'dir';

/** Lifecycle status for a resolved visual entry in the artefact. */
export type VisualStatus =
  | 'reachable'
  | 'probe-failed'
  | 'expanded'
  | 'expanded-empty';

/** A single resolved entry in the on-disk visuals artefact. */
export interface ResolvedVisualEntry {
  /** The original `location` string verbatim. */
  location: string;
  /** Parsed scheme prefix, one of `http`, `https`, `file`, `dir`. */
  scheme: VisualScheme;
  /** Lifecycle discriminator set by the resolver for this entry. */
  status: VisualStatus;
  /** Absolute file paths — empty for http(s) entries or expanded-empty. */
  paths: string[];
  /** Verbatim `tool` spec when declared on the source entry. */
  tool?: string;
  /** Verbatim `credentials` path when declared on the source entry. */
  credentials?: string;
  /** `true` when a declared credentials file was absent at invocation. */
  credentialsMissing?: boolean;
}

/** Full shape of the per-role visuals artefact (YAML-serialised). */
export interface VisualsArtefact {
  /** Schema version; always 1 in this capability. */
  version: 1;
  /** Role identity triple used to key the artefact filename. */
  role: { org: string; team: string; role: string };
  /** One record per source `VisualEntry`, in declaration order. */
  entries: ResolvedVisualEntry[];
  /**
   * Sorted absolute paths of any `pin-*.png` / `pin-*.json` files in
   * the task directory. Always present (empty array when none).
   */
  pinAssets: string[];
}

/** Options accepted by {@link resolveRoleVisuals}. */
export interface ResolveRoleVisualsOptions {
  /** The role being prepared for invocation. */
  role: RuntimeRole;
  /** Identifier of the current task (used for artefact path). */
  taskId: string;
  /** Absolute project root. */
  projectDir: string;
  /** Injection seam: probe. Defaults to {@link probeHttp}. */
  probeImpl?: typeof probeHttp;
  /** Injection seam: glob expansion. Defaults to real impl. */
  expandFileImpl?: typeof expandFileGlob;
  /** Injection seam: recursive dir expansion. Defaults to real impl. */
  expandDirImpl?: typeof expandDirRecursive;
  /** Injection seam: acquire. Defaults to real impl. */
  acquireImpl?: typeof acquire;
  /** Injection seam: release. Defaults to real impl. */
  releaseImpl?: typeof release;
  /** Injection seam: stat (tests override for synthetic FS). */
  statImpl?: typeof stat;
  /** Injection seam: `now()`. Defaults to `Date.now`. */
  now?: () => number;
  /** Injection seam: `sleep(ms)`. Defaults to `timers/promises.setTimeout`. */
  sleepImpl?: typeof sleep;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
  /** Log sink for forwarded command stdio. Defaults to `console.log`. */
  onLine?: (line: string) => void;
}

/** Return shape of {@link resolveRoleVisuals}. */
export interface ResolveRoleVisualsResult {
  /**
   * Absolute path to the written artefact, or `null` when the role had
   * no visuals entries (no artefact written).
   */
  artefactPath: string | null;
  /**
   * Refcount keys acquired during this role's preparation. The caller
   * MUST invoke `release(key)` for every element after `engine.invoke`
   * returns (success or failure). Empty when no commands were spawned.
   */
  acquiredKeys: string[];
}

/**
 * Resolves one role's visuals list and writes the artefact.
 *
 * See the module doc-comment for the step-by-step flow.
 *
 * @param opts - Resolution parameters with optional injection seams.
 * @returns Artefact path (or null) plus refcount keys to release later.
 */
export async function resolveRoleVisuals(
  opts: ResolveRoleVisualsOptions
): Promise<ResolveRoleVisualsResult> {
  if (!opts.role.visuals || opts.role.visuals.length === 0) {
    return { artefactPath: null, acquiredKeys: [] };
  }

  const ctx = bindResolvedOptions(opts);
  const taskDir = join(opts.projectDir, '.forjis', 'tasks', opts.taskId);

  const entries: ResolvedVisualEntry[] = [];
  const acquiredKeys: string[] = [];

  for (const raw of opts.role.visuals) {
    const resolvedEntry = await resolveOneEntry(raw, opts, ctx, acquiredKeys);
    entries.push(resolvedEntry);
  }

  const pinAssets = await collectPinAssets(taskDir);
  const artefact: VisualsArtefact = {
    version: 1,
    role: { org: opts.role.org, team: opts.role.team, role: opts.role.name },
    entries,
    pinAssets,
  };

  const artefactPath = visualsArtefactPath(opts.projectDir, opts.taskId, opts.role);
  await ensureDir(taskDir);
  await atomicWriteFile(artefactPath, stringifyYaml(artefact, { indent: 2 }));

  return { artefactPath, acquiredKeys };
}

/** Returns the absolute on-disk path of a role's visuals artefact. */
function visualsArtefactPath(
  projectDir: string,
  taskId: string,
  role: RuntimeRole
): string {
  const filename = `visuals-${role.org}-${role.team}-${role.name}.yaml`;
  return join(projectDir, '.forjis', 'tasks', taskId, filename);
}

/** Bundled callable seams after defaults have been applied. */
interface BoundOptions {
  probe: NonNullable<ResolveRoleVisualsOptions['probeImpl']>;
  expandFile: NonNullable<ResolveRoleVisualsOptions['expandFileImpl']>;
  expandDir: NonNullable<ResolveRoleVisualsOptions['expandDirImpl']>;
  acquireFn: NonNullable<ResolveRoleVisualsOptions['acquireImpl']>;
  releaseFn: NonNullable<ResolveRoleVisualsOptions['releaseImpl']>;
  statFn: NonNullable<ResolveRoleVisualsOptions['statImpl']>;
  now: () => number;
  sleepFn: typeof sleep;
  warn: (msg: string) => void;
  onLine: (line: string) => void;
}

/** Applies default implementations to every injection seam. */
function bindResolvedOptions(opts: ResolveRoleVisualsOptions): BoundOptions {
  return {
    probe: opts.probeImpl ?? probeHttp,
    expandFile: opts.expandFileImpl ?? expandFileGlob,
    expandDir: opts.expandDirImpl ?? expandDirRecursive,
    acquireFn: opts.acquireImpl ?? acquire,
    releaseFn: opts.releaseImpl ?? release,
    statFn: opts.statImpl ?? stat,
    now: opts.now ?? (() => Date.now()),
    sleepFn: opts.sleepImpl ?? sleep,
    warn: opts.warn ?? ((msg: string) => console.warn(msg)),
    onLine: opts.onLine ?? ((line: string) => console.log(line)),
  };
}

/**
 * Resolves a single visual entry, dispatching to probe/expand logic
 * by scheme and populating credentials metadata.
 */
async function resolveOneEntry(
  raw: VisualEntry,
  opts: ResolveRoleVisualsOptions,
  ctx: BoundOptions,
  acquiredKeys: string[]
): Promise<ResolvedVisualEntry> {
  const scheme = extractScheme(raw.location);
  let status: VisualStatus;
  let paths: string[] = [];

  if (scheme === 'http' || scheme === 'https') {
    status = await resolveHttpEntry(raw, opts, ctx, acquiredKeys);
  } else if (scheme === 'file') {
    const result = await resolveFileEntry(raw, opts, ctx);
    status = result.status;
    paths = result.paths;
  } else {
    const result = await resolveDirEntry(raw, opts, ctx);
    status = result.status;
    paths = result.paths;
  }

  const entry: ResolvedVisualEntry = {
    location: raw.location,
    scheme,
    status,
    paths,
  };
  if (raw.tool !== undefined) entry.tool = raw.tool;
  if (raw.credentials !== undefined) {
    entry.credentials = raw.credentials;
    const missing = await probeCredentialsMissing(raw.credentials, opts, ctx);
    if (missing) {
      entry.credentialsMissing = true;
    }
  }
  return entry;
}

/**
 * Executes the probe → optional boot → retry loop for a single
 * `http(s)://` entry.
 *
 * Returns the final status. When the entry had a `command` that was
 * spawned, pushes the refcount key onto `acquiredKeys` so the caller
 * can release it later. On a 30 s timeout, releases the key
 * immediately (does not keep a failed server alive for the whole role
 * invocation) and records `probe-failed`.
 */
async function resolveHttpEntry(
  raw: VisualEntry,
  opts: ResolveRoleVisualsOptions,
  ctx: BoundOptions,
  acquiredKeys: string[]
): Promise<VisualStatus> {
  const initial = await ctx.probe(raw.location);
  if (initial.reachable) {
    return 'reachable';
  }
  if (!raw.command) {
    return 'probe-failed';
  }

  const roleLabel = `${opts.role.org}:${opts.role.team}:${opts.role.name}`;
  const { key } = ctx.acquireFn({
    location: raw.location,
    command: raw.command,
    projectDir: opts.projectDir,
    roleLabel,
    onLine: ctx.onLine,
  });
  acquiredKeys.push(key);

  const result = await probeWithRetry(raw.location, ctx);
  if (result === 'reachable') {
    return 'reachable';
  }
  // Probe timed out. Release immediately so a failed server is not
  // kept alive for the remainder of the role invocation.
  ctx.warn(
    `${WARN_PREFIX} boot timeout for ${raw.location} on role "${roleLabel}"`
  );
  const keyIndex = acquiredKeys.indexOf(key);
  if (keyIndex !== -1) {
    acquiredKeys.splice(keyIndex, 1);
  }
  await ctx.releaseFn(key).catch(() => {
    /* idempotent — swallow release errors */
  });
  return 'probe-failed';
}

/**
 * Retries the probe on 2-second cadence up to the 30-second deadline.
 *
 * The first retry happens immediately; subsequent retries are spaced
 * by `RETRY_INTERVAL_MS`. `now()` / `sleep()` are injected so
 * `jest.useFakeTimers()` can drive the cadence deterministically.
 *
 * @returns `'reachable'` on first success; `'probe-failed'` on timeout.
 */
async function probeWithRetry(
  url: string,
  ctx: BoundOptions
): Promise<'reachable' | 'probe-failed'> {
  const start = ctx.now();
  // Attempt at t=0, t=2s, t=4s, …, t=30s (inclusive).
  while (ctx.now() - start <= BOOT_DEADLINE_MS) {
    const result: ProbeResult = await ctx.probe(url);
    if (result.reachable) {
      return 'reachable';
    }
    if (ctx.now() - start >= BOOT_DEADLINE_MS) {
      return 'probe-failed';
    }
    await ctx.sleepFn(RETRY_INTERVAL_MS);
  }
  return 'probe-failed';
}

/**
 * Resolves a `file://` entry via glob expansion.
 */
async function resolveFileEntry(
  raw: VisualEntry,
  opts: ResolveRoleVisualsOptions,
  ctx: BoundOptions
): Promise<{ status: VisualStatus; paths: string[] }> {
  const result = await ctx.expandFile(raw.location, { projectDir: opts.projectDir });
  for (const warning of result.escapeWarnings) {
    ctx.warn(`${WARN_PREFIX} ${warning}`);
  }
  if (result.paths.length === 0) {
    ctx.warn(
      `${WARN_PREFIX} "${raw.location}" matched no files for role "${opts.role.org}:${opts.role.team}:${opts.role.name}"`
    );
    return { status: 'expanded-empty', paths: [] };
  }
  return { status: 'expanded', paths: result.paths };
}

/**
 * Resolves a `dir://` entry via recursive enumeration.
 */
async function resolveDirEntry(
  raw: VisualEntry,
  opts: ResolveRoleVisualsOptions,
  ctx: BoundOptions
): Promise<{ status: VisualStatus; paths: string[] }> {
  const result = await ctx.expandDir(raw.location, {
    projectDir: opts.projectDir,
    maxDepth: DIR_MAX_DEPTH,
    maxFileSize: DIR_MAX_FILE_SIZE,
  });
  for (const s of result.skipped) {
    ctx.warn(`${WARN_PREFIX} skipped "${s.path}" (${s.reason})`);
  }
  if (result.paths.length === 0) {
    ctx.warn(
      `${WARN_PREFIX} "${raw.location}" matched no files for role "${opts.role.org}:${opts.role.team}:${opts.role.name}"`
    );
    return { status: 'expanded-empty', paths: [] };
  }
  return { status: 'expanded', paths: result.paths };
}

/**
 * Returns `true` when the declared `credentials` path does not exist
 * at invocation time. Uses `stat` only — the facilitator NEVER calls
 * `readFile` on a credentials path (FR-18).
 */
async function probeCredentialsMissing(
  credentials: string,
  opts: ResolveRoleVisualsOptions,
  ctx: BoundOptions
): Promise<boolean> {
  const absPath = resolvePath(opts.projectDir, credentials);
  try {
    await ctx.statFn(absPath);
    return false;
  } catch {
    ctx.warn(
      `${WARN_PREFIX} credentials file "${credentials}" missing at invocation for role "${opts.role.org}:${opts.role.team}:${opts.role.name}"`
    );
    return true;
  }
}

/** Extracts the scheme prefix from a `VisualEntry.location`. */
function extractScheme(location: string): VisualScheme {
  const idx = location.indexOf('://');
  const scheme = idx === -1 ? '' : location.slice(0, idx);
  if (scheme === 'http' || scheme === 'https' || scheme === 'file' || scheme === 'dir') {
    return scheme;
  }
  // Resolver guarantees the scheme is in the allowlist; this fallback
  // exists for defensive strictness.
  return 'http';
}

/**
 * Enumerates every `pin-*.png` and `pin-*.json` in `taskDir`, sorted
 * lexicographically. Returns absolute paths. Missing directory → `[]`.
 *
 * @param taskDir - Absolute path of `.forjis/tasks/<taskId>/`.
 */
export async function collectPinAssets(taskDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(taskDir);
  } catch {
    return [];
  }
  const matches = entries.filter(
    (name) =>
      (name.startsWith('pin-') && name.endsWith('.png')) ||
      (name.startsWith('pin-') && name.endsWith('.json'))
  );
  matches.sort();
  return matches.map((name) => join(taskDir, name));
}
