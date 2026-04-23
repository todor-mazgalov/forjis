/**
 * Refcounted subprocess runner for the role-visuals facilitator module.
 *
 * Maintains a module-level `Map` keyed by `(location, command)` so two
 * roles in the same task that declare the same pair share exactly one
 * subprocess. The first `acquire` spawns; subsequent acquires increment
 * the refcount. `release` decrements; at refcount 0 the subprocess is
 * terminated via SIGTERM with a 5-second SIGKILL escalation.
 *
 * `drainAll` is the task-level crash-safety net: it walks every
 * outstanding entry and terminates it, even if per-role releases were
 * skipped due to an engine crash.
 *
 * Implements FR-10, FR-11, FR-12, NFR-03, NFR-04, NFR-07.
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process';
import type { Readable } from 'node:stream';

/** Line prefix applied to every forwarded stdout/stderr line. */
const LINE_PREFIX_ROOT = '[visuals:';

/** Grace period (ms) between SIGTERM and SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

/** Shape of the spawned child when stdin is ignored and stdio piped. */
type RunnerChild = ChildProcessByStdio<null, Readable, Readable>;

/** Internal bookkeeping row held in the refcount map. */
interface Entry {
  readonly process: ChildProcess;
  refcount: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminated: boolean;
  /** Tracks whether the role-scoped forwarder has been attached. */
  listenerAttached: boolean;
}

/**
 * Options accepted by {@link acquire}.
 */
export interface AcquireOptions {
  /** The entry's `location` string — part of the refcount key. */
  location: string;
  /** Shell command to spawn — part of the refcount key. */
  command: string;
  /** Subprocess working directory. */
  projectDir: string;
  /** Role identifier used to prefix forwarded log lines, e.g. `acme:eng:Developer`. */
  roleLabel: string;
  /** Sink invoked once per forwarded line, already prefixed with `[visuals:<role>]`. */
  onLine: (line: string) => void;
  /** Injection seam for tests. Defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
}

/**
 * Handle returned by {@link acquire}.
 *
 * The caller is expected to pass `key` to {@link release} exactly once
 * when the role's invocation finishes (success or failure).
 */
export interface AcquireResult {
  /** Unique key for the `(location, command)` pair. Opaque to callers. */
  key: string;
  /** Exit promise — resolves with the child's final `{ code, signal }`. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Module-level map keyed by `JSON.stringify([location, command])`. */
const active: Map<string, Entry> = new Map();

/**
 * Picks the platform shell used to run the user's command.
 *
 * On POSIX, honours `$SHELL` when set (so users of `zsh`/`fish` see
 * their chosen shell), else `/bin/sh`. On Windows, `cmd.exe /d /s /c`.
 * Matches `dev-server-process.ts::pickShell` exactly so the two paths
 * stay in sync.
 */
function pickShell(): [string, string] {
  if (process.platform === 'win32') {
    return ['cmd.exe', '/d /s /c'];
  }
  return [process.env['SHELL'] ?? '/bin/sh', '-c'];
}

/**
 * Returns the refcount key for a `(location, command)` pair.
 *
 * Uses JSON.stringify so embedded quotes/newlines cannot collide across
 * keys. The key is opaque to callers; they store it on the returned
 * result and pass it back to {@link release}.
 */
function buildKey(location: string, command: string): string {
  return JSON.stringify([location, command]);
}

/**
 * Acquires a subprocess for the given `(location, command)` pair.
 *
 * If an entry already exists AND has not terminated, its refcount is
 * incremented and the existing handle is returned. Otherwise a new
 * subprocess is spawned with `stdio: ['ignore', 'pipe', 'pipe']`,
 * line-forwarding is attached, and the entry is inserted into the map
 * with refcount 1.
 *
 * @param opts - Acquisition parameters.
 * @returns The refcount key and an exit promise.
 */
export function acquire(opts: AcquireOptions): AcquireResult {
  const key = buildKey(opts.location, opts.command);
  const existing = active.get(key);
  if (existing && !existing.terminated) {
    existing.refcount += 1;
    attachRoleLineForwarder(existing, opts.roleLabel, opts.onLine);
    return { key, exited: existing.exited };
  }

  const [shell, shellFlag] = pickShell();
  const spawnFn = opts.spawnImpl ?? spawn;
  const child = spawnFn(shell, [shellFlag, opts.command], {
    cwd: opts.projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as RunnerChild;

  const exited = observeExit(child);
  const entry: Entry = {
    process: child,
    refcount: 1,
    exited,
    terminated: false,
    listenerAttached: false,
  };
  active.set(key, entry);

  attachRoleLineForwarder(entry, opts.roleLabel, opts.onLine);
  exited.then(() => {
    entry.terminated = true;
  }).catch(() => {
    entry.terminated = true;
  });

  return { key, exited };
}

/**
 * Attaches stdout/stderr line forwarders for a specific role.
 *
 * Every line is prefixed with `[visuals:<roleLabel>]`. Multiple roles
 * sharing the same subprocess each attach their own forwarder, so both
 * see the same stdout/stderr stream independently.
 */
function attachRoleLineForwarder(
  entry: Entry,
  roleLabel: string,
  onLine: (line: string) => void
): void {
  const prefix = `${LINE_PREFIX_ROOT}${roleLabel}]`;
  forwardLines(entry.process.stdout as Readable, prefix, onLine);
  forwardLines(entry.process.stderr as Readable, prefix, onLine);
  entry.listenerAttached = true;
}

/**
 * Streams lines from a readable, buffering partial chunks across reads.
 *
 * @param stream - The readable to consume.
 * @param prefix - String prepended to every forwarded line.
 * @param onLine - Sink invoked once per complete line.
 */
function forwardLines(
  stream: Readable,
  prefix: string,
  onLine: (line: string) => void
): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onLine(`${prefix} ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      onLine(`${prefix} ${buffer}`);
      buffer = '';
    }
  });
}

/**
 * Installs an `exit` listener and returns a promise resolving with the
 * child's final `{ code, signal }`.
 */
function observeExit(
  child: RunnerChild
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

/**
 * Releases one refcount hold on the subprocess identified by `key`.
 *
 * When the refcount drops to 0 the subprocess is terminated: SIGTERM
 * is sent immediately, then a 5-second unref'd timer escalates to
 * SIGKILL if the process has not exited. Idempotent — calling
 * `release` for a key that is not in the map (or already at 0) is a
 * no-op and does not raise.
 *
 * @param key - The refcount key returned by {@link acquire}.
 * @returns A promise that resolves once the subprocess has exited (or
 *   immediately if the refcount is still positive, or the key was
 *   never registered).
 */
export async function release(key: string): Promise<void> {
  const entry = active.get(key);
  if (!entry) {
    return;
  }
  if (entry.refcount <= 0) {
    return;
  }
  entry.refcount -= 1;
  if (entry.refcount > 0) {
    return;
  }
  await terminateEntry(entry);
  active.delete(key);
}

/**
 * Terminates an entry with SIGTERM → SIGKILL escalation.
 *
 * Wraps both kill calls in try/catch because the underlying process may
 * have already exited by the time we issue the signal. The 5 s grace
 * timer is `unref()`ed so it does not keep the event loop alive on
 * process shutdown.
 */
async function terminateEntry(entry: Entry): Promise<void> {
  if (entry.terminated) {
    return;
  }
  const { process: child, exited } = entry;
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited;
    entry.terminated = true;
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    /* child already gone — SIGTERM is a no-op */
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore secondary kill failure */
    }
  }, SIGTERM_GRACE_MS);
  killTimer.unref();

  try {
    await exited;
  } finally {
    clearTimeout(killTimer);
    entry.terminated = true;
  }
}

/**
 * Drains every active subprocess.
 *
 * Intended for the task-level `finally` handler so a crashed role can
 * never leak a running subprocess. Signals are sent to every entry up
 * front (in parallel) so a hung child does not block teardown of
 * subsequent entries, then the helper awaits each exit. Idempotent —
 * if per-role releases already fired, the map is empty and `drainAll`
 * returns immediately.
 */
export async function drainAll(): Promise<void> {
  const entries = Array.from(active.entries());
  const terminations = entries.map(async ([key, entry]) => {
    await terminateEntry(entry);
    active.delete(key);
  });
  await Promise.all(terminations);
}

/**
 * Test-only — forcibly clears the refcount map and resets any state.
 *
 * Exported because Jest module-level state survives across tests; calling
 * this in `beforeEach` gives each test a clean slate without having to
 * reimport the module.
 */
export function __resetForTests(): void {
  active.clear();
}
