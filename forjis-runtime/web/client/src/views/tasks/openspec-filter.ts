/**
 * openspec-filter — Pure predicate for filtering openspec artifact paths.
 *
 * Extracted from `FilesTouchedTab.tsx` so the filter rule is unit-testable
 * under plain ts-jest without the Vite / JSX / SolidJS toolchain. The same
 * predicate is imported by both `FilesTouchedTab.tsx` (to exclude openspec
 * entries from the Files-touched list) and the DetailPane badge counter.
 *
 * Requirements covered (redesign-021 §8/9):
 *   - Manifest entries under `openspec/changes/<taskId>/` are surfaced in the
 *     OpenSpec tab, not the Files-touched tab.
 */

/**
 * Return true when a manifest entry's project-relative path belongs to the
 * OpenSpec change artifacts for the given task id.
 *
 * The prefix `openspec/changes/<taskId>/` is matched case-sensitively because
 * both the manifest writer and the project directory structure use lowercase.
 *
 * @param path - Project-relative file path from a manifest entry.
 * @param taskId - The currently selected task id.
 */
export function isOpenSpecEntry(path: string, taskId: string): boolean {
  return path.startsWith(`openspec/changes/${taskId}/`);
}
