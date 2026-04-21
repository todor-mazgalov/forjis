/**
 * Pipeline plan persistence module for the web dashboard.
 *
 * The orchestrator writes pipeline-state.yaml as the single source of truth
 * for which roles are running, done, skipped, etc. This module polls that
 * file and converts it to pipeline-plan.yaml in the queue directory for
 * the dashboard API to serve. Also propagates branch tracking data from
 * pipeline-state.yaml to queue state.yaml for display in task cards.
 */

import { join } from 'node:path';

import { readYamlFile, writeYamlFile } from '../state.js';
import type { TaskState } from '../types.js';
import { RoleIdentityError, validateRoleIdentityShape } from '@forjis/shared';
import type { PipelinePlanResponse, PipelineStep, RoleIdentity } from '@forjis/shared';
import type { RuntimeConfig, RuntimeRole } from '@forjis/resolver';
import type { TaskQueue } from '../task-queue.js';

/**
 * Thrown when a pipeline-plan.yaml step references an `{org, team, role}`
 * triple that does not match any role in the resolved runtime config.
 *
 * The facilitator treats this as a plan-level failure — the orchestrator is
 * asked to regenerate the plan rather than the task being retried as-is.
 * Lives in plan-writer (the single consumer) because the other plan-parse
 * error (`RoleIdentityError`) comes from the shared identity module and the
 * two together form the plan-parse error surface.
 */
export class PlanRoleNotFoundError extends Error {
  /** Zero-based index of the offending step within `plan.steps`. */
  public readonly stepIndex: number;
  /** The identity triple that was not found in the runtime config. */
  public readonly identity: RoleIdentity;

  /**
   * Constructs a new PlanRoleNotFoundError.
   *
   * @param stepIndex - Zero-based index within the plan's steps array.
   * @param identity - The offending identity triple.
   */
  constructor(stepIndex: number, identity: RoleIdentity) {
    super(
      `Plan step ${stepIndex} references unknown role identity ` +
        `{org: "${identity.org}", team: "${identity.team}", role: "${identity.role}"} — ` +
        `no matching role in resolved config`,
    );
    this.name = 'PlanRoleNotFoundError';
    this.stepIndex = stepIndex;
    this.identity = identity;
  }
}

/**
 * Shape of the pipeline-state.yaml file written by the orchestrator.
 *
 * This is the single source of truth for pipeline state. The orchestrator
 * writes it after weight evaluation and updates it before/after each agent.
 */
interface PipelineState {
  org: string;
  team: string;
  status: 'running' | 'done' | 'failed';
  roles: PipelineStateRole[];
  /** Ordered branch chain written by the orchestrator, e.g. ["main", "forjis/task-1"]. */
  branches?: string[];
}

/** A role entry in pipeline-state.yaml. */
interface PipelineStateRole {
  name: string;
  agent: string;
  status: 'planned' | 'running' | 'done' | 'skipped' | 'failed';
  description: string;
  /** Orchestrator-assigned score (0-100). Accepts historical `weight` field for backward read compatibility. */
  score?: number;
  weight?: number;
  /** Orchestrator decision. Absent on historical data; defaulted to "pending" by the plan-writer. */
  decision?: 'started' | 'skipped' | 'pending';
  justification?: string;
}

/**
 * Maps a known role name pattern to a human-readable description.
 *
 * @param roleName - The role name (e.g., "setup", "analyst").
 * @returns A human-readable description string.
 */
export function describeRole(roleName: string): string {
  const lower = roleName.toLowerCase();

  if (lower.includes('setup')) return 'Project setup and workspace preparation';
  if (lower.includes('explorer')) return 'Codebase exploration and investigation';
  if (lower.includes('analyst')) return 'Requirements analysis and specification';
  if (lower.includes('architect')) return 'Solution design and architecture';
  if (lower.includes('developer')) return 'Implementation and coding';
  if (lower.includes('reviewer')) return 'Code review and testing';
  if (lower.includes('assessor')) return 'Outcome assessment and scoring';
  if (lower.includes('finish')) return 'Task completion and archival';

  return `Pipeline stage: ${roleName}`;
}

/**
 * Writes the initial pipeline plan with status "evaluating" and no steps.
 *
 * Called when a task starts. The plan has no roles yet because the
 * orchestrator hasn't evaluated them. The dashboard shows an evaluating
 * state. Once the orchestrator writes pipeline-state.yaml, syncPlanFromState
 * populates the plan with the actual roles and statuses.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 */
export async function writePipelinePlan(
  projectDir: string,
  taskId: string,
): Promise<void> {
  const plan: PipelinePlanResponse = {
    taskId,
    orgName: null,
    teamName: null,
    steps: [],
    status: 'evaluating',
  };

  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  await writeYamlFile(planPath, plan);
}

/**
 * Reads the existing pipeline plan to preserve timing data across syncs.
 *
 * @param planPath - Absolute path to pipeline-plan.yaml.
 * @returns Map of role name to its existing timing fields, or empty map.
 */
/** Preserved step data read from the existing pipeline plan file. */
interface ExistingStepData {
  /** ISO 8601 timestamp when this step started running. */
  startedAt?: string;
  /** ISO 8601 timestamp when this step completed. */
  completedAt?: string;
  /** Current status of this step. */
  status: string;
  /** Number of health-check retries for this step. */
  retryCount?: number;
  /** Whether this step has been halted. */
  halted?: boolean;
}

/**
 * Reads the existing pipeline plan to preserve timing and retry data across syncs.
 *
 * @param planPath - Absolute path to pipeline-plan.yaml.
 * @returns Map of role name to its existing step data, or empty map.
 */
async function readExistingStepData(
  planPath: string,
): Promise<Map<string, ExistingStepData>> {
  const existing = await readYamlFile<PipelinePlanResponse>(planPath);
  const data = new Map<string, ExistingStepData>();

  if (!existing?.steps) {
    return data;
  }

  for (const step of existing.steps) {
    data.set(step.role, {
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      status: step.status,
      retryCount: step.retryCount,
      halted: step.halted,
    });
  }

  return data;
}

/**
 * Computes timing fields for a step based on status transitions.
 *
 * Detects when a role transitions from planned to running (sets startedAt)
 * or from running to done/skipped (sets completedAt). Preserves previously
 * recorded timestamps across syncs.
 *
 * @param newStatus - The new status from pipeline-state.yaml.
 * @param previous - The previously recorded step data, if any.
 * @returns Object with optional startedAt and completedAt fields.
 */
function computeStepTimings(
  newStatus: string,
  previous: { startedAt?: string; completedAt?: string; status: string } | undefined,
): { startedAt?: string; completedAt?: string } {
  const now = new Date().toISOString();

  if (!previous) {
    if (newStatus === 'running') {
      return { startedAt: now };
    }
    if (newStatus === 'done' || newStatus === 'skipped' || newStatus === 'failed') {
      return { startedAt: now, completedAt: now };
    }
    return {};
  }

  const result: { startedAt?: string; completedAt?: string } = {};

  if (previous.startedAt) {
    result.startedAt = previous.startedAt;
  } else if (newStatus === 'running' || newStatus === 'done' || newStatus === 'skipped' || newStatus === 'failed') {
    result.startedAt = now;
  }

  if (previous.completedAt) {
    result.completedAt = previous.completedAt;
  } else if (
    previous.status === 'running' &&
    (newStatus === 'done' || newStatus === 'skipped' || newStatus === 'failed')
  ) {
    result.completedAt = now;
  }

  return result;
}

/**
 * Syncs the pipeline plan from the orchestrator's pipeline-state.yaml.
 *
 * Reads .forjis/tasks/<taskId>/pipeline-state.yaml (written by the
 * orchestrator) and converts it to the dashboard API format in
 * .forjis/tasks/<taskId>/pipeline-plan.yaml. This is the ONLY mechanism
 * for updating the plan -- no guessing, no stream parsing.
 *
 * Detects status transitions between syncs and records startedAt/completedAt
 * timestamps on each step. Previously recorded timestamps are preserved.
 *
 * Returns true if the plan was updated, false if pipeline-state.yaml
 * doesn't exist yet.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @returns True if the plan was synced from state.
 */
export async function syncPlanFromState(
  projectDir: string,
  taskId: string,
): Promise<boolean> {
  const statePath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-state.yaml');
  const state = await readYamlFile<PipelineState>(statePath);

  if (!state?.roles) {
    return false;
  }

  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const existingData = await readExistingStepData(planPath);

  const roleSteps: PipelineStep[] = state.roles.map((role) => {
    const normalizedStatus = role.status === 'failed' ? 'done' : role.status;
    const previous = existingData.get(role.name);
    const timings = computeStepTimings(role.status, previous);

    const step: PipelineStep = {
      // Three separate identity fields — never a composite string. The plan
      // parser in this module and the strict orchestrator contract both
      // depend on this layout.
      org: state.org ?? '',
      team: state.team ?? '',
      role: role.name,
      agent: role.agent,
      status: normalizedStatus,
      description: role.description ?? describeRole(role.name),
      score: role.score ?? role.weight,
      decision: role.decision ?? 'pending',
      justification: role.justification ?? '',
    };

    if (timings.startedAt) {
      step.startedAt = timings.startedAt;
    }
    if (timings.completedAt) {
      step.completedAt = timings.completedAt;
    }
    if (previous?.retryCount && previous.retryCount > 0) {
      step.retryCount = previous.retryCount;
    }
    if (previous?.halted) {
      step.halted = previous.halted;
    }

    return step;
  });

  // Phase C1: linear-chain `deps` derivation. Pipeline-state.yaml is in
  // pipeline-stage order; emit `deps: [previousStep.role]` for every
  // non-first role-derived step.
  for (let i = 1; i < roleSteps.length; i++) {
    roleSteps[i].deps = [roleSteps[i - 1].role];
  }

  // Phase C2: prepend a synthetic orchestrator step. The orchestrator is
  // the dependency root for every otherwise-rootless step.
  const orchestratorStep = await buildOrchestratorStep(projectDir, taskId, state.status);
  const steps: PipelineStep[] = [orchestratorStep, ...roleSteps];
  for (let i = 1; i < steps.length; i++) {
    if (!steps[i].deps || steps[i].deps!.length === 0) {
      steps[i].deps = ['orchestrator'];
    }
  }

  const plan: PipelinePlanResponse = {
    taskId,
    orgName: state.org ?? null,
    teamName: state.team ?? null,
    steps,
    status: 'ready',
  };

  await writeYamlFile(planPath, plan);
  return true;
}

/**
 * Builds the synthetic orchestrator step prepended to every plan.
 *
 * Status mirrors the parent pipeline state (`failed` collapsed to `done`
 * to match the existing role-step normalization rule). Timing fields are
 * read from the queue's state.yaml when available; absent timing fields
 * are intentionally not invented.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param stateStatus - The pipeline-state.yaml top-level status.
 * @returns A PipelineStep representing the orchestrator pseudo-actor.
 */
async function buildOrchestratorStep(
  projectDir: string,
  taskId: string,
  stateStatus: PipelineState['status'],
): Promise<PipelineStep> {
  const step: PipelineStep = {
    kind: 'orchestrator',
    // The synthetic orchestrator step has no real identity; empty org / team
    // avoid a composite string while making it trivially identifiable.
    org: '',
    team: '',
    role: 'orchestrator',
    agent: '',
    status: deriveOrchestratorStatus(stateStatus),
    description: 'Pipeline orchestrator',
    deps: [],
  };

  const taskStatePath = join(projectDir, '.forjis', 'tasks', taskId, 'state.yaml');
  const taskState = await readYamlFile<TaskState>(taskStatePath);
  if (taskState?.started) {
    step.startedAt = taskState.started;
  }
  if (taskState?.completed) {
    step.completedAt = taskState.completed;
  }

  return step;
}

/**
 * Maps a pipeline-state.yaml top-level status to the synthetic orchestrator
 * step's status, preserving the same `failed -> done` collapse used by the
 * role mapper for symmetry.
 *
 * @param stateStatus - The top-level pipeline-state.yaml status.
 * @returns A PipelineStep status appropriate for the orchestrator step.
 */
function deriveOrchestratorStatus(
  stateStatus: PipelineState['status'],
): PipelineStep['status'] {
  if (stateStatus === 'running') return 'running';
  return 'done';
}

/**
 * Returns the currently running role's structured identity from
 * pipeline-state.yaml.
 *
 * Reads the orchestrator's pipeline-state.yaml and finds the role with
 * status `running`. Returns the full `{org, team, role}` triple so the
 * facilitator can route events to the canonical filename without any
 * string-concatenation drift.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @returns The `{org, team, role}` identity, or null if no role is running
 *          or the state is incomplete.
 */
export async function getRunningRole(
  projectDir: string,
  taskId: string,
): Promise<RoleIdentity | null> {
  const statePath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-state.yaml');
  const state = await readYamlFile<PipelineState>(statePath);

  if (!state?.roles || !state.team || !state.org) {
    return null;
  }

  const running = state.roles.find((r) => r.status === 'running');
  if (!running) {
    return null;
  }

  return { org: state.org, team: state.team, role: running.name };
}

/**
 * Strict plan parser that validates every step against the resolved config.
 *
 * Reads `pipeline-plan.yaml`, enforces that each non-orchestrator step has
 * non-empty `org` / `team` / `role` fields with no reserved characters, and
 * looks up the `RuntimeRole` matching the `(org, team, role)` triple. Does
 * NOT fuzzy-match, normalise case, or strip trailing segments to recover —
 * any mismatch is the orchestrator's bug and must cause a rerun.
 *
 * The orchestrator step (`kind === 'orchestrator'`) is skipped because it
 * has no identity — see `buildOrchestratorStep`.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param config - The resolved runtime config to match against.
 * @returns An array of `{step, runtimeRole}` pairs, one per validated step.
 *          Returns `null` when the plan file does not exist yet.
 * @throws {RoleIdentityError} When a step's fields contain reserved chars.
 * @throws {PlanRoleNotFoundError} When no RuntimeRole matches a step.
 */
export async function parsePipelinePlan(
  projectDir: string,
  taskId: string,
  config: RuntimeConfig,
): Promise<Array<{ step: PipelineStep; runtimeRole: RuntimeRole }> | null> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const plan = await readYamlFile<PipelinePlanResponse>(planPath);
  if (!plan?.steps) {
    return null;
  }

  const results: Array<{ step: PipelineStep; runtimeRole: RuntimeRole }> = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.kind === 'orchestrator') {
      continue;
    }
    const identity: RoleIdentity = {
      org: step.org,
      team: step.team,
      role: step.role,
    };
    validateRoleIdentityShape(identity);
    const runtimeRole = findRuntimeRole(config, identity);
    if (!runtimeRole) {
      throw new PlanRoleNotFoundError(i, identity);
    }
    results.push({ step, runtimeRole });
  }

  return results;
}

/**
 * Looks up a `RuntimeRole` by exact `(org, team, role)` triple.
 *
 * Matches `org.name`, `team.name`, and the role's bare (unscoped) name so
 * the user-written `role` field in `pipeline-plan.yaml` doesn't need to
 * know about the resolver's internal `plugin:` prefix.
 *
 * @param config - The resolved runtime config.
 * @param identity - The identity triple to match.
 * @returns The matching RuntimeRole or null.
 */
function findRuntimeRole(
  config: RuntimeConfig,
  identity: RoleIdentity,
): RuntimeRole | null {
  const org = config.orgs.find((o) => o.name === identity.org);
  if (!org) return null;
  const team = org.teams.find((t) => t.name === identity.team);
  if (!team) return null;
  return (
    team.roles.find(
      (r) =>
        r.name === identity.role || unscopedName(r.name) === identity.role,
    ) ?? null
  );
}

/** Extracts the unscoped tail from a possibly scoped `plugin:Name` string. */
function unscopedName(name: string): string {
  const idx = name.lastIndexOf(':');
  return idx === -1 ? name : name.substring(idx + 1);
}

// Re-export the shared error so callers that catch plan-parse failures can
// import both error classes from one place.
export { RoleIdentityError };

/**
 * Forces the pipeline plan status to 'ready'.
 *
 * Used as fallback when pipeline-state.yaml is missing after engine
 * completion. If no plan file exists, does nothing.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 */
export async function forcePlanReady(
  projectDir: string,
  taskId: string
): Promise<void> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const plan = await readYamlFile<PipelinePlanResponse>(planPath);

  if (!plan) {
    return;
  }

  plan.status = 'ready';
  await writeYamlFile(planPath, plan);
}

/**
 * Checks whether two string arrays are deeply equal.
 *
 * @param a - First array (may be undefined).
 * @param b - Second array (may be undefined).
 * @returns True if both arrays have identical elements in the same order.
 */
function branchesEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Reads branches from pipeline-state.yaml and propagates to state.yaml.
 *
 * The orchestrator writes a `branches` field to pipeline-state.yaml with
 * the ordered branch chain (e.g., ["main", "forjis/task-1"]). This function
 * reads that field and writes it to the queue state.yaml so the dashboard
 * can display it in task cards.
 *
 * Avoids unnecessary writes when the branches are already identical.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param queue - The task queue instance for reading/writing state.yaml.
 * @returns True if branches were propagated, false if no change needed.
 */
export async function syncBranchesFromState(
  projectDir: string,
  taskId: string,
  queue: TaskQueue,
): Promise<boolean> {
  const statePath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-state.yaml');
  const pipelineState = await readYamlFile<PipelineState>(statePath);

  if (!pipelineState?.branches || pipelineState.branches.length === 0) {
    return false;
  }

  const taskState = await queue.getState(taskId);
  if (!taskState) {
    return false;
  }

  if (branchesEqual(taskState.branches, pipelineState.branches)) {
    return false;
  }

  taskState.branches = pipelineState.branches;
  const tasksStatePath = join(projectDir, '.forjis', 'tasks', taskId, 'state.yaml');
  await writeYamlFile(tasksStatePath, taskState);
  return true;
}

/**
 * Overlays retry state from the health check monitor onto the pipeline plan.
 *
 * Reads the existing pipeline-plan.yaml, sets retryCount and halted fields
 * on matching steps, and writes the updated plan back.
 *
 * @param projectDir - The root directory of the target project.
 * @param taskId - The task identifier.
 * @param retryStates - Map of role name to retry state from the monitor.
 */
export async function syncRetryStateToPlan(
  projectDir: string,
  taskId: string,
  retryStates: ReadonlyMap<string, { retryCount: number; halted: boolean }>,
): Promise<void> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const plan = await readYamlFile<PipelinePlanResponse>(planPath);

  if (!plan?.steps) {
    return;
  }

  for (const step of plan.steps) {
    const retryState = retryStates.get(step.role);
    if (retryState && retryState.retryCount > 0) {
      step.retryCount = retryState.retryCount;
      step.halted = retryState.halted;
    }
  }

  await writeYamlFile(planPath, plan);
}
