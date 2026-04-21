/**
 * Task ID validation module for the facilitator.
 *
 * Re-exports the shared isValidTaskId and adds an assertion variant
 * that throws on invalid IDs for use at internal call boundaries.
 */

export { isValidTaskId } from '@forjis/shared';

/**
 * Pattern that defines a valid task ID (duplicated for error messages).
 *
 * Allows alphanumeric characters, hyphens, and underscores.
 */
const VALID_TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Asserts that a task ID is valid, throwing if it is not.
 *
 * @param taskId - The task ID string to validate.
 * @param context - Optional context string for the error message.
 * @throws {Error} If the task ID does not match the safe pattern.
 */
export function assertValidTaskId(taskId: string, context?: string): void {
  if (!VALID_TASK_ID_PATTERN.test(taskId) || taskId.length === 0) {
    const prefix = context ? `${context}: ` : '';
    throw new Error(
      `${prefix}Invalid task ID "${taskId}". Task IDs must match ${String(VALID_TASK_ID_PATTERN)}.`,
    );
  }
}
