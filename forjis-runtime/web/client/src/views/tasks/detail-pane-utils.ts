/**
 * detail-pane-utils — Pure helper functions extracted from DetailPane.tsx.
 *
 * These functions have no Solid / DOM / fetch dependencies and are safe to
 * import under plain ts-jest without the Vite / JSX / CSS-module toolchain.
 * Exporting them here (rather than as module-private closures in the component)
 * means the same logic that runs in production is also the logic under test.
 *
 * Requirements: redesign-021 §6 (auto-select), §13 (tab badge counts),
 * fix-roles-display (structured `{org, team, role}` identity replaces the
 * composite string id and the trailing-segment fuzzy match).
 */

import type {
  ManifestFileEntry,
  ManifestResponse,
  PipelinePlanResponse,
  RoleIdentity,
} from '@forjis/shared';

/**
 * Pure step-picking logic for the auto-select effect (redesign-021 §6/§13).
 *
 * Given a loaded plan, returns the identity triple that should be auto-selected:
 * - First `status === 'running'` step → its `{org, team, role}`.
 * - No running but a non-done/non-skipped step exists → first such step's identity.
 * - All steps done or plan is empty → `null` (leave selection unset).
 */
export function pickAutoSelectStep(plan: PipelinePlanResponse): RoleIdentity | null {
  if (plan.steps.length === 0) return null;
  const running = plan.steps.find((step) => step.status === 'running');
  if (running) return { org: running.org, team: running.team, role: running.role };
  const firstNonDone = plan.steps.find(
    (step) => step.status !== 'done' && step.status !== 'skipped',
  );
  if (firstNonDone === undefined) return null;
  return { org: firstNonDone.org, team: firstNonDone.team, role: firstNonDone.role };
}

/**
 * True when a manifest file entry is the output of the selected step. The
 * manifest `role` field is written by the facilitator as the bare role name
 * — identity matching is therefore narrowed to that single field because the
 * manifest does not (yet) carry org/team for files. The team / org fields on
 * the selection stay in the signature for forward-compatibility: when the
 * manifest gains the triple, the match rule will widen here without touching
 * every caller.
 */
function manifestFileMatchesStep(
  file: ManifestFileEntry,
  selected: RoleIdentity,
): boolean {
  return file.role === selected.role;
}

/**
 * Count Files-touched entries visible for the given task/step combination.
 * Mirrors the filter applied inside FilesTouchedTab: openspec entries are
 * excluded, and entries are optionally narrowed to the `selectedStep`
 * identity triple.
 *
 * @param manifest - The current manifest, or null.
 * @param taskId - The selected task id, or null.
 * @param selectedStep - The currently selected step identity, or null.
 */
export function computeVisibleFilesCount(
  manifest: ManifestResponse | null,
  taskId: string | null,
  selectedStep: RoleIdentity | null,
): number {
  if (manifest === null || taskId === null) return 0;
  return manifest.files.filter((file) => {
    if (file.path.startsWith(`openspec/changes/${taskId}/`)) return false;
    if (selectedStep === null) return true;
    return manifestFileMatchesStep(file, selectedStep);
  }).length;
}

/**
 * Count the OpenSpec entries for the openspec tab badge.
 * The union is: task-dir `.md` files (from `taskFiles`) + manifest entries
 * under `openspec/changes/<taskId>/`.
 *
 * @param manifest - The current manifest, or null.
 * @param taskFiles - The list of task-dir `.md` file paths, or null.
 * @param taskId - The selected task id, or null.
 */
export function computeVisibleOpenSpecCount(
  manifest: ManifestResponse | null,
  taskFiles: string[] | null,
  taskId: string | null,
): number {
  if (taskId === null) return 0;
  const taskDirCount = (taskFiles ?? []).length;
  const manifestCount = (manifest?.files ?? []).filter((file) =>
    file.path.startsWith(`openspec/changes/${taskId}/`),
  ).length;
  return taskDirCount + manifestCount;
}
