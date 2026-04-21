/**
 * openspec-tab-utils — Pure helpers extracted from OpenSpecTab.tsx.
 *
 * These functions have no Solid / DOM / fetch dependencies and are safe to
 * import under plain ts-jest without the Vite / JSX / CSS-module toolchain.
 *
 * Requirements: redesign-021 §8 (OpenSpec tab union of task-dir .md files
 * and manifest entries under `openspec/changes/<taskId>/`).
 */

import type { ManifestResponse } from '@forjis/shared';

/**
 * Extract openspec artifact paths from the manifest for the given task.
 * Returns project-relative paths whose prefix matches
 * `openspec/changes/<taskId>/`.
 *
 * @param manifest - The current manifest response, or null.
 * @param taskId - The selected task id.
 */
export function openSpecManifestPaths(
  manifest: ManifestResponse | null,
  taskId: string,
): string[] {
  if (manifest === null) return [];
  const prefix = `openspec/changes/${taskId}/`;
  return manifest.files
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => entry.path);
}

/**
 * Build the unified file list for the OpenSpec tab: task-dir `.md` entries
 * (source `'task'`) merged with manifest openspec entries (source `'project'`).
 *
 * @param taskFiles - Task-dir `.md` file paths (e.g. from `getTaskFiles`), or null.
 * @param manifest - The current manifest response, or null.
 * @param taskId - The selected task id.
 */
export function buildOpenSpecUnion(
  taskFiles: string[] | null,
  manifest: ManifestResponse | null,
  taskId: string,
): Array<{ path: string; source: 'task' | 'project' }> {
  const taskEntries = (taskFiles ?? []).map((path) => ({
    path,
    source: 'task' as const,
  }));
  const projectEntries = openSpecManifestPaths(manifest, taskId).map((path) => ({
    path,
    source: 'project' as const,
  }));
  return [...taskEntries, ...projectEntries];
}
