/**
 * Public entry point for the rewind submodule. Exposes the `plan()`,
 * `execute()`, and `rewindCommand()` orchestration surface plus every
 * public type consumers may need (`RewindOpts`, `RewindPlan`, etc.).
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { assertValidTaskId } from '../task-id.js';
import { stopCommand } from '../commands/stop.js';
import { readPidFile } from '../process-utils.js';

import { detectState } from './state-detect.js';
import { checkAncestry } from './ancestry.js';
import type { GitExec } from './git-exec.js';
import { gitExec as defaultGitExec } from './git-exec.js';
import {
  confirmAction,
  confirmMainRewind,
  deleteBranch,
  invalidateCache,
  isDirtyOutsideFilesTouched,
  purgeTaskFile,
  revertMerge,
  rmOpenspec,
  rmStateDir,
} from './ops.js';
import {
  extractFilesTouched,
  parseExplorationFile,
} from '../context-cache/frontmatter.js';

/** Flags accepted by `forjis rewind`. All default to `false`. */
export interface RewindOpts {
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  keepBranch: boolean;
  purgeTaskFile: boolean;
}

/** Discriminated union of task lifecycle states per FR-004. */
export type TaskRewindState =
  | { kind: 'not-found' }
  | { kind: 'queued' }
  | { kind: 'running'; pid: number }
  | { kind: 'failed' }
  | { kind: 'done-unmerged' }
  | { kind: 'done-merged-stage'; mergeSha: string; targetBranch: 'forjis/stage' }
  | { kind: 'done-merged-main'; mergeSha: string; targetBranch: 'main' };

/** Discriminated union of destructive primitives (design D7). */
export type RewindOp =
  | { kind: 'revert'; mergeSha: string; targetBranch: string }
  | { kind: 'branch-delete'; branchName: string }
  | { kind: 'rm-openspec'; path: string }
  | { kind: 'rm-statedir'; path: string }
  | { kind: 'invalidate-cache'; taskId: string; changedPaths: string[] }
  | { kind: 'rm-task-file'; candidates: string[] };

/** Ordered plan produced by `plan()` and consumed by `execute()`. */
export interface RewindPlan {
  taskId: string;
  state: TaskRewindState;
  ops: RewindOp[];
  refusal: { code: string; message: string } | null;
  prompts: { standard: string | null; rewindMain: string | null };
}

/** Outcome of executing a plan. */
export interface RewindResult {
  executed: Array<{
    op: RewindOp;
    status: 'done' | 'nothing-to-do' | 'failed';
    message: string;
  }>;
  exitCode: number;
}

/** Internal option bag that carries test-time seams (not CLI surface). */
interface InternalOpts {
  gitExec?: GitExec;
}

/** Exported for unit-test use — wraps the default seam for optional injection. */
function resolveGitExec(internal?: InternalOpts): GitExec {
  return internal?.gitExec ?? defaultGitExec;
}

/** Reads `files_touched` from the exploration cache; tolerates absence. */
async function readFilesTouched(
  projectDir: string,
  taskId: string,
): Promise<string[]> {
  const path = join(projectDir, '.forjis', 'exploration', `${taskId}.md`);
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = parseExplorationFile(content);
    if (parsed === null) return [];
    return extractFilesTouched(parsed.frontmatter).map((e) => e.path);
  } catch {
    return [];
  }
}

/** Returns the changeset of the merge commit (first-parent diff). */
async function readRevertedPaths(
  gitExec: GitExec,
  cwd: string,
  mergeSha: string,
): Promise<string[]> {
  const res = await gitExec(
    [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-m',
      '--first-parent',
      mergeSha,
    ],
    cwd,
  );
  if (res.exitCode !== 0) return [];
  return res.stdout.split('\n').filter((l) => l.length > 0);
}

/** Renders the `standard` confirmation prompt per D13. */
function buildStandardPrompt(
  taskId: string,
  state: TaskRewindState,
  ops: RewindOp[],
): string {
  const targetBranchLine =
    state.kind === 'done-merged-stage' || state.kind === 'done-merged-main'
      ? `  Target branch: ${state.targetBranch}\n`
      : '';
  const lines = [`Rewind task ${taskId}:`, `  State: ${state.kind}`];
  if (targetBranchLine) lines.push(targetBranchLine.trimEnd());
  lines.push('  Planned ops:');
  for (const op of ops) lines.push(`    - ${summariseOp(op)}`);
  lines.push('');
  lines.push('Continue? [y/N]');
  return lines.join('\n');
}

/** Short human description of an op for prompts + dry-run output. */
function summariseOp(op: RewindOp): string {
  switch (op.kind) {
    case 'revert':
      return `revert ${op.mergeSha} on ${op.targetBranch}`;
    case 'branch-delete':
      return `branch-delete ${op.branchName}`;
    case 'rm-openspec':
      return `rm-openspec ${op.path}`;
    case 'rm-statedir':
      return `rm-statedir ${op.path}`;
    case 'invalidate-cache':
      return `invalidate-cache .forjis/exploration/${op.taskId}.md (+ cross-invalidation)`;
    case 'rm-task-file':
      return `rm-task-file ${op.candidates.join(', ')}`;
  }
}

/** Renders the REWIND MAIN prompt per D13 / FR-016. */
function buildMainPrompt(): string {
  return [
    "DANGER: rewind modifies history on 'main'. This creates a new revert commit",
    "on 'main'. Other workstations that have pulled main will see the revert.",
    '',
    "Type 'REWIND MAIN' (case-sensitive) to continue, anything else to abort:",
  ].join('\n');
}

/** Helper: is the state a destructive flow that runs revert? */
function isMergedState(state: TaskRewindState): boolean {
  return (
    state.kind === 'done-merged-stage' || state.kind === 'done-merged-main'
  );
}

/** Helper: is the state one whose flow prompts before destructive ops? */
function isStandardPromptState(state: TaskRewindState): boolean {
  return (
    state.kind === 'failed' ||
    state.kind === 'done-unmerged' ||
    state.kind === 'done-merged-stage'
  );
}

/** Builds `ops` list for destructive flows per FR-012. */
function buildOps(
  taskId: string,
  state: TaskRewindState,
  opts: RewindOpts,
  changedPaths: string[],
): RewindOp[] {
  const ops: RewindOp[] = [];
  if (isMergedState(state) && 'mergeSha' in state) {
    ops.push({
      kind: 'revert',
      mergeSha: state.mergeSha,
      targetBranch: state.targetBranch,
    });
  }
  if (!opts.keepBranch) {
    ops.push({ kind: 'branch-delete', branchName: `forjis/${taskId}` });
  }
  ops.push({ kind: 'rm-openspec', path: `openspec/changes/${taskId}` });
  ops.push({ kind: 'rm-statedir', path: `.forjis/tasks/${taskId}` });
  ops.push({ kind: 'invalidate-cache', taskId, changedPaths });
  if (opts.purgeTaskFile) {
    ops.push({
      kind: 'rm-task-file',
      candidates: [
        `tasks/${taskId}.md`,
        `tasks/${taskId}.txt`,
        `tasks/${taskId}.yaml`,
        `tasks/${taskId}.yml`,
      ],
    });
  }
  return ops;
}

/** Runs `git status --porcelain` and returns the raw lines. */
async function readPorcelain(
  gitExec: GitExec,
  cwd: string,
): Promise<string[]> {
  const res = await gitExec(['status', '--porcelain'], cwd);
  if (res.exitCode !== 0) return [];
  return res.stdout.split('\n').filter((l) => l.length > 0);
}

/**
 * Pure analysis pass — builds the execution plan without touching
 * the filesystem or git object graph beyond reads.
 *
 * @param projectDir - Absolute project root.
 * @param taskId - Target task ID (pre-validated by caller).
 * @param opts - Parsed CLI flags.
 * @param internal - Optional test seam for gitExec injection.
 */
export async function plan(
  projectDir: string,
  taskId: string,
  opts: RewindOpts,
  internal?: InternalOpts,
): Promise<RewindPlan> {
  const gitExec = resolveGitExec(internal);
  const state = await detectState(projectDir, taskId, { gitExec });

  if (state.kind === 'not-found' || state.kind === 'queued') {
    return buildSimplePlan(taskId, state, opts);
  }

  if (state.kind === 'running' && !opts.force) {
    return {
      taskId,
      state,
      ops: [],
      refusal: {
        code: 'running',
        message: `task ${taskId} is still running; run 'forjis stop ${taskId}' first, or pass --force`,
      },
      prompts: { standard: null, rewindMain: null },
    };
  }

  if (state.kind === 'done-merged-main' && !opts.force) {
    return {
      taskId,
      state,
      ops: [],
      refusal: {
        code: 'main-merged',
        message: `task ${taskId} is merged into main; pass --force to rewind main`,
      },
      prompts: { standard: null, rewindMain: null },
    };
  }

  const filesTouched = await readFilesTouched(projectDir, taskId);

  if (isMergedState(state) && 'mergeSha' in state) {
    const ancestry = await checkAncestry(
      projectDir,
      taskId,
      state.mergeSha,
      state.targetBranch,
      { gitExec },
    );
    if (!ancestry.ok) {
      const lines = ancestry.chain.map(
        (c) => `  - ${c} (touches overlapping files_touched)`,
      );
      return {
        taskId,
        state,
        ops: [],
        refusal: {
          code: 'ancestry',
          message: `Cannot rewind ${taskId} without also rewinding:\n${lines.join(
            '\n',
          )}\nRewind those first (in reverse order), then retry.`,
        },
        prompts: { standard: null, rewindMain: null },
      };
    }
  }

  const porcelain = await readPorcelain(gitExec, projectDir);
  const dirtyOutside = isDirtyOutsideFilesTouched(
    porcelain,
    new Set(filesTouched),
  );
  if (dirtyOutside.length > 0 && !opts.force) {
    return {
      taskId,
      state,
      ops: [],
      refusal: {
        code: 'dirty',
        message: `working tree is dirty outside this task's files_touched: ${dirtyOutside.join(
          ', ',
        )}; pass --force to override`,
      },
      prompts: { standard: null, rewindMain: null },
    };
  }

  const changedPaths = isMergedState(state) && 'mergeSha' in state
    ? await readRevertedPaths(gitExec, projectDir, state.mergeSha)
    : filesTouched;

  const ops = buildOps(taskId, state, opts, changedPaths);
  const standard = isStandardPromptState(state)
    ? buildStandardPrompt(taskId, state, ops)
    : null;
  const rewindMain = state.kind === 'done-merged-main' ? buildMainPrompt() : null;

  return {
    taskId,
    state,
    ops,
    refusal: null,
    prompts: { standard, rewindMain },
  };
}

/** Builds minimal plans for `not-found` / `queued` states. */
function buildSimplePlan(
  taskId: string,
  state: TaskRewindState,
  opts: RewindOpts,
): RewindPlan {
  if (state.kind === 'not-found') {
    const ops: RewindOp[] = [];
    if (opts.purgeTaskFile) {
      ops.push({
        kind: 'rm-task-file',
        candidates: [
          `tasks/${taskId}.md`,
          `tasks/${taskId}.txt`,
          `tasks/${taskId}.yaml`,
          `tasks/${taskId}.yml`,
        ],
      });
    }
    return {
      taskId,
      state,
      ops,
      refusal: null,
      prompts: { standard: null, rewindMain: null },
    };
  }
  // queued
  const ops: RewindOp[] = [
    { kind: 'rm-statedir', path: `.forjis/tasks/${taskId}` },
  ];
  return {
    taskId,
    state,
    ops,
    refusal: null,
    prompts: { standard: null, rewindMain: null },
  };
}

/**
 * Executes a previously computed plan against the filesystem / git
 * graph. Stops at the first `failed` primitive per FR-012.
 *
 * @param projectDir - Absolute project root.
 * @param rewindPlan - A plan produced by `plan()`.
 * @param opts - Parsed CLI flags (only `dryRun` is consulted here).
 * @param internal - Optional test seam for gitExec injection.
 */
export async function execute(
  projectDir: string,
  rewindPlan: RewindPlan,
  opts: RewindOpts,
  internal?: InternalOpts,
): Promise<RewindResult> {
  if (opts.dryRun) return { executed: [], exitCode: 0 };

  const gitExec = resolveGitExec(internal);
  const filesTouched = new Set(await readFilesTouched(projectDir, rewindPlan.taskId));
  const executed: RewindResult['executed'] = [];
  let hadFailure = false;

  for (const op of rewindPlan.ops) {
    if (hadFailure) break;
    const outcome = await runOp(op, {
      projectDir,
      gitExec,
      filesTouched,
      taskId: rewindPlan.taskId,
    });
    executed.push({ op, ...outcome });
    console.log(outcome.message);
    if (outcome.status === 'failed') hadFailure = true;
  }

  const doneCount = executed.filter((e) => e.status === 'done').length;
  const noopCount = executed.filter((e) => e.status === 'nothing-to-do').length;
  const failedCount = executed.filter((e) => e.status === 'failed').length;
  console.log(
    `rewind complete — ${doneCount} ops executed, ${noopCount} no-ops, ${failedCount} failed`,
  );

  return { executed, exitCode: hadFailure ? 1 : 0 };
}

/** Internal dispatch table for op execution. */
interface OpContext {
  projectDir: string;
  gitExec: GitExec;
  filesTouched: Set<string>;
  taskId: string;
}

/** Dispatches a single op to its primitive implementation. */
async function runOp(
  op: RewindOp,
  ctx: OpContext,
): Promise<{ status: 'done' | 'nothing-to-do' | 'failed'; message: string }> {
  switch (op.kind) {
    case 'revert':
      return revertMerge({
        projectDir: ctx.projectDir,
        taskId: ctx.taskId,
        mergeSha: op.mergeSha,
        targetBranch: op.targetBranch,
        filesTouched: ctx.filesTouched,
        gitExec: ctx.gitExec,
      });
    case 'branch-delete':
      return deleteBranch({
        projectDir: ctx.projectDir,
        branchName: op.branchName,
        gitExec: ctx.gitExec,
      });
    case 'rm-openspec':
      return rmOpenspec({ projectDir: ctx.projectDir, taskId: ctx.taskId });
    case 'rm-statedir':
      return rmStateDir({ projectDir: ctx.projectDir, taskId: ctx.taskId });
    case 'invalidate-cache':
      return invalidateCache({
        projectDir: ctx.projectDir,
        taskId: op.taskId,
        changedPaths: op.changedPaths,
        now: new Date(),
      });
    case 'rm-task-file':
      return purgeTaskFile({
        projectDir: ctx.projectDir,
        candidates: op.candidates,
      });
  }
}

/** Handles the running-state escalation: stop + wait + re-plan. */
async function handleRunningForce(
  projectDir: string,
  taskId: string,
): Promise<void> {
  await stopCommand(projectDir, taskId);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const pid = await readPidFile(projectDir, taskId);
    if (pid === null) return;
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Prints a refusal to stderr and exits the process non-zero. */
function exitRefusal(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Renders the dry-run plan per D14 / FR-021. */
function renderDryRun(rewindPlan: RewindPlan): void {
  console.log(`Plan for rewind ${rewindPlan.taskId}:`);
  console.log(`State: ${rewindPlan.state.kind}`);
  if (rewindPlan.refusal !== null) {
    console.log(`REFUSAL (current flags): ${rewindPlan.refusal.message}`);
  }
  console.log('Planned ops (in execution order):');
  for (const op of rewindPlan.ops) {
    console.log(`  - ${summariseOp(op)}`);
  }
  console.log('No destructive ops will run (--dry-run).');
}

/**
 * Top-level CLI command: plan, prompt, execute.
 *
 * @param projectDir - Absolute project root.
 * @param taskId - Raw task id passed on the CLI.
 * @param opts - Parsed CLI flags.
 */
export async function rewindCommand(
  projectDir: string,
  taskId: string,
  opts: RewindOpts,
): Promise<void> {
  assertValidTaskId(taskId, 'rewind');

  let currentPlan = await plan(projectDir, taskId, opts);

  if (currentPlan.state.kind === 'not-found') {
    console.log('task not found');
    if (opts.purgeTaskFile) {
      const result = await execute(projectDir, currentPlan, opts);
      process.exit(result.exitCode);
    }
    process.exit(0);
  }

  if (opts.dryRun) {
    renderDryRun(currentPlan);
    if (currentPlan.refusal !== null) {
      const forcedPlan = await plan(projectDir, taskId, { ...opts, force: true });
      console.log('Plan that would run with --force:');
      for (const op of forcedPlan.ops) {
        console.log(`  - ${summariseOp(op)}`);
      }
    }
    process.exit(0);
  }

  if (currentPlan.refusal !== null) {
    exitRefusal(currentPlan.refusal.message);
  }

  if (currentPlan.state.kind === 'running' && opts.force) {
    await handleRunningForce(projectDir, taskId);
    currentPlan = await plan(projectDir, taskId, opts);
    if (currentPlan.refusal !== null) {
      exitRefusal(currentPlan.refusal.message);
    }
  }

  if (currentPlan.prompts.standard !== null && !opts.yes) {
    const ok = await confirmAction(currentPlan.prompts.standard);
    if (!ok) {
      console.error('aborted');
      process.exit(1);
    }
  }

  if (currentPlan.prompts.rewindMain !== null) {
    const ok = await confirmMainRewind(currentPlan.prompts.rewindMain);
    if (!ok) {
      console.error('REWIND MAIN not confirmed; aborted');
      process.exit(1);
    }
  }

  const result = await execute(projectDir, currentPlan, opts);
  process.exit(result.exitCode);
}
