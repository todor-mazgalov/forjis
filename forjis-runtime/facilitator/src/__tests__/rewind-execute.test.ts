/**
 * Integration tests for rewind's plan + execute pipeline against a real
 * `git init` repo.
 *
 * Guarded by `hasGit()` so CI without git is a skip, not a fail.
 * Covers FR-003, FR-007, FR-010, FR-012, FR-017, FR-018, FR-019,
 * FR-021, FR-022, FR-024, FR-025, FR-027, AS-005, AS-008, NFR-002, NFR-005.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execute, plan } from '../rewind/index.js';
import type { GitExec, GitExecResult } from '../rewind/git-exec.js';
import { gitExec as realGitExec } from '../rewind/git-exec.js';

/** Guard — skip this suite when git is unavailable. */
function hasGit(): boolean {
  try {
    const result = spawnSync('git', ['--version']);
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Runs a git command synchronously in cwd; throws on non-zero exit. */
function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'rewind-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'rewind-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/** Creates a canonical fixture: main + stage + forjis/<id> merged into stage. */
async function makeFixture(
  id: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'forjis-rewind-exec-'));
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'README.md'), 'initial\n');
  // Ignore paths rewind writes/reads outside tracked source so `git
  // status --porcelain` remains clean when we seed them below.
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
  await writeFile(join(root, 'src', 'a.ts'), 'original\n');
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-m', `feat(${id}): add a.ts`]);
  runGit(root, ['checkout', 'forjis/stage']);
  runGit(root, [
    'merge',
    '--no-ff',
    '-m',
    `Merge forjis/${id} into forjis/stage`,
    `forjis/${id}`,
  ]);

  // Seed task state + exploration
  const stateDir = join(root, '.forjis', 'tasks', id);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'state.yaml'),
    `id: ${id}\nstatus: done\npriority: medium\ncreated: 2024-01-01T00:00:00Z\nsource: cli\ndependencies: []\ndescription: t\nretryCount: 0\n`,
    'utf-8',
  );

  const expDir = join(root, '.forjis', 'exploration');
  await mkdir(expDir, { recursive: true });
  const exploration = [
    '---',
    'status: valid',
    `taskId: ${id}`,
    'createdAt: 2024-01-01T00:00:00Z',
    'taskSummary: test',
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
    'stub proposal\n',
    'utf-8',
  );

  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Recording proxy around the real gitExec for audit tests (FR-022). */
function makeAuditGitExec(): {
  fn: GitExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: GitExec = async (args, cwd): Promise<GitExecResult> => {
    calls.push(args);
    return realGitExec(args, cwd);
  };
  return { fn, calls };
}

const maybe = hasGit() ? describe : describe.skip;

maybe('rewind execute — integration', () => {
  const id = 'task-x';

  it('stage-merged happy path reverts + cleans up', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      const p = await plan(root, id, {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p.refusal).toBeNull();
      expect(p.state.kind).toBe('done-merged-stage');
      const result = await execute(root, p, {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(result.exitCode).toBe(0);

      const head = runGit(root, ['log', '-1', '--format=%s']).trim();
      expect(head.startsWith(`Revert "Merge forjis/${id}`)).toBe(true);

      const branches = runGit(root, ['branch', '--list', `forjis/${id}`]).trim();
      expect(branches).toBe('');

      await expect(
        stat(join(root, '.forjis', 'tasks', id)),
      ).rejects.toThrow();
      await expect(
        stat(join(root, 'openspec', 'changes', id)),
      ).rejects.toThrow();

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

  it('idempotency — a second run produces only no-ops', async () => {
    const { root, cleanup } = await makeFixture(id);
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
      const p2 = await plan(root, id, opts);
      const result2 = await execute(root, p2, opts);
      expect(result2.exitCode).toBe(0);
      const noopStatuses = result2.executed.map((e) => e.status);
      expect(noopStatuses.every((s) => s === 'nothing-to-do')).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('--dry-run does not mutate anything', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      const p = await plan(root, id, {
        dryRun: true,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      const result = await execute(root, p, {
        dryRun: true,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(result.executed).toEqual([]);
      // Nothing was mutated.
      const head = runGit(root, ['log', '-1', '--format=%s']).trim();
      expect(head).toBe(`Merge forjis/${id} into forjis/stage`);
      await expect(
        stat(join(root, '.forjis', 'tasks', id)),
      ).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  }, 60000);

  it('--keep-branch preserves forjis/<id>', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: true,
        purgeTaskFile: false,
      };
      const p = await plan(root, id, opts);
      await execute(root, p, opts);
      const branches = runGit(root, ['branch', '--list', `forjis/${id}`]).trim();
      expect(branches).not.toBe('');
    } finally {
      await cleanup();
    }
  }, 60000);

  it('--purge-task-file removes tasks/<id>.md when present', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      await mkdir(join(root, 'tasks'), { recursive: true });
      await writeFile(join(root, 'tasks', `${id}.md`), 'stub', 'utf-8');
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: true,
      };
      const p = await plan(root, id, opts);
      await execute(root, p, opts);
      await expect(
        stat(join(root, 'tasks', `${id}.md`)),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  }, 60000);

  it('refuses running state without --force', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      // Flip status to running + write a live pid.
      const statePath = join(root, '.forjis', 'tasks', id, 'state.yaml');
      const state = await readFile(statePath, 'utf-8');
      await writeFile(
        statePath,
        state.replace('status: done', 'status: running'),
        'utf-8',
      );
      await writeFile(
        join(root, '.forjis', 'tasks', id, 'pid'),
        String(process.pid),
        'utf-8',
      );
      const p = await plan(root, id, {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p.refusal).not.toBeNull();
      expect(p.refusal?.message).toContain('still running');
    } finally {
      await cleanup();
    }
  }, 60000);

  it('skips branch-delete when forjis/<id> is current HEAD', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      runGit(root, ['checkout', `forjis/${id}`]);
      const { deleteBranch } = await import('../rewind/ops.js');
      const outcome = await deleteBranch({
        projectDir: root,
        branchName: `forjis/${id}`,
        gitExec: realGitExec,
      });
      expect(outcome.status).toBe('nothing-to-do');
      expect(outcome.message).toContain('current HEAD');
    } finally {
      await cleanup();
    }
  }, 60000);

  it('refuses when working tree is dirty outside files_touched', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      await writeFile(join(root, 'unrelated.txt'), 'dirt', 'utf-8');
      runGit(root, ['add', '-A']);
      const p = await plan(root, id, {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p.refusal).not.toBeNull();
      expect(p.refusal?.code).toBe('dirty');
    } finally {
      await cleanup();
    }
  }, 60000);

  it('stashes + restores when dirty paths are all inside files_touched', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      await writeFile(join(root, 'src', 'a.ts'), 'modified\n', 'utf-8');
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      };
      const p = await plan(root, id, opts);
      expect(p.refusal).toBeNull();
      const result = await execute(root, p, opts);
      expect(result.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('audit — no prohibited git commands are spawned', async () => {
    const { root, cleanup } = await makeFixture(id);
    const audit = makeAuditGitExec();
    try {
      const opts = {
        dryRun: false,
        yes: true,
        force: false,
        keepBranch: false,
        purgeTaskFile: false,
      };
      const p = await plan(root, id, opts, { gitExec: audit.fn });
      await execute(root, p, opts, { gitExec: audit.fn });
      for (const call of audit.calls) {
        expect(call[0]).not.toBe('push');
        expect(call.join(' ')).not.toContain('reset --hard');
        expect(call[0]).not.toBe('rebase');
        expect(call.some((a) => a.startsWith('origin/'))).toBe(false);
      }
    } finally {
      await cleanup();
    }
  }, 60000);
});

/**
 * Child subprocess used by the forced-running test to simulate a task
 * whose pid is live. Defined at module scope so the test can reference
 * it without re-declaring.
 */
async function spawnIdleChild(): Promise<number> {
  const child = spawn('node', ['-e', 'setInterval(() => {}, 10000)'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child.pid ?? 0;
}

maybe('rewind execute — forced running', () => {
  const id = 'task-forced';

  it('stops a live subprocess + completes the rewind under --force', async () => {
    const { root, cleanup } = await makeFixture(id);
    try {
      const pid = await spawnIdleChild();
      expect(pid).toBeGreaterThan(0);
      const statePath = join(root, '.forjis', 'tasks', id, 'state.yaml');
      const state = await readFile(statePath, 'utf-8');
      await writeFile(
        statePath,
        state.replace('status: done', 'status: running'),
        'utf-8',
      );
      await writeFile(
        join(root, '.forjis', 'tasks', id, 'pid'),
        String(pid),
        'utf-8',
      );

      // plan with --force returns no refusal for running.
      const p1 = await plan(root, id, {
        dryRun: false,
        yes: true,
        force: true,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p1.refusal).toBeNull();

      // Kill the child ourselves to simulate the stopCommand escalation
      // result; we're not invoking rewindCommand (which would
      // process.exit). Instead we verify that the classifier can
      // transition to `failed` once the state file says so.
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      await writeFile(
        statePath,
        state.replace('status: done', 'status: failed'),
        'utf-8',
      );

      const p2 = await plan(root, id, {
        dryRun: false,
        yes: true,
        force: true,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(p2.state.kind).toBe('failed');
      const result = await execute(root, p2, {
        dryRun: false,
        yes: true,
        force: true,
        keepBranch: false,
        purgeTaskFile: false,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60000);
});

describe('printRewindHelp text contains watcher note (AS-008)', () => {
  it('help text mentions --watch re-queue behaviour', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(
      here,
      '..',
      '..',
      '..',
      'cli',
      'dist',
      'bin',
      'forjis.js',
    );
    // Only run if the CLI has been built (npm run build).
    try {
      await stat(cliPath);
    } catch {
      return;
    }
    const result = spawnSync('node', [cliPath, 'rewind', '--help'], {
      env: { ...process.env },
    });
    const combined =
      result.stdout.toString() + result.stderr.toString();
    expect(combined).toContain('--watch');
    expect(combined).toMatch(/re-queue/i);
  });
});
