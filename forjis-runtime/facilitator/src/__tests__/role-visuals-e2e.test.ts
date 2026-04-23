/**
 * End-to-end regression tests for the role-visuals capability.
 *
 * Exercises the three cross-module invariants the capability ships:
 *
 *   1. Resolver `validateVisuals` rejects malformed entries with an
 *      index-path error identifier (FR-20 hard-fail gate).
 *   2. A role with no `visuals` declaration produces zero role-visuals
 *      side effects — no artefact, no warnings (FR-19).
 *   3. Two roles declaring the same `(location, command)` share one
 *      spawn and trigger SIGTERM exactly once at refcount 0 (FR-11).
 *
 * All tests are offline: the command-runner fakes `spawnImpl` and
 * the resolveRoleVisuals `probeImpl` returns canned responses.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { BuildFileValidationError, parseBuildFile } from '@forjis/resolver';
import {
  __resetForTests,
  acquire,
  drainAll,
  release,
} from '../role-visuals/command-runner.js';
import { resolveRoleVisuals } from '../role-visuals/index.js';
import type { RuntimeRole } from '@forjis/resolver';

// --------------------------------------------------------------------------
// Shared fake ChildProcess harness
// --------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  emitExit: (code: number) => void;
}

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
  return ee;
}

function makeRole(visuals?: RuntimeRole['visuals'], name = 'Developer'): RuntimeRole {
  const role: RuntimeRole = {
    name,
    org: 'acme',
    team: 'eng',
    agent: 'dev-agent',
    skills: [],
    hooks: { pre: [], validation: [], post: [] },
  };
  if (visuals !== undefined) role.visuals = visuals;
  return role;
}

// --------------------------------------------------------------------------
// (1) Resolver — malformed entries fail validate
// --------------------------------------------------------------------------

describe('role-visuals E2E: resolver validate rejects malformed', () => {
  it('surfaces both scheme and tool errors in a single validation pass', () => {
    const yaml = [
      'version: 1',
      'repositories:',
      '  - type: git',
      '    url: https://example.com/r.git',
      '    ref: v1',
      'orgs:',
      '  - name: acme',
      '    roles:',
      '      - name: Developer',
      '        agent: dev-agent',
      '        visuals:',
      '          - location: ftp://legacy.example.com',
      '          - location: http://localhost:5173',
      '            tool: playwright',
    ].join('\n');

    try {
      parseBuildFile(yaml);
      throw new Error('expected validation to fail');
    } catch (err) {
      if (!(err instanceof BuildFileValidationError)) throw err;
      expect(err.errors.some(e => e.includes('visuals[0].location'))).toBe(true);
      expect(err.errors.some(e => e.includes('visuals[1].tool'))).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// (2) Role without visuals — zero side-effects
// --------------------------------------------------------------------------

describe('role-visuals E2E: legacy role is fully unchanged', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-e2e-legacy-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes no artefact and emits no warnings for a role without visuals', async () => {
    const warn = jest.fn();
    const probeImpl = jest.fn();
    const result = await resolveRoleVisuals({
      role: makeRole(),
      taskId: 't1',
      projectDir: tmpDir,
      warn: warn as unknown as (msg: string) => void,
      probeImpl: probeImpl as unknown as typeof import('../role-visuals/probe.js').probeHttp,
    });
    expect(result.artefactPath).toBeNull();
    expect(result.acquiredKeys).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(probeImpl).not.toHaveBeenCalled();

    // The task directory should remain absent of any visuals artefact.
    const taskDir = join(tmpDir, '.forjis', 'tasks', 't1');
    let entries: string[];
    try {
      entries = await readdir(taskDir);
    } catch {
      entries = [];
    }
    expect(entries.find(f => f.startsWith('visuals-'))).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// (3) Shared (location, command) refcount — one spawn, one SIGTERM
// --------------------------------------------------------------------------

describe('role-visuals E2E: shared command refcount', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(async () => {
    // Drain any leaked entries before the next test.
    await drainAll().catch(() => { /* ignore */ });
    __resetForTests();
  });

  it('two roles with identical (location, command) spawn once and SIGTERM once', async () => {
    const child = makeFakeChild();
    const spawnImpl = jest.fn().mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;

    const roleA = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'acme:eng:Alpha',
      onLine: () => {},
      spawnImpl,
    });
    const roleB = acquire({
      location: 'http://localhost:5173',
      command: 'npm run dev',
      projectDir: '/tmp',
      roleLabel: 'acme:eng:Beta',
      onLine: () => {},
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(roleA.key).toBe(roleB.key);

    await release(roleA.key);
    expect(child.kill).not.toHaveBeenCalled();

    const final = release(roleB.key);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.emitExit(0);
    await final;
  });
});
