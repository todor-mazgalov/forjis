/**
 * Unit tests for TaskFileServiceImpl.
 *
 * Tests cover:
 *  - Listing `.md` files in a task directory
 *  - Listing with empty or missing directories
 *  - Filtering out non-`.md` files
 *  - Reading an existing file
 *  - Reading a missing file
 *  - Path traversal protection with `../`
 *  - Path traversal protection with absolute paths
 *
 * Uses a real temp directory on disk for filesystem operations.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskFileServiceImpl } from '../web-services/task-file-service.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'task-file-svc-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Creates the task directory structure and writes files for testing.
 *
 * @param taskId - The task identifier.
 * @param files - Map of filename to content.
 */
async function setupTaskDir(taskId: string, files: Record<string, string>): Promise<void> {
  const taskDir = join(tempDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(taskDir, name), content, 'utf-8');
  }
}

describe('TaskFileServiceImpl', () => {
  describe('listMdFiles', () => {
    test('returns sorted .md filenames from a task directory', async () => {
      await setupTaskDir('task-1', {
        'TASK.md': '# Task',
        'FAILURE.md': '# Failure',
        'NOTES.md': '# Notes',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('task-1');

      expect(files).toEqual(['FAILURE.md', 'NOTES.md', 'TASK.md']);
    });

    test('returns empty array for missing directory', async () => {
      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('nonexistent-task');

      expect(files).toEqual([]);
    });

    test('returns empty array for empty directory', async () => {
      const taskDir = join(tempDir, '.forjis', 'tasks', 'empty-task');
      await mkdir(taskDir, { recursive: true });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('empty-task');

      expect(files).toEqual([]);
    });

    test('filters out non-.md files', async () => {
      await setupTaskDir('task-2', {
        'TASK.md': '# Task',
        'state.yaml': 'status: done',
        'pid': '12345',
        'README.txt': 'hello',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('task-2');

      expect(files).toEqual(['TASK.md']);
    });
  });

  describe('getTaskFileContent', () => {
    test('returns file content for an existing file', async () => {
      await setupTaskDir('task-1', {
        'TASK.md': '# My Task\nSome description',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('task-1', 'TASK.md');

      expect(result).toEqual({ content: '# My Task\nSome description' });
    });

    test('returns null for a missing file', async () => {
      await setupTaskDir('task-1', {
        'TASK.md': '# Task',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('task-1', 'MISSING.md');

      expect(result).toBeNull();
    });

    test('returns null for path traversal with ../', async () => {
      await setupTaskDir('task-1', {
        'TASK.md': '# Task',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('task-1', '../../../etc/passwd');

      expect(result).toBeNull();
    });

    test('returns null for path traversal with absolute path', async () => {
      await setupTaskDir('task-1', {
        'TASK.md': '# Task',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('task-1', '/etc/passwd');

      expect(result).toBeNull();
    });

    test('returns null when task directory does not exist', async () => {
      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('nonexistent', 'TASK.md');

      expect(result).toBeNull();
    });
  });
});
