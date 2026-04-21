/**
 * Tests for task ID validation functions.
 *
 * Verifies that isValidTaskId and assertValidTaskId correctly accept
 * safe task IDs and reject IDs containing path traversal sequences
 * or other unsafe characters.
 */

import { isValidTaskId, assertValidTaskId } from '../task-id.js';

describe('isValidTaskId', () => {
  it('accepts simple alphanumeric IDs', () => {
    expect(isValidTaskId('my-task')).toBe(true);
    expect(isValidTaskId('fix-bug-123')).toBe(true);
    expect(isValidTaskId('TASK_1')).toBe(true);
    expect(isValidTaskId('a')).toBe(true);
  });

  it('accepts IDs with hyphens and underscores', () => {
    expect(isValidTaskId('task-id-unsanitized-in-event-filenames')).toBe(true);
    expect(isValidTaskId('my_task_id')).toBe(true);
    expect(isValidTaskId('a-b_c-d')).toBe(true);
  });

  it('accepts generated task IDs', () => {
    expect(isValidTaskId('task-1711929600000-a1b2c3d4')).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isValidTaskId('')).toBe(false);
  });

  it('rejects IDs with dots', () => {
    expect(isValidTaskId('task.md')).toBe(false);
    expect(isValidTaskId('..hidden')).toBe(false);
    expect(isValidTaskId('a.b')).toBe(false);
  });

  it('rejects path traversal sequences', () => {
    expect(isValidTaskId('../..')).toBe(false);
    expect(isValidTaskId('../../etc/passwd')).toBe(false);
    expect(isValidTaskId('..\\..\\windows')).toBe(false);
  });

  it('rejects IDs with slashes', () => {
    expect(isValidTaskId('path/to/task')).toBe(false);
    expect(isValidTaskId('path\\to\\task')).toBe(false);
  });

  it('rejects IDs with spaces', () => {
    expect(isValidTaskId('my task')).toBe(false);
    expect(isValidTaskId(' leading')).toBe(false);
  });

  it('rejects IDs with special characters', () => {
    expect(isValidTaskId('task@1')).toBe(false);
    expect(isValidTaskId('task#1')).toBe(false);
    expect(isValidTaskId('task$1')).toBe(false);
    expect(isValidTaskId('task;rm -rf')).toBe(false);
  });
});

describe('assertValidTaskId', () => {
  it('does not throw for valid IDs', () => {
    expect(() => assertValidTaskId('my-task')).not.toThrow();
    expect(() => assertValidTaskId('fix-123')).not.toThrow();
  });

  it('throws for invalid IDs', () => {
    expect(() => assertValidTaskId('../../etc')).toThrow(/Invalid task ID/);
    expect(() => assertValidTaskId('')).toThrow(/Invalid task ID/);
  });

  it('includes context in error message when provided', () => {
    expect(() => assertValidTaskId('../bad', 'processEntry')).toThrow(
      /processEntry: Invalid task ID/,
    );
  });
});
