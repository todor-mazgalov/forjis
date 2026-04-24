/**
 * Ancestry / dependency check for the rewind submodule.
 *
 * Walks merges between the task's merge sha and the target branch tip,
 * reads each intervening merge's changeset, and fails if any overlaps
 * the rewound task's `files_touched` set (FR-013, AS-010).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  extractFilesTouched,
  parseExplorationFile,
} from '../context-cache/frontmatter.js';

import type { GitExec } from './git-exec.js';

/** Ancestry check result — tagged union. */
export type AncestryResult =
  | { ok: true }
  | { ok: false; chain: string[] };

/** Reads and parses the task's exploration cache entry. */
async function loadFilesTouched(
  projectDir: string,
  taskId: string,
): Promise<{ paths: Set<string>; present: boolean }> {
  const path = join(projectDir, '.forjis', 'exploration', `${taskId}.md`);
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = parseExplorationFile(content);
    if (parsed === null) return { paths: new Set(), present: true };
    const entries = extractFilesTouched(parsed.frontmatter);
    return { paths: new Set(entries.map((e) => e.path)), present: true };
  } catch {
    return { paths: new Set(), present: false };
  }
}

/** Lists intervening merges between `<mergeSha>` and the target tip. */
async function listInterveningMerges(
  gitExec: GitExec,
  cwd: string,
  mergeSha: string,
  targetBranch: string,
): Promise<Array<{ sha: string; subject: string }>> {
  const res = await gitExec(
    ['log', '--merges', '--format=%H %s', `${mergeSha}..${targetBranch}`],
    cwd,
  );
  if (res.exitCode !== 0) return [];
  const out: Array<{ sha: string; subject: string }> = [];
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) continue;
    out.push({
      sha: trimmed.slice(0, firstSpace),
      subject: trimmed.slice(firstSpace + 1),
    });
  }
  return out;
}

/** Returns the set of paths changed by a single commit. */
async function listChangedPaths(
  gitExec: GitExec,
  cwd: string,
  sha: string,
): Promise<string[]> {
  const res = await gitExec(
    ['show', '--name-only', '--pretty=format:', sha],
    cwd,
  );
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Extracts `forjis/<id>` id from a `Merge forjis/<id> into ...` subject. */
function extractTaskIdFromSubject(subject: string): string | null {
  const match = /^Merge forjis\/([A-Za-z0-9_-]+) into /.exec(subject);
  if (!match) return null;
  return match[1];
}

/**
 * Checks whether any intervening merge overlaps the task's
 * `files_touched`. Returns `{ok: true}` on clean ancestry, else a chain
 * of later task ids in reverse chronological order.
 *
 * @param projectDir - Absolute project root.
 * @param taskId - Id of the task being rewound.
 * @param mergeSha - Merge commit sha for the task on `targetBranch`.
 * @param targetBranch - Branch on which the merge lives.
 * @param opts - Injection seam for `gitExec`.
 */
export async function checkAncestry(
  projectDir: string,
  taskId: string,
  mergeSha: string,
  targetBranch: string,
  opts: { gitExec: GitExec },
): Promise<AncestryResult> {
  const { paths, present } = await loadFilesTouched(projectDir, taskId);
  if (!present) {
    console.error(
      `[rewind]: warning — .forjis/exploration/${taskId}.md missing; ancestry check treats files_touched as empty`,
    );
  }
  if (paths.size === 0) return { ok: true };

  const intervening = await listInterveningMerges(
    opts.gitExec,
    projectDir,
    mergeSha,
    targetBranch,
  );

  const chain: string[] = [];
  for (const merge of intervening) {
    const changed = await listChangedPaths(opts.gitExec, projectDir, merge.sha);
    const overlap = changed.some((p) => paths.has(p));
    if (!overlap) continue;
    const laterId = extractTaskIdFromSubject(merge.subject);
    if (laterId !== null) chain.push(laterId);
  }

  if (chain.length === 0) return { ok: true };
  return { ok: false, chain };
}
