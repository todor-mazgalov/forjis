/**
 * Per-role context artefact writer.
 *
 * Produces `.forjis/tasks/<taskId>/context-<org>-<team>-<role>.yaml`
 * for every non-Reviewer role. The file is pure structured data —
 * never prompt prose, per pillars/architecture.md §Layer 2.
 *
 * Shape (schema `version: 1`):
 *
 *   version: 1
 *   index_md: <full body of .forjis/context/index.md at dispatch>
 *   ranked_rows:
 *     - path: <relative POSIX>
 *       summary: <≤120-char sentence>
 *   prior_explorations:
 *     - taskId: <id>
 *       body: <verbatim exploration body>
 *       createdAt: <iso8601>
 *       isCurrentTask: <bool>
 *
 * Reviewer roles (stage === 'reviewer', case-insensitive) are skipped
 * at this layer — the orchestrator Step 8 never sees a file for them
 * and therefore renders no Codebase-index section (spec R8).
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { atomicWriteFile, ensureDir } from '../state.js';
import {
  findOverlappingExplorations,
  type OverlapEntry,
} from './exploration-overlap.js';
import { rankByTask } from './ranking.js';
import type { TreeYaml } from './tree-yaml.js';

/** Warning-line prefix. */
const WARN_PREFIX = '[context-cache]:';

/** Role identity triple accepted by the writer. */
export interface ArtefactRole {
  org: string;
  team: string;
  role: string;
  /** Pipeline stage ("explorer" | "analyst" | "architect" | "developer" | "reviewer" | ...). */
  stage?: string;
}

/** Entry included in the artefact's `prior_explorations` list. */
export interface PriorExplorationEntry {
  taskId: string;
  body: string;
  createdAt: string;
  isCurrentTask: boolean;
}

/** Full shape of the per-role artefact. */
export interface ContextArtefact {
  version: 1;
  index_md: string;
  ranked_rows: Array<{ path: string; summary: string }>;
  prior_explorations: PriorExplorationEntry[];
}

/** Options accepted by {@link writeContextArtefact}. */
export interface WriteArtefactOptions {
  /** Absolute project root. */
  projectDir: string;
  /** Current task id. */
  taskId: string;
  /** Role identity to write the artefact for. */
  role: ArtefactRole;
  /** Task description — fuels the ranker. */
  taskDescription: string;
  /** Already-loaded tree.yaml. */
  tree: TreeYaml;
  /** Already-loaded index.md body. */
  indexMd: string;
  /** Resolved `context.inline_top_n`. */
  inlineTopN: number;
  /** Candidate-path set used for the exploration-overlap scan. */
  candidatePaths: string[];
  /** Injection seam — overlap scanner. */
  overlapImpl?: typeof findOverlappingExplorations;
  /** Injection seam — ranker. */
  rankImpl?: typeof rankByTask;
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/** Return shape of {@link writeContextArtefact}. */
export interface WriteArtefactResult {
  /** Path to the written artefact, or `null` when the role is Reviewer. */
  artefactPath: string | null;
}

/**
 * Writes one per-role artefact.
 *
 * Returns `{ artefactPath: null }` when the role is Reviewer (stage
 * matches 'reviewer' case-insensitive). Otherwise the artefact is
 * built, serialised, and atomically written.
 *
 * @param opts - Write options.
 * @returns Path of the written file (or null for Reviewer).
 */
export async function writeContextArtefact(
  opts: WriteArtefactOptions,
): Promise<WriteArtefactResult> {
  if (isReviewerStage(opts.role.stage)) {
    return { artefactPath: null };
  }

  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const rankImpl = opts.rankImpl ?? rankByTask;
  const overlapImpl = opts.overlapImpl ?? findOverlappingExplorations;

  const rankedRows = rankImpl(
    opts.tree.files,
    opts.taskDescription,
    opts.inlineTopN,
  ).map((r) => ({ path: r.path, summary: r.summary }));

  const priorExplorations = await buildPriorExplorations(opts, overlapImpl, warn);

  const artefact: ContextArtefact = {
    version: 1,
    index_md: opts.indexMd,
    ranked_rows: rankedRows,
    prior_explorations: priorExplorations,
  };

  const taskDir = join(opts.projectDir, '.forjis', 'tasks', opts.taskId);
  const filename =
    `context-${opts.role.org}-${opts.role.team}-${opts.role.role}.yaml`;
  const artefactPath = join(taskDir, filename);

  await ensureDir(taskDir);
  await atomicWriteFile(artefactPath, stringifyYaml(artefact, { indent: 2 }));

  return { artefactPath };
}

/** Options accepted by {@link writeContextArtefactsForTask}. */
export interface WriteArtefactsForTaskOptions {
  /** Absolute project root. */
  projectDir: string;
  /** Current task id. */
  taskId: string;
  /** Task description. */
  taskDescription: string;
  /** Flattened role list (all orgs × teams × roles). */
  roles: ArtefactRole[];
  /** Already-loaded tree.yaml. */
  tree: TreeYaml;
  /** Already-loaded index.md body. */
  indexMd: string;
  /** Resolved `context.inline_top_n`. */
  inlineTopN: number;
  /** Candidate-path set. */
  candidatePaths: string[];
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/** Return shape of {@link writeContextArtefactsForTask}. */
export interface WriteArtefactsForTaskResult {
  /** Number of role artefact files written. */
  written: number;
  /** Number of roles skipped (Reviewer) or errored. */
  skipped: number;
}

/**
 * Walks every role in the task's runtime config and calls
 * {@link writeContextArtefact} once per non-Reviewer role.
 *
 * Per-role failures emit one log line and leave that role's artefact
 * absent so the orchestrator can degrade accordingly at Step 8.
 *
 * @param opts - Options.
 * @returns Counts of written and skipped roles.
 */
export async function writeContextArtefactsForTask(
  opts: WriteArtefactsForTaskOptions,
): Promise<WriteArtefactsForTaskResult> {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  let written = 0;
  let skipped = 0;

  for (const role of opts.roles) {
    try {
      const result = await writeContextArtefact({
        projectDir: opts.projectDir,
        taskId: opts.taskId,
        role,
        taskDescription: opts.taskDescription,
        tree: opts.tree,
        indexMd: opts.indexMd,
        inlineTopN: opts.inlineTopN,
        candidatePaths: opts.candidatePaths,
        warn,
      });
      if (result.artefactPath === null) {
        skipped++;
      } else {
        written++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(
        `${WARN_PREFIX} artefact write skipped for "${role.org}:${role.team}:${role.role}" — ${msg}`
      );
      skipped++;
    }
  }

  return { written, skipped };
}

/**
 * Builds the `prior_explorations` list: the current task's own
 * `openspec/changes/<taskId>/exploration.md` body (if present, marked
 * `isCurrentTask: true`) plus up to 3 supplementary overlap entries.
 */
async function buildPriorExplorations(
  opts: WriteArtefactOptions,
  overlapImpl: typeof findOverlappingExplorations,
  warn: (msg: string) => void,
): Promise<PriorExplorationEntry[]> {
  const entries: PriorExplorationEntry[] = [];

  const currentOwn = await readCurrentTaskExploration(
    opts.projectDir,
    opts.taskId,
  );
  if (currentOwn !== null) {
    entries.push({
      taskId: opts.taskId,
      body: currentOwn,
      createdAt: new Date().toISOString(),
      isCurrentTask: true,
    });
  }

  let supplementary: OverlapEntry[] = [];
  try {
    supplementary = await overlapImpl({
      projectDir: opts.projectDir,
      currentTaskId: opts.taskId,
      candidatePaths: opts.candidatePaths,
      limit: 3,
      warn,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`${WARN_PREFIX} overlap scan failed — ${msg}`);
  }

  for (const s of supplementary) {
    entries.push({
      taskId: s.taskId,
      body: s.body,
      createdAt: s.createdAt,
      isCurrentTask: false,
    });
  }

  return entries;
}

/**
 * Reads `openspec/changes/<taskId>/exploration.md` if it exists,
 * returning its full content. Returns `null` otherwise (silent).
 */
async function readCurrentTaskExploration(
  projectDir: string,
  taskId: string,
): Promise<string | null> {
  const path = join(projectDir, 'openspec', 'changes', taskId, 'exploration.md');
  try {
    await stat(path);
  } catch {
    return null;
  }
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Case-insensitive match against the literal string `reviewer`. */
function isReviewerStage(stage: string | undefined): boolean {
  if (!stage) return false;
  return stage.toLowerCase() === 'reviewer';
}
