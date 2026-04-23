/**
 * Unit tests for the refcounted command-runner.
 *
 * All tests stub `spawnImpl` with a fake ChildProcess and drive
 * timers via `jest.useFakeTimers()` so the suite runs offline and
 * deterministically. Covers single acquire/release, SIGKILL
 * escalation, refcount sharing, distinct keys, idempotent release at
 * zero, and `drainAll` after a simulated crash (no matching release).
 */

import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

import {
  __resetForTests,
  acquire,
  drainAll,
  release,
} from '../command-runner.js';

/** Fake ChildProcess surface used by every test in this suite. */
interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  emitExit: (code: number) => void;
  pushStdout: (line: string) => void;
}

/** Constructs a fake ChildProcess suitable for the runner's stdio contract. */
function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new Readable({ read() { /* no-op */ } });
  ee.stderr = new Readable({ read() { /* no-op */ } });
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = jest.fn();
  ee.emitExit = (code) => {
    ee.exitCode = code;
    ee.stdout.push(null);
    ee.stderr.push(null);
    process.nextTick(() => ee.emit('exit', code, null));
  };
  ee.pushStdout = (line) => {
    ee.stdout.push(line);
  };
  return ee;
}

describe('command-runner', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
    jest.useRealTimers();
  });

  it('spawns on first acquire and SIGTERMs on release-to-zero', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;

    const { key } = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'acme:eng:Dev',
      onLine: () => {},
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);

    const releasePromise = release(key);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emitExit(0);
    await releasePromise;
  });

  it('shares one subprocess across two roles (refcount 2)', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;

    const first = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'acme:eng:RoleA',
      onLine: () => {},
      spawnImpl,
    });
    const second = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'acme:eng:RoleB',
      onLine: () => {},
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(first.key).toBe(second.key);

    await release(first.key);
    expect(child.kill).not.toHaveBeenCalled();

    const lastRelease = release(second.key);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emitExit(0);
    await lastRelease;
  });

  it('keeps same location with different command under separate keys', async () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    let call = 0;
    const spawnImpl = jest.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? childA : childB;
    }) as unknown as typeof import('node:child_process').spawn;

    const resultA = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'RoleA',
      onLine: () => {},
      spawnImpl,
    });
    const resultB = acquire({
      location: 'http://localhost:5173',
      command: 'npm run storybook',
      projectDir: '/tmp',
      roleLabel: 'RoleB',
      onLine: () => {},
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(resultA.key).not.toBe(resultB.key);

    const rel1 = release(resultA.key);
    const rel2 = release(resultB.key);
    childA.emitExit(0);
    childB.emitExit(0);
    await rel1;
    await rel2;
  });

  it('release on an unknown key is a no-op', async () => {
    await expect(release('unknown-key')).resolves.toBeUndefined();
  });

  it('prefixes forwarded stdout lines with [visuals:<role>]', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const lines: string[] = [];

    const { key } = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'acme:eng:Developer',
      onLine: (line) => lines.push(line),
      spawnImpl,
    });

    child.pushStdout('dev server ready\n');
    // Allow microtasks/nextTick to flush the line forwarder.
    await new Promise((r) => setImmediate(r));

    expect(lines).toEqual(['[visuals:acme:eng:Developer] dev server ready']);

    const rel = release(key);
    child.emitExit(0);
    await rel;
  });

  it('escalates to SIGKILL after 5 s when SIGTERM is ignored', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;

    const { key } = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'Dev',
      onLine: () => {},
      spawnImpl,
    });

    const rel = release(key);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    jest.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // The runner still awaits the child's exit — simulate it.
    child.emitExit(137);
    await rel;
  });

  it('drainAll terminates every active subprocess without matching releases', async () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    let call = 0;
    const spawnImpl = jest.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? childA : childB;
    }) as unknown as typeof import('node:child_process').spawn;

    acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'RoleA',
      onLine: () => {},
      spawnImpl,
    });
    acquire({
      location: 'http://localhost:6006',
      command: 'npm run storybook',
      projectDir: '/tmp',
      roleLabel: 'RoleB',
      onLine: () => {},
      spawnImpl,
    });

    const drain = drainAll();
    expect(childA.kill).toHaveBeenCalledWith('SIGTERM');
    expect(childB.kill).toHaveBeenCalledWith('SIGTERM');
    childA.emitExit(0);
    childB.emitExit(0);
    await drain;
  });
});
