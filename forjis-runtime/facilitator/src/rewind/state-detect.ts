/**
 * Pure state classifier for the rewind submodule.
 *
 * Reads `.forjis/tasks/<id>/state.yaml`, optional pid file, and the
 * git object graph (merge-walk + `branch --contains`) to resolve the
 * task into one of seven `TaskRewindState` variants per FR-004.
 * Performs no mutations.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readYamlFile } from '../state.js';
import { readPidFile } from '../process-utils.js';
import type { TaskState } from '../types.js';

import type { GitExec } from './git-exec.js';
import type { TaskRewindState } from './index.js';

/**
 * Walks merges on a target branch and returns the sha whose second
 * parent is on `forjis/<taskId>` — FR-014.
 *
 * @param gitExec - Injected git-exec seam.
 * @param taskId - Task id (alphanumeric + `-_`; caller validates).
 * @param targetBranch - Either `forjis/stage` or `main`.
 * @param cwd - Working directory for git.
 * @returns The merge sha, or null if no matching commit exists.
 */
export async function findMergeSha(
  gitExec: GitExec,
  taskId: string,
  targetBranch: string,
  cwd: string,
): Promise<string | null> {
  const expectedSubject = `Merge forjis/${taskId} into ${targetBranch}`;
  const log = await gitExec(
    ['log', '--merges', '--parents', '--format=%H %P %s', targetBranch],
    cwd,
  );
  if (log.exitCode !== 0) return null;

  const lines = log.stdout.split('\n').filter((l) => l.length > 0);
  for (const line of lines) {
    const parts = line.split(' ');
    if (parts.length < 4) continue;
    const sha = parts[0];
    // Parents appear before the subject; need to reconstruct subject.
    // Format: <sha> <p1> <p2> <subject...>
    const subject = parts.slice(3).join(' ');
    if (subject !== expectedSubject) continue;
    const verified = await verifySecondParent(gitExec, taskId, sha, cwd);
    if (verified) return sha;
  }
  return null;
}

/** Exit 0 iff `forjis/<taskId>` is an ancestor of `<sha>^2`. */
async function verifySecondParent(
  gitExec: GitExec,
  taskId: string,
  mergeSha: string,
  cwd: string,
): Promise<boolean> {
  const res = await gitExec(
    [
      'merge-base',
      '--is-ancestor',
      `forjis/${taskId}`,
      `${mergeSha}^2`,
    ],
    cwd,
  );
  return res.exitCode === 0;
}

/** Probes whether `.forjis/tasks/<id>/` exists on disk. */
async function stateDirExists(
  projectDir: string,
  taskId: string,
): Promise<boolean> {
  try {
    await stat(join(projectDir, '.forjis', 'tasks', taskId));
    return true;
  } catch {
    return false;
  }
}

/** Reads the `status` field from `.forjis/tasks/<id>/state.yaml`. */
async function readTaskStatus(
  projectDir: string,
  taskId: string,
): Promise<string | null> {
  const statePath = join(projectDir, '.forjis', 'tasks', taskId, 'state.yaml');
  const state = await readYamlFile<TaskState>(statePath);
  if (!state) return null;
  return state.status ?? null;
}

/** Returns `true` iff `main` appears in `git branch --contains <sha>`. */
async function branchContainsMain(
  gitExec: GitExec,
  mergeSha: string,
  cwd: string,
): Promise<boolean> {
  const res = await gitExec(['branch', '--contains', mergeSha], cwd);
  if (res.exitCode !== 0) return false;
  const names = res.stdout
    .split('\n')
    .map((l) => l.replace(/^\*/, '').trim())
    .filter((l) => l.length > 0);
  return names.includes('main');
}

/** Classifies a `done` task by locating its merge commit. */
async function classifyDone(
  projectDir: string,
  taskId: string,
  gitExec: GitExec,
): Promise<TaskRewindState> {
  const stageSha = await findMergeSha(gitExec, taskId, 'forjis/stage', projectDir);
  const mainSha = stageSha === null
    ? await findMergeSha(gitExec, taskId, 'main', projectDir)
    : null;
  const resolvedSha = stageSha ?? mainSha;
  if (resolvedSha === null) return { kind: 'done-unmerged' };
  const onMain = await branchContainsMain(gitExec, resolvedSha, projectDir);
  if (onMain) {
    return { kind: 'done-merged-main', mergeSha: resolvedSha, targetBranch: 'main' };
  }
  return {
    kind: 'done-merged-stage',
    mergeSha: resolvedSha,
    targetBranch: 'forjis/stage',
  };
}

/**
 * Classifies a task into its rewind state.
 *
 * @param projectDir - Absolute project root.
 * @param taskId - Task id.
 * @param opts - Injection seam for `gitExec`.
 * @returns The resolved `TaskRewindState`.
 */
export async function detectState(
  projectDir: string,
  taskId: string,
  opts: { gitExec: GitExec },
): Promise<TaskRewindState> {
  const exists = await stateDirExists(projectDir, taskId);
  if (!exists) return { kind: 'not-found' };

  const status = await readTaskStatus(projectDir, taskId);
  if (status === 'queued') return { kind: 'queued' };
  if (status === 'running') {
    const pid = await readPidFile(projectDir, taskId);
    return { kind: 'running', pid: pid ?? 0 };
  }
  if (status === 'failed') return { kind: 'failed' };
  if (status === 'done') return classifyDone(projectDir, taskId, opts.gitExec);

  // Unknown/absent status with dir present — treat as failed for safety.
  return { kind: 'failed' };
}
