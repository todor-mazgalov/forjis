/**
 * Tunnel launcher for the `forjis dev --tunnel` flag.
 *
 * Probes the system `PATH` for a supported tunnel binary
 * (`cloudflared` first, then `ngrok`), spawns the first match with
 * arguments that expose the local inspector port, and resolves once the
 * public URL is parsed from the subprocess's stdout/stderr. When neither
 * binary is present, a {@link TunnelToolMissingError} is thrown — no
 * auto-install is ever performed.
 *
 * The launcher forwards every subprocess line to a caller-supplied
 * `logger` callback so the user can see the tunnel tool's progress
 * alongside the rest of the `[dev]` output.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { TunnelToolMissingError } from '../errors.js';

/** Shape of the tunnel subprocess spawned by this module (stdin ignored). */
type TunnelChild = ChildProcessByStdio<null, Readable, Readable>;

/** Default grace period before escalating `SIGTERM` to `SIGKILL`. */
const DEFAULT_GRACE_PERIOD_MS = 5_000;

/** Regex capturing a Cloudflare quick-tunnel URL anywhere in a line. */
const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Regex capturing an ngrok public URL embedded in its JSON log output. */
const NGROK_URL_RE = /"url":"(https:\/\/[^"]+)"/;

/** Name of the `which`-style lookup command per platform. */
const WHICH_COMMAND = process.platform === 'win32' ? 'where' : 'which';

/**
 * Supported tunnel tool names. `cloudflared` is probed first because its
 * quick-tunnel mode requires no account setup, matching the lowest
 * activation friction.
 */
export type TunnelTool = 'cloudflared' | 'ngrok';

/**
 * Options accepted by {@link launchTunnel}.
 */
export interface LaunchTunnelOptions {
  /** Local host the tunnel tool should point at. */
  host: string;
  /** Local inspector port the tunnel tool should expose. */
  port: number;
  /** Callback invoked with each subprocess stdout/stderr line. */
  logger: (line: string) => void;
}

/**
 * Handle returned by {@link launchTunnel}.
 */
export interface Tunnel {
  /** Which tool ultimately spawned (`cloudflared` or `ngrok`). */
  readonly tool: TunnelTool;
  /** Public HTTPS URL extracted from the subprocess output. */
  readonly publicUrl: string;
  /**
   * Gracefully terminate the tunnel subprocess with the same
   * `SIGTERM` → `SIGKILL` 5 s escalation used by the dev-server helper.
   */
  close(): Promise<void>;
}

/**
 * Probe whether `tool` is reachable via the platform's `which` command.
 *
 * Spawns `which` / `where` with `{ stdio: 'ignore' }` and resolves on
 * `close`. Non-zero exit codes and spawn errors resolve `false`.
 *
 * @param tool - Binary to look up on `PATH`.
 * @returns `true` when the binary is on `PATH`, `false` otherwise.
 */
async function probeTool(tool: TunnelTool): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    try {
      const child = spawn(WHICH_COMMAND, [tool], { stdio: 'ignore' });
      child.once('error', () => resolvePromise(false));
      child.once('close', (code) => resolvePromise(code === 0));
    } catch {
      resolvePromise(false);
    }
  });
}

/**
 * Build the argv for the selected tunnel tool.
 *
 * @param tool - Tool to invoke.
 * @param host - Local host the tunnel should point at.
 * @param port - Local port the tunnel should expose.
 * @returns The argv passed to `spawn`.
 */
function buildArgv(tool: TunnelTool, host: string, port: number): string[] {
  if (tool === 'cloudflared') {
    return ['tunnel', '--url', `http://${host}:${port}`];
  }
  return ['http', String(port), '--log=stdout', '--log-format=json'];
}

/**
 * Extract the public URL from a single output line for `tool`.
 *
 * @param tool - Which tool's output we are parsing.
 * @param line - A single line of stdout or stderr.
 * @returns The extracted URL, or `null` when the line contains no match.
 */
function extractPublicUrl(tool: TunnelTool, line: string): string | null {
  if (tool === 'cloudflared') {
    const match = CLOUDFLARED_URL_RE.exec(line);
    return match ? match[0] : null;
  }
  const match = NGROK_URL_RE.exec(line);
  return match ? match[1] : null;
}

/**
 * Attach line-oriented listeners to stdout and stderr and invoke
 * `onLine` for every complete line.
 *
 * @param child - Spawned tunnel subprocess.
 * @param onLine - Callback fired once per complete line.
 */
function forwardLines(
  child: TunnelChild,
  onLine: (line: string) => void,
): void {
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = '';
      }
    });
  }
}

/**
 * Terminate a tunnel subprocess with the standard
 * `SIGTERM` → `SIGKILL` escalation.
 *
 * @param child - Subprocess to terminate.
 * @param exited - Promise resolving when the child has fully exited.
 */
async function terminateChild(
  child: TunnelChild,
  exited: Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited;
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* child already gone */
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, DEFAULT_GRACE_PERIOD_MS);
  killTimer.unref();

  try {
    await exited;
  } finally {
    clearTimeout(killTimer);
  }
}

/**
 * Context passed between {@link waitForPublicUrl} and its nested helpers.
 */
interface UrlAwaitContext {
  tool: TunnelTool;
  child: TunnelChild;
  logger: (line: string) => void;
}

/**
 * Wait for the subprocess to print a parseable public URL.
 *
 * Resolves with the first match; rejects if the subprocess exits before
 * a URL is seen.
 *
 * @param ctx - Context bundle.
 * @returns Promise resolving with the captured public URL.
 */
function waitForPublicUrl(ctx: UrlAwaitContext): Promise<string> {
  const { tool, child, logger } = ctx;
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let captured = false;

    forwardLines(child, (line) => {
      logger(line);
      if (captured) return;
      const url = extractPublicUrl(tool, line);
      if (url !== null) {
        captured = true;
        resolvePromise(url);
      }
    });

    child.once('error', (err) => {
      if (!captured) {
        rejectPromise(err);
      }
    });
    child.once('exit', (code, signal) => {
      if (!captured) {
        rejectPromise(
          new Error(
            `tunnel tool "${tool}" exited before emitting a public URL ` +
              `(code=${code}, signal=${signal})`,
          ),
        );
      }
    });
  });
}

/**
 * Spawn the chosen tunnel tool and resolve once its public URL appears.
 *
 * @param tool - Which tunnel tool was detected.
 * @param opts - Caller-supplied options bundle.
 * @returns A {@link Tunnel} handle.
 */
async function spawnTunnel(
  tool: TunnelTool,
  opts: LaunchTunnelOptions,
): Promise<Tunnel> {
  const argv = buildArgv(tool, opts.host, opts.port);
  const child: TunnelChild = spawn(tool, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const exited = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
  });

  const publicUrl = await waitForPublicUrl({ tool, child, logger: opts.logger });

  return {
    tool,
    publicUrl,
    async close(): Promise<void> {
      await terminateChild(child, exited);
    },
  };
}

/**
 * Probe `cloudflared` then `ngrok`, spawning the first match and
 * resolving with a handle once the public URL is captured.
 *
 * @param opts - Bundle of launch options.
 * @returns A {@link Tunnel} handle whose `publicUrl` is already populated.
 * @throws {TunnelToolMissingError} When neither binary is on `PATH`.
 */
export async function launchTunnel(opts: LaunchTunnelOptions): Promise<Tunnel> {
  const candidates: TunnelTool[] = ['cloudflared', 'ngrok'];
  for (const tool of candidates) {
    if (await probeTool(tool)) {
      opts.logger(`using ${tool}`);
      return spawnTunnel(tool, opts);
    }
  }
  throw new TunnelToolMissingError();
}
