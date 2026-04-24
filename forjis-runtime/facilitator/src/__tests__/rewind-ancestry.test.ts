/**
 * Unit tests for `checkAncestry` in `rewind/ancestry.ts`.
 *
 * Covers FR-013 (ancestry pass/fail/disjoint/chain-order) and AS-010
 * (missing exploration file tolerated). Uses stubbed gitExec.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { checkAncestry } from '../rewind/ancestry.js';
import type { GitExec, GitExecResult } from '../rewind/git-exec.js';

/** Creates an isolated tmp project root. */
async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-rewind-ancestry-'));
}

/** Seeds `.forjis/exploration/<id>.md` with the given files_touched paths. */
async function seedExploration(
  root: string,
  id: string,
  paths: string[],
): Promise<void> {
  const dir = join(root, '.forjis', 'exploration');
  await mkdir(dir, { recursive: true });
  const touched = paths
    .map((p) => `  - path: ${p}\n    oid: aaaa${p.length}`)
    .join('\n');
  const fm = [
    '---',
    'status: valid',
    `taskId: ${id}`,
    'createdAt: 2024-01-01T00:00:00Z',
    'taskSummary: test',
    'files_touched:',
    touched,
    '---',
    '',
    'body',
  ].join('\n');
  await writeFile(join(dir, `${id}.md`), fm, 'utf-8');
}

/** Builds a gitExec stub with handler list. */
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

describe('checkAncestry', () => {
  let root: string;

  beforeEach(async () => {
    root = await tempRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes when there are no intervening merges', async () => {
    await seedExploration(root, 'a', ['src/a.ts']);
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: { stdout: '', stderr: '', exitCode: 0 },
      },
    ]);
    const result = await checkAncestry(root, 'a', 'shaA', 'forjis/stage', {
      gitExec: git as unknown as GitExec,
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when an intervening merge overlaps files_touched', async () => {
    await seedExploration(root, 'a', ['src/a.ts']);
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: {
          stdout: 'shaB Merge forjis/b into forjis/stage\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'show' && a.includes('shaB'),
        result: { stdout: 'src/a.ts\n', stderr: '', exitCode: 0 },
      },
    ]);
    const result = await checkAncestry(root, 'a', 'shaA', 'forjis/stage', {
      gitExec: git as unknown as GitExec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.chain).toEqual(['b']);
  });

  it('passes when intervening merges are all disjoint', async () => {
    await seedExploration(root, 'a', ['src/a.ts']);
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: {
          stdout: 'shaB Merge forjis/b into forjis/stage\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'show' && a.includes('shaB'),
        result: { stdout: 'src/other.ts\n', stderr: '', exitCode: 0 },
      },
    ]);
    const result = await checkAncestry(root, 'a', 'shaA', 'forjis/stage', {
      gitExec: git as unknown as GitExec,
    });
    expect(result).toEqual({ ok: true });
  });

  it('orders chain reverse-chronologically (most recent first)', async () => {
    await seedExploration(root, 'a', ['src/a.ts']);
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: {
          // git log output is reverse-chronological — C first (newest), then B.
          stdout: [
            'shaC Merge forjis/c into forjis/stage',
            'shaB Merge forjis/b into forjis/stage',
          ].join('\n') + '\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'show' && a.includes('shaC'),
        result: { stdout: 'src/a.ts\n', stderr: '', exitCode: 0 },
      },
      {
        match: (a) => a[0] === 'show' && a.includes('shaB'),
        result: { stdout: 'src/a.ts\n', stderr: '', exitCode: 0 },
      },
    ]);
    const result = await checkAncestry(root, 'a', 'shaA', 'forjis/stage', {
      gitExec: git as unknown as GitExec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.chain).toEqual(['c', 'b']);
  });

  it('tolerates missing exploration file (empty set → pass)', async () => {
    // No exploration seeded.
    const git = makeGitStub([]);
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await checkAncestry(root, 'a', 'shaA', 'forjis/stage', {
      gitExec: git as unknown as GitExec,
    });
    expect(result).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips prefix-collision intervening merges (id boundary enforced)', async () => {
    await seedExploration(root, 'a', ['src/a.ts']);
    const git = makeGitStub([
      {
        match: (a) => a[0] === 'log',
        result: {
          // Sibling id `a-follow-up` mentions "forjis/a" as substring
          // but the regex anchors on word boundary (post-id space).
          stdout: 'shaA2 Merge forjis/a-follow-up into forjis/stage\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: (a) => a[0] === 'show',
        result: { stdout: 'src/a.ts\n', stderr: '', exitCode: 0 },
      },
    ]);
    const result = await checkAncestry(root, 'a', 'shaA', 'forjis/stage', {
      gitExec: git as unknown as GitExec,
    });
    // The check overlaps — chain should have the follow-up id, not collide.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.chain).toEqual(['a-follow-up']);
  });
});
