/**
 * Unit tests for the tunnel launcher used by `forjis dev --tunnel`.
 *
 * Focuses on the FR-005 branch that the integration test in
 * {@link ./dev.test.ts} does not cover — the missing-tool error path —
 * plus the happy-path probe/spawn sequence for cloudflared.
 *
 * The tests mock `node:child_process` to avoid spawning real binaries or
 * touching the host's PATH, matching the ESM mocking pattern used in
 * {@link ./version.test.ts} and {@link ./task-create-review.test.ts}.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';

/** Minimal stub exposing the subset of ChildProcess behaviour the launcher relies on. */
interface StubChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: jest.Mock;
}

/**
 * Construct a mocked child-process stub with piped stdout/stderr streams
 * and a stub `kill` function.
 *
 * @returns A newly-minted stub child.
 */
function makeChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = jest.fn();
  return emitter;
}

describe('tunnel-launcher', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('throws TunnelToolMissingError when neither cloudflared nor ngrok is on PATH', async () => {
    await jest.isolateModulesAsync(async () => {
      const spawnMock = jest.fn((cmd: string, _args: string[]) => {
        // Both `which cloudflared` and `which ngrok` exit non-zero → not found.
        const probe = makeChild();
        setImmediate(() => {
          probe.exitCode = 1;
          probe.emit('close', 1);
        });
        return probe;
      });

      jest.unstable_mockModule('node:child_process', () => ({
        spawn: spawnMock,
      }));

      const { launchTunnel } = await import('../tunnel-launcher.js');
      const { TunnelToolMissingError } = await import('../../errors.js');

      await expect(
        launchTunnel({ host: '127.0.0.1', port: 4242, logger: () => {} }),
      ).rejects.toBeInstanceOf(TunnelToolMissingError);

      // Both tools were probed in order.
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const firstCall = spawnMock.mock.calls[0];
      const secondCall = spawnMock.mock.calls[1];
      expect(firstCall[1]).toEqual(['cloudflared']);
      expect(secondCall[1]).toEqual(['ngrok']);
    });
  });

  it('spawns cloudflared with the expected argv and captures its public URL', async () => {
    await jest.isolateModulesAsync(async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

      const spawnMock = jest.fn((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });

        // First invocation is the probe for cloudflared — return a child
        // that closes with code 0 (found on PATH).
        if (args.length === 1 && args[0] === 'cloudflared') {
          const probe = makeChild();
          setImmediate(() => {
            probe.exitCode = 0;
            probe.emit('close', 0);
          });
          return probe;
        }

        // Second invocation is the real spawn of cloudflared itself.
        const child = makeChild();
        setImmediate(() => {
          child.stderr.write(
            'some preamble\nhttps://example-tunnel.trycloudflare.com is ready\n',
          );
        });
        return child;
      });

      jest.unstable_mockModule('node:child_process', () => ({
        spawn: spawnMock,
      }));

      const { launchTunnel } = await import('../tunnel-launcher.js');

      const logs: string[] = [];
      const tunnel = await launchTunnel({
        host: '127.0.0.1',
        port: 4242,
        logger: (line) => logs.push(line),
      });

      expect(tunnel.tool).toBe('cloudflared');
      expect(tunnel.publicUrl).toBe('https://example-tunnel.trycloudflare.com');

      // Verify the spawn argv — only the probe plus the real cloudflared call.
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[1].cmd).toBe('cloudflared');
      expect(spawnCalls[1].args).toEqual([
        'tunnel',
        '--url',
        'http://127.0.0.1:4242',
      ]);

      // The `using cloudflared` banner and the subprocess output lines made
      // it to the logger without the token ever appearing.
      expect(logs.some((l) => l === 'using cloudflared')).toBe(true);
      expect(logs.some((l) => l.includes('trycloudflare.com'))).toBe(true);
    });
  });

  it('skips cloudflared when absent and falls back to ngrok', async () => {
    await jest.isolateModulesAsync(async () => {
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

      const spawnMock = jest.fn((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });

        // Cloudflared probe → not found.
        if (args.length === 1 && args[0] === 'cloudflared') {
          const probe = makeChild();
          setImmediate(() => {
            probe.exitCode = 1;
            probe.emit('close', 1);
          });
          return probe;
        }

        // Ngrok probe → found.
        if (args.length === 1 && args[0] === 'ngrok') {
          const probe = makeChild();
          setImmediate(() => {
            probe.exitCode = 0;
            probe.emit('close', 0);
          });
          return probe;
        }

        // Real ngrok spawn — write a JSON log record with the public URL.
        const child = makeChild();
        setImmediate(() => {
          child.stdout.write(
            '{"msg":"started tunnel","url":"https://abc123.ngrok-free.app"}\n',
          );
        });
        return child;
      });

      jest.unstable_mockModule('node:child_process', () => ({
        spawn: spawnMock,
      }));

      const { launchTunnel } = await import('../tunnel-launcher.js');

      const tunnel = await launchTunnel({
        host: '127.0.0.1',
        port: 4242,
        logger: () => {},
      });

      expect(tunnel.tool).toBe('ngrok');
      expect(tunnel.publicUrl).toBe('https://abc123.ngrok-free.app');

      // Probe-probe-spawn sequence.
      expect(spawnCalls.length).toBe(3);
      expect(spawnCalls[0].args).toEqual(['cloudflared']);
      expect(spawnCalls[1].args).toEqual(['ngrok']);
      expect(spawnCalls[2].cmd).toBe('ngrok');
      expect(spawnCalls[2].args).toEqual([
        'http',
        '4242',
        '--log=stdout',
        '--log-format=json',
      ]);
    });
  });
});
