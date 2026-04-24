/**
 * Reviewer-owned tests for the rewind submodule.
 *
 * Bolsters the Developer's coverage on FR/NFR/AS items that were
 * implemented but not exercised end-to-end: task-id validation
 * (security-check hook), idempotent failed-state flow, inspector
 * staging cleanup (FR-020 / AS-003), dry-run rendering on refusal
 * states (FR-021), prompt content (FR-028), four-extension probing
 * (FR-027 / AS-006), queued-state plan (FR-006), revert-failure
 * short-circuit (FR-023), and git-exec spawn-safety (FR-022 / NFR-005
 * via spawn-with-args seam).
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { execute, plan } from '../rewind/index.js';
import type { RewindPlan } from '../rewind/index.js';
import type { GitExec, GitExecResult } from '../rewind/git-exec.js';
import { gitExec as realGitExec } from '../rewind/git-exec.js';
import { assertValidTaskId } from '../task-id.js';
import {
  confirmMainRewind,
  deleteBranch,
  purgeTaskFile,
  revertMerge,
  rmStateDir,
  isDirtyOutsideFilesTouched,
} from '../rewind/ops.js';

/** Guard — skip suites that need the git binary. */
function hasGit(): boolean {
  try {
    const result = spawnSync('git', ['--version']);
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Runs git synchronously for fixture setup. */
function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'rewind-review',
      GIT_AUTHOR_EMAIL: 'review@example.com',
      GIT_COMMITTER_NAME: 'rewind-review',
      GIT_COMMITTER_EMAIL: 'review@example.com',
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/** Seeds a canonical failed-state fixture: branch exists, nothing merged. */
async function makeFailedFixture(
  id: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-'));
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'README.md'), 'initial\n');
  await writeFile(
    join(root, '.gitignore'),
    '.forjis/\nopenspec/\ntasks/\n',
    'utf-8',
  );
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-m', 'initial']);
  runGit(root, ['checkout', '-b', 'forjis/stage']);
  runGit(root, ['checkout', '-b', `forjis/${id}`]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'failed-run\n');
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-m', `feat(${id}): failed attempt`]);
  runGit(root, ['checkout', 'forjis/stage']);

  const stateDir = join(root, '.forjis', 'tasks', id);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'state.yaml'),
    `id: ${id}\nstatus: failed\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`,
    'utf-8',
  );

  const expDir = join(root, '.forjis', 'exploration');
  await mkdir(expDir, { recursive: true });
  const exploration = [
    '---',
    'status: valid',
    `taskId: ${id}`,
    'createdAt: 2024-01-01T00:00:00Z',
    'taskSummary: review test',
    'files_touched:',
    '  - path: src/a.ts',
    '    oid: abc123',
    '---',
    '',
    'body',
  ].join('\n');
  await writeFile(join(expDir, `${id}.md`), exploration, 'utf-8');

  await mkdir(join(root, 'openspec', 'changes', id), { recursive: true });
  await writeFile(
    join(root, 'openspec', 'changes', id, 'proposal.md'),
    'stub\n',
    'utf-8',
  );

  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Seeds a queued-state fixture — state dir only, no git history. */
async function makeQueuedFixture(
  id: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-queued-'));
  const stateDir = join(root, '.forjis', 'tasks', id);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'state.yaml'),
    `id: ${id}\nstatus: queued\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`,
    'utf-8',
  );
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('rewind — security hook: taskId validation (shell-injection safety)', () => {
  it('rejects a crafted id with shell metacharacters', () => {
    expect(() => assertValidTaskId('abc; rm -rf /', 'rewind')).toThrow(
      /Invalid task ID/,
    );
    expect(() => assertValidTaskId('`whoami`', 'rewind')).toThrow(
      /Invalid task ID/,
    );
    expect(() => assertValidTaskId('$(id)', 'rewind')).toThrow(
      /Invalid task ID/,
    );
    expect(() => assertValidTaskId('../etc/passwd', 'rewind')).toThrow(
      /Invalid task ID/,
    );
    expect(() => assertValidTaskId('', 'rewind')).toThrow(/Invalid task ID/);
  });

  it('accepts well-formed ids with hyphens and underscores', () => {
    expect(() => assertValidTaskId('task-x', 'rewind')).not.toThrow();
    expect(() => assertValidTaskId('inspector_01', 'rewind')).not.toThrow();
    expect(() => assertValidTaskId('a1B2c3', 'rewind')).not.toThrow();
  });
});

describe('rewind — git-exec wrapper spawn safety (no shell)', () => {
  it('spawn never runs via shell — raw arg array is passed through', async () => {
    // The seam has `spawn('git', args, { cwd })` — no `shell: true`, no
    // string concatenation. A malicious-looking arg is treated as a
    // git-flag literal (git will reject it, but not execute a shell).
    const res = await realGitExec(
      ['status', '; echo pwned'],
      '/tmp',
    );
    // `git status '; echo pwned'` — git prints a usage error on exit 128
    // but the shell meta did NOT execute (no "pwned" on stdout).
    expect(res.stdout).not.toContain('pwned');
    expect(res.exitCode).not.toBe(0);
  });
});

describe('rewind — queued-state plan (FR-006)', () => {
  it('plan for queued state emits only rm-statedir', async () => {
    const id = 'queued-task';
    const { root, cleanup } = await makeQueuedFixture(id);
    try {
      const p = await plan(root, id, {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p.state.kind).toBe('queued');
      expect(p.refusal).toBeNull();
      expect(p.ops).toHaveLength(1);
      expect(p.ops[0].kind).toBe('rm-statedir');
    } finally {
      await cleanup();
    }
  });

  it('executing a queued-state plan removes the state dir only', async () => {
    const id = 'queued-task-2';
    const { root, cleanup } = await makeQueuedFixture(id);
    try {
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      };
      const p = await plan(root, id, opts);
      const result = await execute(root, p, opts);
      expect(result.exitCode).toBe(0);
      await expect(
        stat(join(root, '.forjis', 'tasks', id)),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

const maybe = hasGit() ? describe : describe.skip;

maybe('rewind — failed-state full flow (FR-009, FR-012, FR-018, FR-022)', () => {
  it('runs branch-delete + rm-openspec + rm-statedir + invalidate-cache — no revert', async () => {
    const id = 'failed-x';
    const { root, cleanup } = await makeFailedFixture(id);
    try {
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      };
      const p = await plan(root, id, opts);
      expect(p.refusal).toBeNull();
      expect(p.state.kind).toBe('failed');
      const kinds = p.ops.map((o) => o.kind);
      expect(kinds).not.toContain('revert');
      expect(kinds).toContain('branch-delete');
      expect(kinds).toContain('rm-openspec');
      expect(kinds).toContain('rm-statedir');
      expect(kinds).toContain('invalidate-cache');

      const result = await execute(root, p, opts);
      expect(result.exitCode).toBe(0);

      // Assert no commit starting with "Revert" exists — FR-009 forbids.
      const log = runGit(root, ['log', '--format=%s']).trim();
      expect(log).not.toMatch(/^Revert "Merge /m);

      // Branch gone, openspec gone, state dir gone.
      expect(runGit(root, ['branch', '--list', `forjis/${id}`]).trim()).toBe('');
      await expect(
        stat(join(root, 'openspec', 'changes', id)),
      ).rejects.toThrow();
      await expect(
        stat(join(root, '.forjis', 'tasks', id)),
      ).rejects.toThrow();

      // Exploration flipped.
      const exp = await readFile(
        join(root, '.forjis', 'exploration', `${id}.md`),
        'utf-8',
      );
      expect(exp).toContain('status: invalid');
      expect(exp).toContain(`invalidatedBy: rewind ${id}`);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('second run on failed-state is idempotent — all nothing-to-do (FR-018)', async () => {
    const id = 'failed-idem';
    const { root, cleanup } = await makeFailedFixture(id);
    try {
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      };
      const p1 = await plan(root, id, opts);
      await execute(root, p1, opts);
      // State dir now absent → second plan classifies as not-found.
      const p2 = await plan(root, id, opts);
      expect(p2.state.kind).toBe('not-found');
      expect(p2.ops).toEqual([]);
      const result2 = await execute(root, p2, opts);
      expect(result2.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60000);
});

maybe('rewind — --keep-branch skips only branch-delete (FR-003)', () => {
  it('failed flow with --keep-branch leaves the branch but removes everything else', async () => {
    const id = 'keepbranch-x';
    const { root, cleanup } = await makeFailedFixture(id);
    try {
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: true,
        purgeTaskFile: false,
      };
      const p = await plan(root, id, opts);
      expect(p.ops.map((o) => o.kind)).not.toContain('branch-delete');
      const result = await execute(root, p, opts);
      expect(result.exitCode).toBe(0);
      // Branch preserved.
      expect(runGit(root, ['branch', '--list', `forjis/${id}`]).trim()).not.toBe(
        '',
      );
      // But state dir and openspec still gone.
      await expect(
        stat(join(root, '.forjis', 'tasks', id)),
      ).rejects.toThrow();
      await expect(
        stat(join(root, 'openspec', 'changes', id)),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  }, 60000);
});

describe('rewind — inspector staging cleanup (FR-020, AS-003)', () => {
  it('removes .forjis/inspector/<batchId>/ when pipeline-state records the id', async () => {
    const id = 'insp-task';
    const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-insp-'));
    try {
      const stateDir = join(root, '.forjis', 'tasks', id);
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'state.yaml'),
        `id: ${id}\nstatus: failed\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`,
        'utf-8',
      );
      await writeFile(
        join(stateDir, 'pipeline-state.yaml'),
        `inspectorBatchId: batch-xyz\n`,
        'utf-8',
      );
      const batchDir = join(root, '.forjis', 'inspector', 'batch-xyz');
      await mkdir(batchDir, { recursive: true });
      await writeFile(join(batchDir, 'manifest.yaml'), 'ok\n', 'utf-8');

      const outcome = await rmStateDir({ projectDir: root, taskId: id });
      expect(outcome.status).toBe('done');
      await expect(stat(batchDir)).rejects.toThrow();
      await expect(stat(stateDir)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('logs the skip message when no batch id is recorded', async () => {
    const id = 'no-batch-id';
    const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-nobatch-'));
    const stateDir = join(root, '.forjis', 'tasks', id);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'state.yaml'),
      `id: ${id}\nstatus: failed\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`,
      'utf-8',
    );
    const logs: string[] = [];
    const spy = jest
      .spyOn(console, 'log')
      .mockImplementation((m: unknown) => {
        logs.push(String(m));
      });
    try {
      await rmStateDir({ projectDir: root, taskId: id });
      expect(logs.some((l) => /inspector-staging: no batch id recorded/.test(l))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rewind — purgeTaskFile extension probing (FR-027, AS-006)', () => {
  it('removes all four extensions when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-ext-'));
    try {
      const id = 'purge-all';
      await mkdir(join(root, 'tasks'), { recursive: true });
      await writeFile(join(root, 'tasks', `${id}.md`), 'md', 'utf-8');
      await writeFile(join(root, 'tasks', `${id}.txt`), 'txt', 'utf-8');
      await writeFile(join(root, 'tasks', `${id}.yaml`), 'yaml', 'utf-8');
      await writeFile(join(root, 'tasks', `${id}.yml`), 'yml', 'utf-8');
      const outcome = await purgeTaskFile({
        projectDir: root,
        candidates: [
          `tasks/${id}.md`,
          `tasks/${id}.txt`,
          `tasks/${id}.yaml`,
          `tasks/${id}.yml`,
        ],
      });
      expect(outcome.status).toBe('done');
      expect(outcome.message).toContain(`tasks/${id}.md`);
      expect(outcome.message).toContain(`tasks/${id}.yml`);
      for (const ext of ['md', 'txt', 'yaml', 'yml']) {
        await expect(
          stat(join(root, 'tasks', `${id}.${ext}`)),
        ).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns nothing-to-do when no candidate exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-no-ext-'));
    try {
      const outcome = await purgeTaskFile({
        projectDir: root,
        candidates: [
          'tasks/absent.md',
          'tasks/absent.txt',
          'tasks/absent.yaml',
          'tasks/absent.yml',
        ],
      });
      expect(outcome.status).toBe('nothing-to-do');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

maybe('rewind — prompt content includes task id + state + ops (FR-028)', () => {
  it('standard prompt built by plan() lists id, branch, and each primitive', async () => {
    const id = 'prompt-content';
    // Build a done-merged-stage fixture inline to get the richest prompt.
    const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-review-prompt-'));
    try {
      runGit(root, ['init', '-b', 'main']);
      runGit(root, ['config', 'commit.gpgsign', 'false']);
      await writeFile(join(root, 'README.md'), 'init\n');
      await writeFile(
        join(root, '.gitignore'),
        '.forjis/\nopenspec/\ntasks/\n',
        'utf-8',
      );
      runGit(root, ['add', '-A']);
      runGit(root, ['commit', '-m', 'initial']);
      runGit(root, ['checkout', '-b', 'forjis/stage']);
      runGit(root, ['checkout', '-b', `forjis/${id}`]);
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'a.ts'), 'x\n');
      runGit(root, ['add', '-A']);
      runGit(root, ['commit', '-m', `feat(${id})`]);
      runGit(root, ['checkout', 'forjis/stage']);
      runGit(root, [
        'merge',
        '--no-ff',
        '-m',
        `Merge forjis/${id} into forjis/stage`,
        `forjis/${id}`,
      ]);
      const stateDir = join(root, '.forjis', 'tasks', id);
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'state.yaml'),
        `id: ${id}\nstatus: done\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`,
        'utf-8',
      );
      const expDir = join(root, '.forjis', 'exploration');
      await mkdir(expDir, { recursive: true });
      await writeFile(
        join(expDir, `${id}.md`),
        [
          '---',
          'status: valid',
          `taskId: ${id}`,
          'createdAt: 2024-01-01T00:00:00Z',
          'taskSummary: test',
          'files_touched:',
          '  - path: src/a.ts',
          '    oid: abc',
          '---',
          '',
          'body',
        ].join('\n'),
        'utf-8',
      );

      const p: RewindPlan = await plan(root, id, {
        dryRun: false,
        yes: false, // ensure plan still builds prompts
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p.prompts.standard).not.toBeNull();
      const s = p.prompts.standard ?? '';
      expect(s).toContain(id);
      expect(s).toContain('forjis/stage');
      expect(s).toMatch(/revert /);
      expect(s).toMatch(/branch-delete forjis\//);
      expect(s).toMatch(/rm-openspec /);
      expect(s).toMatch(/rm-statedir /);
      expect(s).toMatch(/invalidate-cache /);
      expect(s).toMatch(/Continue\? \[y\/N\]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

describe('rewind — REWIND MAIN prompt exactness (FR-016)', () => {
  /**
   * Replaces `process.stdin` with a Readable stream that emits `line`
   * and then ends — allows `readline`-based prompt code to receive our
   * scripted input without spawning a child process.
   */
  async function runWithStdin(line: string, body: () => Promise<boolean>): Promise<boolean> {
    const { Readable } = await import('node:stream');
    const fake = Readable.from([line]) as unknown as NodeJS.ReadStream;
    // readline needs `isTTY = false` to treat the stream as piped stdin.
    Object.defineProperty(fake, 'isTTY', { value: false });
    const origStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    try {
      return await body();
    } finally {
      Object.defineProperty(process, 'stdin', {
        value: origStdin,
        configurable: true,
      });
    }
  }

  it('rejects lowercase "rewind main"', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runWithStdin('rewind main\n', () =>
      confirmMainRewind('prompt'),
    );
    logSpy.mockRestore();
    expect(ok).toBe(false);
  });

  it('accepts exact "REWIND MAIN"', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runWithStdin('REWIND MAIN\n', () =>
      confirmMainRewind('prompt'),
    );
    logSpy.mockRestore();
    expect(ok).toBe(true);
  });

  it('rejects "REWIND MAIN extra" (trailing trim allowed by impl)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runWithStdin('REWIND MAIN extra\n', () =>
      confirmMainRewind('prompt'),
    );
    logSpy.mockRestore();
    expect(ok).toBe(false);
  });
});

describe('rewind — isDirtyOutsideFilesTouched (FR-017 helper)', () => {
  it('returns paths outside the set and omits paths inside', () => {
    const porcelain = [
      ' M src/a.ts',
      '?? unrelated.txt',
      ' M src/b.ts',
    ];
    const filesTouched = new Set(['src/a.ts']);
    const outside = isDirtyOutsideFilesTouched(porcelain, filesTouched);
    expect(outside.sort()).toEqual(['src/b.ts', 'unrelated.txt']);
  });

  it('returns empty list when porcelain is empty', () => {
    expect(isDirtyOutsideFilesTouched([], new Set())).toEqual([]);
  });
});

describe('rewind — revertMerge short-circuits on git-revert failure (FR-023)', () => {
  it('returns status=failed with the documented message on non-zero exit', async () => {
    const mockGit: GitExec = async (args): Promise<GitExecResult> => {
      if (args[0] === 'log' && args[1] === '-1') {
        return {
          stdout: 'Merge forjis/rv into forjis/stage',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'revert') {
        return { stdout: '', stderr: 'CONFLICT', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const outcome = await revertMerge({
      projectDir: '/tmp/any',
      taskId: 'rv',
      mergeSha: 'deadbeef',
      targetBranch: 'forjis/stage',
      filesTouched: new Set(),
      gitExec: mockGit,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('revert failed');
    expect(outcome.message).toContain("git revert --abort");
  });

  it('returns nothing-to-do when HEAD is already the revert commit', async () => {
    const mockGit: GitExec = async (args): Promise<GitExecResult> => {
      if (args[0] === 'log' && args[1] === '-1') {
        return {
          stdout: 'Revert "Merge forjis/rv into forjis/stage"',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const outcome = await revertMerge({
      projectDir: '/tmp/any',
      taskId: 'rv',
      mergeSha: 'deadbeef',
      targetBranch: 'forjis/stage',
      filesTouched: new Set(),
      gitExec: mockGit,
    });
    expect(outcome.status).toBe('nothing-to-do');
    expect(outcome.message).toContain('already reverted');
  });
});

describe('rewind — deleteBranch primitives (FR-009, FR-024)', () => {
  it('returns nothing-to-do for a non-existent branch', async () => {
    const git: GitExec = async (args): Promise<GitExecResult> => {
      if (args[0] === 'branch' && args[1] === '--list') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const outcome = await deleteBranch({
      projectDir: '/tmp/any',
      branchName: 'forjis/absent',
      gitExec: git,
    });
    expect(outcome.status).toBe('nothing-to-do');
    expect(outcome.message).toContain('no such branch');
  });

  it('returns failed when branch -D exits non-zero', async () => {
    const git: GitExec = async (args): Promise<GitExecResult> => {
      if (args[0] === 'branch' && args[1] === '--list') {
        return { stdout: 'forjis/x\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'main', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'branch' && args[1] === '-D') {
        return { stdout: '', stderr: 'error: cannot delete', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const outcome = await deleteBranch({
      projectDir: '/tmp/any',
      branchName: 'forjis/x',
      gitExec: git,
    });
    expect(outcome.status).toBe('failed');
  });
});

describe('rewind — execute dryRun returns empty executed (FR-021)', () => {
  it('execute with dryRun=true performs no ops regardless of plan content', async () => {
    const p: RewindPlan = {
      taskId: 'dry',
      state: { kind: 'failed' },
      ops: [
        { kind: 'rm-openspec', path: 'openspec/changes/dry' },
        { kind: 'rm-statedir', path: '.forjis/tasks/dry' },
      ],
      refusal: null,
      prompts: { standard: null, rewindMain: null },
    };
    const result = await execute('/tmp/any', p, {
      dryRun: true,
      yes: true,
      force: false,
      keepBranch: false,
      purgeTaskFile: false,
    });
    expect(result.executed).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
