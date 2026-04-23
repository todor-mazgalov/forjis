/**
 * HTTP probe for the role-visuals facilitator module.
 *
 * Exposes a single `probeHttp()` that spawns `curl -sI --max-time <s> <url>`
 * and classifies the outcome into `{ reachable, statusCode?, detail }`.
 * The spawn call is injected via a `spawnImpl` seam so unit tests can run
 * entirely offline — no real `curl` process is required.
 *
 * Implements FR-09 (HTTP probe) and NFR-02 (deterministic timing).
 */

import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Outcome classification returned by {@link probeHttp}.
 *
 * `reachable` is `true` if and only if `curl` exited 0 AND the parsed
 * HTTP status is 2xx or 3xx. All other outcomes (non-2xx/3xx, curl
 * non-zero exit, wall-clock timeout) are `reachable: false` with a
 * `detail` discriminator for logging.
 */
export interface ProbeResult {
  reachable: boolean;
  /** HTTP status when curl exited 0 and the status line was parseable. */
  statusCode?: number;
  /** Short classification for logs; not shown to the end user. */
  detail: 'ok' | 'non-2xx3xx' | 'curl-error' | 'timeout';
}

/** Options accepted by {@link probeHttp}. */
export interface ProbeOptions {
  /**
   * Value passed to `curl --max-time`. Defaults to 2 seconds.
   *
   * Note: the facilitator also guards the spawn with a wall-clock timer
   * of `(timeoutSeconds + 1) * 1000` ms so a hung curl cannot leak.
   */
  timeoutSeconds?: number;
  /**
   * Injection seam for tests. Defaults to `node:child_process.spawn`.
   * Tests substitute a fake that emits canned stdout / exit codes.
   */
  spawnImpl?: typeof spawn;
}

/** Default curl timeout in seconds when `timeoutSeconds` is omitted. */
const DEFAULT_TIMEOUT_SECONDS = 2;

/**
 * Probes an `http://` or `https://` URL with `curl -sI --max-time <s>`.
 *
 * Classifies the response:
 *   - `curl` exited 0 AND parsed status 200–399 → `reachable: true`,
 *     `detail: 'ok'`, `statusCode` populated.
 *   - `curl` exited 0 AND parsed status outside 200–399 →
 *     `reachable: false`, `detail: 'non-2xx3xx'`, `statusCode` populated.
 *   - `curl` exited non-zero → `reachable: false`, `detail: 'curl-error'`,
 *     no `statusCode`.
 *   - Wall-clock timer fires before curl exits → `reachable: false`,
 *     `detail: 'timeout'`, no `statusCode`. The child is SIGKILLed.
 *
 * @param url - Fully-qualified `http(s)://` URL. Passed as a separate
 *   argv entry so no shell interpolation occurs.
 * @param opts - Optional timeout override and spawn seam.
 * @returns The classified probe outcome.
 */
export async function probeHttp(
  url: string,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const spawnFn = opts.spawnImpl ?? spawn;

  const child: ChildProcess = spawnFn(
    'curl',
    ['-sI', '--max-time', String(timeoutSeconds), url],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const stdoutChunks: string[] = [];
  if (child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => stdoutChunks.push(chunk));
  }
  // Drain stderr so the child does not block on a full pipe buffer.
  if (child.stderr) {
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', () => {
      /* discard — curl -sI only writes headers to stdout */
    });
  }

  return await raceExitOrTimeout(child, stdoutChunks, timeoutSeconds);
}

/**
 * Races the child's `exit` event against a wall-clock timer that
 * escalates to SIGKILL if `curl` hangs past its own `--max-time`.
 *
 * @param child - The spawned curl process.
 * @param stdoutChunks - Live buffer of stdout text (mutated by the
 *   `data` listener registered by the caller).
 * @param timeoutSeconds - Same value passed to `curl --max-time`; used
 *   to derive the wall-clock deadline.
 */
function raceExitOrTimeout(
  child: ChildProcess,
  stdoutChunks: string[],
  timeoutSeconds: number
): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const wallClockMs = (timeoutSeconds + 1) * 1000;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* child already gone */
      }
      resolveProbe({ reachable: false, detail: 'timeout' });
    }, wallClockMs);
    timer.unref();

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(classifyCurlExit(code, stdoutChunks.join('')));
    });

    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ reachable: false, detail: 'curl-error' });
    });
  });
}

/**
 * Classifies a completed curl invocation into a {@link ProbeResult}.
 *
 * @param exitCode - Numeric exit code (null treated as non-zero).
 * @param stdout - Combined stdout captured during the run.
 */
function classifyCurlExit(
  exitCode: number | null,
  stdout: string
): ProbeResult {
  if (exitCode !== 0) {
    return { reachable: false, detail: 'curl-error' };
  }
  const status = parseHttpStatus(stdout);
  if (status === null) {
    return { reachable: false, detail: 'curl-error' };
  }
  const reachable = status >= 200 && status < 400;
  return {
    reachable,
    statusCode: status,
    detail: reachable ? 'ok' : 'non-2xx3xx',
  };
}

/**
 * Extracts the numeric HTTP status code from a `curl -sI` stdout blob.
 *
 * curl prints the response head — the first line is of the form
 * `HTTP/<version> <code> <reason>`. Proxies and 1xx informational
 * responses may emit multiple status lines separated by a blank line;
 * this helper returns the FIRST status it sees, which matches the
 * initial response `-sI` surfaces.
 *
 * @param stdout - Captured stdout content (may be empty).
 * @returns The integer status, or `null` when no status line was found.
 */
function parseHttpStatus(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = /^HTTP\/[\d.]+\s+(\d{3})\b/.exec(line);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}
