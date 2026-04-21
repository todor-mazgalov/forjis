/**
 * task-card-format — Pure formatting helpers extracted from TaskCard.tsx.
 *
 * No Solid / DOM / CSS-module dependencies — safe to import under plain
 * ts-jest without the Vite toolchain.
 *
 * Requirements: redesign-021 §11 (priority chip compaction).
 */

/**
 * Format a priority value (string or number) into a compact chip label.
 *
 * - Numbers → `P<n>` (e.g. `P1`, `P42`).
 * - `'High'` / `'Medium'` / `'Low'` (case-insensitive, any leading whitespace)
 *   → `'H'` / `'M'` / `'L'`.
 * - Unknown strings → first character uppercased.
 */
export function formatPriorityLabel(priority: string | number): string {
  if (typeof priority === 'number') return `P${priority}`;
  const trimmed = priority.trim().toUpperCase();
  if (trimmed === 'HIGH') return 'H';
  if (trimmed === 'MEDIUM') return 'M';
  if (trimmed === 'LOW') return 'L';
  const first = priority.trim()[0];
  return first !== undefined ? first.toUpperCase() : priority;
}
