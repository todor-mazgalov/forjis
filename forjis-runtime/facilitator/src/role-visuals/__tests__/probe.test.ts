/**
 * Unit tests for `probeHttp` in role-visuals/probe.ts.
 *
 * All tests stub the `spawnImpl` seam with a fake ChildProcess so no
 * real `curl` binary is invoked and no network traffic occurs.
 * `jest.useFakeTimers()` drives the wall-clock timeout path.
 */

import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

import { probeHttp } from '../probe.js';

// --------------------------------------------------------------------------
// Fake ChildProcess harness
// --------------------------------------------------------------------------

/** Shape returned by `makeFakeChild` — a partial ChildProcess with test hooks. */
interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: jest.Mock;
  emitStdoutAndExit: (text: string, code: number) => void;
  emitExit: (code: number) => void;
  emitError: (err: Error) => void;
}

/** Builds a fake ChildProcess with piped stdout/stderr streams. */
function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new Readable({ read() { /* no-op */ } });
  ee.stderr = new Readable({ read() { /* no-op */ } });
  ee.kill = jest.fn();
  ee.emitStdoutAndExit = (text, code) => {
    ee.stdout.push(text);
    ee.stdout.push(null);
    process.nextTick(() => ee.emit('exit', code));
  };
  ee.emitExit = (code) => {
    ee.stdout.push(null);
    process.nextTick(() => ee.emit('exit', code));
  };
  ee.emitError = (err) => {
    process.nextTick(() => ee.emit('error', err));
  };
  return ee;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('probeHttp', () => {
  it('returns reachable:true and statusCode 200 on HTTP/1.1 200 OK', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const probe = probeHttp('http://localhost:5173', { spawnImpl });
    child.emitStdoutAndExit('HTTP/1.1 200 OK\r\n\r\n', 0);
    const result = await probe;
    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.detail).toBe('ok');
  });

  it('returns reachable:true on 3xx redirect', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const probe = probeHttp('http://localhost:5173', { spawnImpl });
    child.emitStdoutAndExit('HTTP/1.1 302 Found\r\n\r\n', 0);
    const result = await probe;
    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(302);
  });

  it('returns reachable:false on 500 response', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const probe = probeHttp('http://localhost:5173', { spawnImpl });
    child.emitStdoutAndExit('HTTP/1.1 500 Internal Server Error\r\n\r\n', 0);
    const result = await probe;
    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.detail).toBe('non-2xx3xx');
  });

  it('returns curl-error on non-zero exit', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const probe = probeHttp('http://localhost:5173', { spawnImpl });
    child.emitExit(6);
    const result = await probe;
    expect(result.reachable).toBe(false);
    expect(result.detail).toBe('curl-error');
    expect(result.statusCode).toBeUndefined();
  });

  it('returns timeout when curl never emits exit', async () => {
    jest.useFakeTimers();
    try {
      const child = makeFakeChild();
      const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
      const probePromise = probeHttp('http://localhost:5173', {
        spawnImpl,
        timeoutSeconds: 2,
      });
      // Advance past (2 + 1) * 1000 ms wall-clock budget.
      jest.advanceTimersByTime(3_500);
      const result = await probePromise;
      expect(result.reachable).toBe(false);
      expect(result.detail).toBe('timeout');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns curl-error when child emits an error event', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const probe = probeHttp('http://localhost:5173', { spawnImpl });
    child.emitError(new Error('ENOENT: curl not found'));
    const result = await probe;
    expect(result.reachable).toBe(false);
    expect(result.detail).toBe('curl-error');
  });
});
