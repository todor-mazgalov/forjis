/**
 * Destructive primitives for the rewind submodule.
 *
 * Each primitive is idempotent by pre-state probe (FR-018) and returns
 * a `{status, message}` outcome. Primitives do NOT call `process.exit`
 * or throw on expected failure — callers inspect `status`.
 */

import { createInterface } from 'node:readline';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readYamlFile } from '../state.js';
import { invalidateExplorations } from '../context-cache/invalidator.js';

import type { GitExec } from './git-exec.js';

/** Outcome shape returned by every ops primitive. */
export interface OpOutcome {
  status: 'done' | 'nothing-to-do' | 'failed';
  message: string;
}

/** Options for `revertMerge`. */
export interface RevertMergeOpts {
  projectDir: string;
  taskId: string;
  mergeSha: string;
  targetBranch: string;
  filesTouched: Set<string>;
  gitExec: GitExec;
}

/** Reads the current HEAD commit subject. */
async function readHeadSubject(
  gitExec: GitExec,
  cwd: string,
): Promise<string | null> {
  const res = await gitExec(['log', '-1', '--format=%s', 'HEAD'], cwd);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim();
}

/** Parses `git status --porcelain` lines into the list of paths. */
function porcelainPaths(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length < 3) continue;
    // First two chars are status, then a space, then the path (with
    // possible rename ` -> ` separator we split on).
    const rest = line.slice(3);
    if (rest.includes(' -> ')) {
      const [, newPath] = rest.split(' -> ');
      out.push(newPath.trim());
    } else {
      out.push(rest.trim());
    }
  }
  return out;
}

/** Returns porcelain paths that are NOT in the allowed set. */
export function isDirtyOutsideFilesTouched(
  porcelainLines: string[],
  filesTouched: Set<string>,
): string[] {
  return porcelainPaths(porcelainLines).filter((p) => !filesTouched.has(p));
}

/** Returns true iff every dirty path lies inside `filesTouched`. */
async function allDirtyInsideSet(
  gitExec: GitExec,
  cwd: string,
  filesTouched: Set<string>,
): Promise<{ dirty: boolean; allInside: boolean }> {
  const res = await gitExec(['status', '--porcelain'], cwd);
  if (res.exitCode !== 0) return { dirty: false, allInside: true };
  const lines = res.stdout.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return { dirty: false, allInside: true };
  const paths = porcelainPaths(lines);
  const allInside = paths.every((p) => filesTouched.has(p));
  return { dirty: true, allInside };
}

/** Runs `git revert -m 1 --no-edit <sha>` for a merge commit (FR-010). */
export async function revertMerge(opts: RevertMergeOpts): Promise<OpOutcome> {
  const headSubject = await readHeadSubject(opts.gitExec, opts.projectDir);
  const alreadyRevertedPrefix = `Revert "Merge forjis/${opts.taskId} into `;
  if (headSubject !== null && headSubject.startsWith(alreadyRevertedPrefix)) {
    return {
      status: 'nothing-to-do',
      message: 'revert: nothing to do (already reverted)',
    };
  }

  const { dirty, allInside } = await allDirtyInsideSet(
    opts.gitExec,
    opts.projectDir,
    opts.filesTouched,
  );

  let stashCreated = false;
  if (dirty && allInside) {
    const stashRes = await opts.gitExec(
      ['stash', 'push', '--keep-index', '-m', `forjis-rewind ${opts.taskId}`],
      opts.projectDir,
    );
    if (stashRes.exitCode === 0) stashCreated = true;
  }

  const revertRes = await opts.gitExec(
    ['revert', '-m', '1', '--no-edit', opts.mergeSha],
    opts.projectDir,
  );
  if (revertRes.exitCode !== 0) {
    return {
      status: 'failed',
      message: `revert failed — resolve conflicts or run 'git revert --abort'`,
    };
  }

  if (stashCreated) {
    await opts.gitExec(['stash', 'drop'], opts.projectDir);
  }

  const revertSha = await readHeadSha(opts.gitExec, opts.projectDir);
  return {
    status: 'done',
    message: `revert: created commit ${revertSha}`,
  };
}

/** Reads the current HEAD sha (abbreviated). */
async function readHeadSha(gitExec: GitExec, cwd: string): Promise<string> {
  const res = await gitExec(['rev-parse', '--short', 'HEAD'], cwd);
  if (res.exitCode !== 0) return 'HEAD';
  return res.stdout.trim();
}

/** Options for `deleteBranch`. */
export interface DeleteBranchOpts {
  projectDir: string;
  branchName: string;
  gitExec: GitExec;
}

/** Deletes `forjis/<id>` if it exists and is not current HEAD (FR-009). */
export async function deleteBranch(opts: DeleteBranchOpts): Promise<OpOutcome> {
  const exists = await opts.gitExec(
    ['branch', '--list', opts.branchName],
    opts.projectDir,
  );
  if (exists.exitCode !== 0 || exists.stdout.trim().length === 0) {
    return {
      status: 'nothing-to-do',
      message: 'branch-delete: nothing to do (no such branch)',
    };
  }

  const head = await opts.gitExec(
    ['symbolic-ref', '--short', 'HEAD'],
    opts.projectDir,
  );
  const headBranch = head.exitCode === 0 ? head.stdout.trim() : '';
  if (headBranch === opts.branchName) {
    return {
      status: 'nothing-to-do',
      message: `branch-delete: ${opts.branchName} is the current HEAD; skipped`,
    };
  }

  const del = await opts.gitExec(
    ['branch', '-D', opts.branchName],
    opts.projectDir,
  );
  if (del.exitCode !== 0) {
    return {
      status: 'failed',
      message: `branch-delete: failed to delete ${opts.branchName}`,
    };
  }
  return {
    status: 'done',
    message: `branch-delete: removed ${opts.branchName}`,
  };
}

/** Options for `rmOpenspec`. */
export interface RmOpenspecOpts {
  projectDir: string;
  taskId: string;
}

/** Removes `openspec/changes/<taskId>/` recursively if present. */
export async function rmOpenspec(opts: RmOpenspecOpts): Promise<OpOutcome> {
  const target = join(opts.projectDir, 'openspec', 'changes', opts.taskId);
  try {
    await stat(target);
  } catch {
    return {
      status: 'nothing-to-do',
      message: 'rm-openspec: nothing to do (already absent)',
    };
  }
  await rm(target, { recursive: true, force: true });
  return {
    status: 'done',
    message: `rm-openspec: removed openspec/changes/${opts.taskId}/`,
  };
}

/** Options for `rmStateDir`. */
export interface RmStateDirOpts {
  projectDir: string;
  taskId: string;
}

/** Removes the state dir and the optional inspector staging dir. */
export async function rmStateDir(opts: RmStateDirOpts): Promise<OpOutcome> {
  const target = join(opts.projectDir, '.forjis', 'tasks', opts.taskId);
  try {
    await stat(target);
  } catch {
    return {
      status: 'nothing-to-do',
      message: 'rm-statedir: nothing to do (already absent)',
    };
  }

  const batchId = await readInspectorBatchId(opts.projectDir, opts.taskId);
  await rm(target, { recursive: true, force: true });

  if (batchId !== null) {
    const inspectorPath = join(opts.projectDir, '.forjis', 'inspector', batchId);
    try {
      await stat(inspectorPath);
      await rm(inspectorPath, { recursive: true, force: true });
      console.log(`inspector-staging: removed .forjis/inspector/${batchId}/`);
    } catch {
      /* dir absent; nothing to do */
    }
  } else {
    console.log('inspector-staging: no batch id recorded; skipped');
  }

  return {
    status: 'done',
    message: `rm-statedir: removed .forjis/tasks/${opts.taskId}/`,
  };
}

/** Reads `inspectorBatchId` from `pipeline-state.yaml` if present. */
async function readInspectorBatchId(
  projectDir: string,
  taskId: string,
): Promise<string | null> {
  const path = join(
    projectDir,
    '.forjis',
    'tasks',
    taskId,
    'pipeline-state.yaml',
  );
  const data = await readYamlFile<Record<string, unknown>>(path);
  if (!data) return null;
  const batch = data['inspectorBatchId'];
  return typeof batch === 'string' && batch.length > 0 ? batch : null;
}

/** Options for `invalidateCache`. */
export interface InvalidateCacheOpts {
  projectDir: string;
  taskId: string;
  changedPaths: string[];
  now: Date;
}

/** Flips the exploration cache entry and cross-invalidates overlaps. */
export async function invalidateCache(
  opts: InvalidateCacheOpts,
): Promise<OpOutcome> {
  const expPath = join(
    opts.projectDir,
    '.forjis',
    'exploration',
    `${opts.taskId}.md`,
  );
  try {
    await stat(expPath);
  } catch {
    return {
      status: 'nothing-to-do',
      message: `invalidate-cache: nothing to do (.forjis/exploration/${opts.taskId}.md absent)`,
    };
  }

  // Ensure self-invalidation runs even when changedPaths is empty (the
  // failed / done-unmerged fallback path) by including the entry's own
  // files_touched paths; when changedPaths already contains them this
  // is a no-op merge.
  const result = await invalidateExplorations({
    projectDir: opts.projectDir,
    taskId: `rewind ${opts.taskId}`,
    changedPaths: opts.changedPaths,
    now: opts.now,
  });
  const crossCount = Math.max(0, result.invalidatedCount - 1);
  return {
    status: 'done',
    message: `invalidate-cache: flipped ${
      result.invalidatedCount
    } entr${result.invalidatedCount === 1 ? 'y' : 'ies'} (+ cross-invalidated ${crossCount} entries)`,
  };
}

/** Options for `purgeTaskFile`. */
export interface PurgeTaskFileOpts {
  projectDir: string;
  candidates: string[];
}

/** Removes every candidate `tasks/<id>.<ext>` that exists. */
export async function purgeTaskFile(
  opts: PurgeTaskFileOpts,
): Promise<OpOutcome> {
  const removed: string[] = [];
  for (const rel of opts.candidates) {
    const abs = join(opts.projectDir, rel);
    try {
      await stat(abs);
    } catch {
      continue;
    }
    await rm(abs, { force: true });
    removed.push(rel);
  }
  if (removed.length === 0) {
    return {
      status: 'nothing-to-do',
      message: 'rm-task-file: nothing to do (no candidates found)',
    };
  }
  return {
    status: 'done',
    message: `rm-task-file: removed ${removed.join(', ')}`,
  };
}

/** Prompts the user for y/n confirmation via readline. */
export async function confirmAction(prompt: string): Promise<boolean> {
  console.log(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question('', resolvePromise);
    });
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/** Prompts the user to type `REWIND MAIN` verbatim (FR-016). */
export async function confirmMainRewind(prompt: string): Promise<boolean> {
  console.log(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question('', resolvePromise);
    });
    return answer === 'REWIND MAIN' || answer.trimEnd() === 'REWIND MAIN';
  } finally {
    rl.close();
  }
}
