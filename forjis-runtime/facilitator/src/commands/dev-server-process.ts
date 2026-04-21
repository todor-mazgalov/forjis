/**
 * Dev-server subprocess helper for the `forjis dev` command.
 *
 * Spawns a shell command as a child process, forwards its stdout and
 * stderr back to the caller line-by-line with a `[dev] ` prefix, and
 * exposes a deadline-based {@link DevServerProcess.terminate} method that
 * escalates from `SIGTERM` to `SIGKILL` after a configurable grace
 * period. The caller is responsible for installing signal handlers that
 * invoke {@link DevServerProcess.terminate} on shutdown.
 *
 * The helper never interpolates user input into a shell string beyond the
 * single `command` argument the caller provides; arguments such as the
 * shell binary and the `-c` flag are hard-coded and platform-scoped so
 * adversarial input surfaces as a failing child exit rather than unbound
 * shell execution.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Shape of the child process spawned by this module (stdin ignored). */
type DevChild = ChildProcessByStdio<null, Readable, Readable>;

/** Default grace period before escalating `SIGTERM` to `SIGKILL`. */
const DEFAULT_GRACE_PERIOD_MS = 5_000;

/** Prefix applied to every stdout/stderr line forwarded through {@link SpawnDevServerOptions.onLine}. */
const LINE_PREFIX = '[dev] ';

/**
 * Options accepted by {@link spawnDevServer}.
 */
export interface SpawnDevServerOptions {
  /** Shell command string (e.g. `"npm run dev"`). Executed via the platform shell. */
  command: string;
  /** Working directory for the subprocess. Must be an absolute path. */
  cwd: string;
  /**
   * Called once per complete line of combined stdout/stderr with the
   * `[dev] ` prefix already applied.
   */
  onLine: (line: string) => void;
}

/**
 * Handle returned by {@link spawnDevServer}.
 *
 * Exposes a single {@link terminate} method and a read-only {@link exited}
 * promise so callers can observe the subprocess without retaining
 * references to the underlying {@link DevChild}.
 */
export interface DevServerProcess {
  /**
   * Terminate the subprocess with a `SIGTERM` → `SIGKILL` escalation.
   *
   * Idempotent: a second call after the child has already exited is a
   * no-op and resolves immediately.
   *
   * @param gracePeriodMs - Milliseconds to wait after `SIGTERM` before
   *   sending `SIGKILL`. Defaults to 5 s.
   * @returns A promise that resolves once the child has exited.
   */
  terminate(gracePeriodMs?: number): Promise<void>;
  /** Resolves with the child's exit code and terminating signal. */
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
}

/**
 * Pick the shell binary appropriate for the current platform.
 *
 * On POSIX, honours `process.env.SHELL` when present (so `zsh` / `fish`
 * users get their own shell), otherwise falls back to `/bin/sh`. On
 * Windows, always uses `cmd.exe` with `/d /s /c`.
 *
 * @returns A tuple of `[shell, flag]`.
 */
function pickShell(): [string, string] {
  if (process.platform === 'win32') {
    return ['cmd.exe', '/d /s /c'];
  }
  return [process.env.SHELL ?? '/bin/sh', '-c'];
}

/**
 * Stream a Node.js readable, emitting one complete line at a time.
 *
 * Buffers partial lines across chunks so a UTF-8 character split across
 * two reads is not corrupted. The final partial line (no trailing
 * newline) is emitted once the stream ends.
 *
 * @param stream - Readable stream to attach to.
 * @param onLine - Callback invoked with each complete line (no trailing `\n`).
 */
function forwardLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onLine(`${LINE_PREFIX}${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      onLine(`${LINE_PREFIX}${buffer}`);
      buffer = '';
    }
  });
}

/**
 * Install an `exit` listener and return a promise that resolves with the
 * final exit code / signal.
 *
 * @param child - Spawned child process.
 * @returns Promise resolving with the child's `{ code, signal }`.
 */
function observeExit(
  child: DevChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

/**
 * Spawn a shell command as a long-lived dev-server subprocess.
 *
 * The child's `stdio` is `['ignore', 'pipe', 'pipe']` so the subprocess
 * cannot read from the facilitator's stdin. Both stdout and stderr are
 * forwarded to `onLine` with the `[dev] ` prefix.
 *
 * @param opts - Configuration bundle; see {@link SpawnDevServerOptions}.
 * @returns A {@link DevServerProcess} handle.
 */
export function spawnDevServer(opts: SpawnDevServerOptions): DevServerProcess {
  const [shell, shellFlag] = pickShell();
  const child: DevChild = spawn(shell, [shellFlag, opts.command], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  forwardLines(child.stdout, opts.onLine);
  forwardLines(child.stderr, opts.onLine);

  const exited = observeExit(child);
  let terminated = false;

  return {
    exited,
    async terminate(gracePeriodMs = DEFAULT_GRACE_PERIOD_MS): Promise<void> {
      if (terminated) {
        await exited;
        return;
      }
      terminated = true;

      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }

      let killTimer: NodeJS.Timeout | null = null;
      try {
        child.kill('SIGTERM');
      } catch {
        /* child already gone — fall through to exited promise */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore secondary kill failure */
        }
      }, gracePeriodMs);
      killTimer.unref();

      try {
        await exited;
      } finally {
        if (killTimer !== null) {
          clearTimeout(killTimer);
        }
      }
    },
  };
}
