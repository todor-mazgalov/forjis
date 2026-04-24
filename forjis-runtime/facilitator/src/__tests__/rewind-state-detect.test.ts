/**
 * Unit tests for the rewind state classifier (`detectState`) and the
 * merge-sha recovery walker (`findMergeSha`).
 *
 * Covers FR-004 (seven classification outcomes), FR-014 (prefix
 * collision + second-parent verification), and AS-007 (main-merged
 * predicate). Uses `mkdtemp` fixtures for the filesystem side and a
 * canned `gitExec` stub for git.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { detectState, findMergeSha } from '../rewind/state-detect.js';
import type { GitExec, GitExecResult } from '../rewind/git-exec.js';

/** Builds a unique temp project root. */
async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-rewind-state-'));
}

/** Writes `.forjis/tasks/<id>/state.yaml` with the given status. */
async function seedState(root: string, id: string, status: string): Promise<void> {
  const dir = join(root, '.forjis', 'tasks', id);
  await mkdir(dir, { recursive: true });
  const body = `id: ${id}\nstatus: ${status}\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`;
  await writeFile(join(dir, 'state.yaml'), body, 'utf-8');
}

/** Writes `.forjis/tasks/<id>/pid` with a numeric pid. */
async function seedPid(root: string, id: string, pid: number): Promise<void> {
  const dir = join(root, '.forjis', 'tasks', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pid'), String(pid), 'utf-8');
}

/** Git exec stub: matches args -> canned result, else exit 1. */
function makeGitStub(
  handlers: Array<{
    match: (args: string[]) => boolean;
    result: GitExecResult;
  }>,
): jest.Mock<(args: string[], cwd: string) => Promise<GitExecResult>> {
  return jest.fn(async (args: string[]) => {
    for (const h of handlers) {
      if (h.match(args)) return h.result;
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  }) as unknown as jest.Mock<(args: string[], cwd: string) => Promise<GitExecResult>>;
}

describe('detectState', () => {
  let root: string;

  beforeEach(async () => {
    root = await tempRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns not-found when the task dir is absent', async () => {
    const git = makeGitStub([]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('not-found');
  });

  it('returns queued for status=queued', async () => {
    await seedState(root, 'abc', 'queued');
    const git = makeGitStub([]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('queued');
  });

  it('returns running for status=running with live pid file', async () => {
    await seedState(root, 'abc', 'running');
    await seedPid(root, 'abc', process.pid);
    const git = makeGitStub([]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('running');
    if (state.kind === 'running') expect(state.pid).toBe(process.pid);
  });

  it('returns running for status=running with stale pid (pure classifier)', async () => {
    await seedState(root, 'abc', 'running');
    await seedPid(root, 'abc', 999999);
    const git = makeGitStub([]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    // Classifier is pure-read — still reports running with the stored pid.
    expect(state.kind).toBe('running');
  });

  it('returns failed for status=failed', async () => {
    await seedState(root, 'abc', 'failed');
    const git = makeGitStub([]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('failed');
  });

  it('returns done-unmerged when no merge commit matches', async () => {
    await seedState(root, 'abc', 'done');
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: { stdout: '', stderr: '', exitCode: 0 },
      },
    ]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('done-unmerged');
  });

  it('returns done-merged-stage when branch --contains omits main', async () => {
    await seedState(root, 'abc', 'done');
    const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log' && a.includes('forjis/stage'),
        result: {
          stdout: `${sha} p1 p2 Merge forjis/abc into forjis/stage\n`,
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'merge-base',
        result: { stdout: '', stderr: '', exitCode: 0 },
      },
      {
        match: (a) => a[0] === 'branch' && a[1] === '--contains',
        result: { stdout: 'forjis/stage\n', stderr: '', exitCode: 0 },
      },
    ]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('done-merged-stage');
    if (state.kind === 'done-merged-stage') expect(state.mergeSha).toBe(sha);
  });

  it('returns done-merged-main when branch --contains lists main', async () => {
    await seedState(root, 'abc', 'done');
    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log' && a.includes('forjis/stage'),
        result: {
          stdout: `${sha} p1 p2 Merge forjis/abc into forjis/stage\n`,
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'merge-base',
        result: { stdout: '', stderr: '', exitCode: 0 },
      },
      {
        match: (a) => a[0] === 'branch' && a[1] === '--contains',
        result: { stdout: '* main\n  forjis/stage\n', stderr: '', exitCode: 0 },
      },
    ]);
    const state = await detectState(root, 'abc', { gitExec: git as unknown as GitExec });
    expect(state.kind).toBe('done-merged-main');
  });
});

describe('findMergeSha — prefix collision', () => {
  it('selects the exact id match and rejects prefix-collision siblings', async () => {
    const sha1 = '1111111111111111111111111111111111111111';
    const sha10 = '1010101010101010101010101010101010101010';
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: {
          // Two subject lines — inspector-010 first, inspector-01 second.
          stdout: [
            `${sha10} p1 p2 Merge forjis/inspector-010 into forjis/stage`,
            `${sha1} p1 p2 Merge forjis/inspector-01 into forjis/stage`,
          ].join('\n') + '\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'merge-base' && a.includes('forjis/inspector-01'),
        result: { stdout: '', stderr: '', exitCode: 0 },
      },
    ]);
    const resolved = await findMergeSha(
      git as unknown as GitExec,
      'inspector-01',
      'forjis/stage',
      '/tmp/any',
    );
    expect(resolved).toBe(sha1);
  });

  it('rejects a candidate when merge-base verification fails', async () => {
    const sha = 'ffffffffffffffffffffffffffffffffffffffff';
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: {
          stdout: `${sha} p1 p2 Merge forjis/abc into forjis/stage\n`,
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'merge-base',
        result: { stdout: '', stderr: '', exitCode: 1 },
      },
    ]);
    const resolved = await findMergeSha(
      git as unknown as GitExec,
      'abc',
      'forjis/stage',
      '/tmp/any',
    );
    expect(resolved).toBeNull();
  });
});
