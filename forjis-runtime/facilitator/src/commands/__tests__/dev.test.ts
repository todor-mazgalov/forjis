/**
 * Integration tests for the `forjis dev` command.
 *
 * Exercises the end-to-end boot path: resolve a minimal `build.forjis`,
 * boot the inspector HTTP + WebSocket server, spawn a trivial dev-server
 * subprocess, print a session URL + QR code, and verify that:
 *
 *   1. The printed inspector URL matches the expected shape.
 *   2. The WebSocket endpoint rejects upgrades without a token.
 *   3. The WebSocket endpoint accepts upgrades with the printed token.
 *   4. Sending `SIGINT` tears everything down within 6 seconds.
 *
 * The test runs `devCommand` in-process with the `FORJIS_DEV_SKIP_EXIT`
 * environment flag set so the shutdown sequence resolves the returned
 * promise instead of calling `process.exit`.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { jest } from '@jest/globals';

import { devCommand } from '../dev.js';

jest.setTimeout(30_000);

/**
 * Picks a free ephemeral TCP port by opening a server on port 0 and
 * reading back the assigned port before closing.
 *
 * @returns A promise resolving with a free port number.
 */
function pickEphemeralPort(): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        server.close(() => resolvePromise(port));
      } else {
        rejectPromise(new Error('could not determine ephemeral port'));
      }
    });
  });
}

/**
 * Set up a minimal project directory with a valid `build.forjis` and
 * an empty `resources/` tree so `resolve()` succeeds without touching
 * the network.
 *
 * @param projectDir - Absolute path to the scratch project directory.
 * @param devCommandLine - Shell command recorded on the `dev.command` field.
 * @returns Absolute path to the build file.
 */
async function setupProject(
  projectDir: string,
  devCommandLine: string,
): Promise<string> {
  const resourcesDir = join(projectDir, 'resources');
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(
    join(resourcesDir, 'manifest.yaml'),
    [
      'name: test-repo',
      'version: 1.0.0',
      'agents: []',
      'skills: []',
      'hooks: []',
      'plugins: []',
    ].join('\n'),
  );
  const buildPath = join(projectDir, 'build.forjis');
  await writeFile(
    buildPath,
    [
      'version: 1',
      'repositories:',
      '  - type: dir',
      `    path: ${resourcesDir}`,
      'dev:',
      `  command: ${JSON.stringify(devCommandLine)}`,
    ].join('\n'),
  );
  return buildPath;
}

/**
 * Wait for a predicate to hold, polling every 50 ms up to `timeoutMs`.
 *
 * @param check - Predicate function; truthy return resolves the promise.
 * @param timeoutMs - Maximum time to wait before throwing.
 */
async function waitFor(
  check: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

/** Regex used to extract the inspector session URL from captured stdout. */
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/inspector\?t=[A-Za-z0-9_-]+/;

describe('devCommand — integration', () => {
  let tmpDir: string;
  let port: number;
  let originalExit: boolean;
  const logLines: string[] = [];
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'forjis-dev-test-'));
    port = await pickEphemeralPort();
    originalExit = process.env.FORJIS_DEV_SKIP_EXIT === '1';
    process.env.FORJIS_DEV_SKIP_EXIT = '1';
    logLines.length = 0;
    consoleLogSpy = jest
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    if (!originalExit) {
      delete process.env.FORJIS_DEV_SKIP_EXIT;
    }
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('prints URL, gates WS on the token, and shuts down on SIGINT', async () => {
    const buildPath = await setupProject(
      tmpDir,
      'node -e "setInterval(()=>{}, 1000)"',
    );

    const cmdPromise = devCommand(tmpDir, buildPath, {
      port,
      host: '127.0.0.1',
    });

    await waitFor(() => logLines.some((l) => URL_PATTERN.test(l)), 15_000);

    const urlLine = logLines.find((l) => URL_PATTERN.test(l));
    if (urlLine === undefined) throw new Error('no URL line captured');
    const urlMatch = urlLine.match(URL_PATTERN);
    if (urlMatch === null) throw new Error('URL regex failed');
    const sessionUrl = urlMatch[0];
    const token = sessionUrl.split('?t=')[1];

    // 1. WS without token is refused before handshake completes.
    await expect(connectWs(port)).rejects.toBeDefined();

    // 2. WS with the printed token completes the upgrade.
    await expect(connectWs(port, token)).resolves.toBeDefined();

    // 3. SIGINT triggers the shutdown sequence.
    process.emit('SIGINT');

    await Promise.race([
      cmdPromise,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error('shutdown timed out')), 6_000),
      ),
    ]);
  });
});

/**
 * Connect to the inspector WebSocket endpoint on `127.0.0.1:port`.
 *
 * @param port - TCP port the server is listening on.
 * @param token - Optional session token appended as `?t=<token>`.
 * @returns A promise resolving when the socket opens, rejecting on close.
 */
function connectWs(port: number, token?: string): Promise<WebSocket> {
  const url =
    token !== undefined
      ? `ws://127.0.0.1:${port}/inspector/ws?t=${token}`
      : `ws://127.0.0.1:${port}/inspector/ws`;
  return new Promise<WebSocket>((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url);
    const cleanup = (): void => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('close');
      ws.removeAllListeners('unexpected-response');
    };
    ws.once('open', () => {
      cleanup();
      ws.close();
      resolvePromise(ws);
    });
    ws.once('error', (err) => {
      cleanup();
      rejectPromise(err);
    });
    ws.once('unexpected-response', (_req, res) => {
      cleanup();
      rejectPromise(new Error(`HTTP ${res.statusCode}`));
    });
    ws.once('close', () => {
      cleanup();
      rejectPromise(new Error('closed before open'));
    });
  });
}
