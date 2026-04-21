/**
 * Task ID validation module.
 *
 * Provides functions to validate task identifiers before they are used
 * in file path construction. Prevents path traversal attacks by ensuring
 * task IDs contain only safe characters.
 */

/**
 * Pattern that defines a valid task ID.
 *
 * Allows alphanumeric characters, hyphens, and underscores.
 * Does not allow dots, slashes, or other path-significant characters.
 */
const VALID_TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Checks whether a task ID conforms to the safe character pattern.
 *
 * Valid task IDs contain only alphanumeric characters, hyphens, and
 * underscores. Empty strings and IDs containing dots, slashes, spaces,
 * or other special characters are rejected.
 *
 * @param taskId - The task ID string to validate.
 * @returns True if the task ID is safe for use in file paths.
 */
export function isValidTaskId(taskId: string): boolean {
  if (taskId.length === 0) {
    return false;
  }
  return VALID_TASK_ID_PATTERN.test(taskId);
}
