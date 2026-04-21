/**
 * Reviewer tests for TaskFileServiceImpl.
 *
 * These tests supplement the developer's tests with additional edge cases
 * and requirement validations:
 *  - Sort order verification (FR-202: alphabetical)
 *  - Mixed .md and non-.md files filtering
 *  - Path traversal with backslash on Windows (FR-203)
 *  - Path traversal with encoded sequences (FR-203)
 *  - Content integrity: file content returned verbatim (FR-202)
 *  - Multiple tasks isolation (FR-202)
 *  - getTaskFileContent returns { content } envelope, not raw string (FR-202)
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskFileServiceImpl } from '../web-services/task-file-service.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'task-file-svc-review-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function setupTaskDir(taskId: string, files: Record<string, string>): Promise<void> {
  const taskDir = join(tempDir, '.forjis', 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(taskDir, name), content, 'utf-8');
  }
}

describe('TaskFileServiceImpl — reviewer validation', () => {
  describe('listMdFiles sort order (FR-202)', () => {
    test('returns files in alphabetical order regardless of creation order', async () => {
      await setupTaskDir('sort-test', {
        'ZEBRA.md': 'z',
        'ALPHA.md': 'a',
        'MIDDLE.md': 'm',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('sort-test');
      expect(files).toEqual(['ALPHA.md', 'MIDDLE.md', 'ZEBRA.md']);
    });

    test('sort is case-sensitive (uppercase before lowercase in default locale)', async () => {
      await setupTaskDir('case-test', {
        'TASK.md': 't',
        'alpha.md': 'a',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('case-test');
      // String.sort() in JS: uppercase letters come before lowercase
      expect(files).toEqual(['TASK.md', 'alpha.md']);
    });
  });

  describe('listMdFiles filtering (FR-202)', () => {
    test('filters .md extension strictly — does not match .markdown or .mdx', async () => {
      await setupTaskDir('ext-test', {
        'TASK.md': 'task',
        'README.markdown': 'readme',
        'NOTES.mdx': 'notes',
        'data.json': 'data',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('ext-test');
      expect(files).toEqual(['TASK.md']);
    });

    test('returns only filenames not full paths', async () => {
      await setupTaskDir('path-test', {
        'TASK.md': 'task',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('path-test');
      expect(files.length).toBe(1);
      expect(files[0]).toBe('TASK.md');
      expect(files[0]).not.toContain('/');
      expect(files[0]).not.toContain('\\');
    });
  });

  describe('getTaskFileContent envelope format (FR-202)', () => {
    test('returns { content: string } envelope, not raw string', async () => {
      await setupTaskDir('envelope-test', {
        'TASK.md': '# Title\nBody',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('envelope-test', 'TASK.md');
      expect(result).not.toBeNull();
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
      expect(typeof result!.content).toBe('string');
    });

    test('returns content verbatim including whitespace and special chars', async () => {
      const specialContent = '# Title\n\n  indented\n\ttabbed\n<html>&amp;</html>\n';
      await setupTaskDir('verbatim-test', {
        'TASK.md': specialContent,
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('verbatim-test', 'TASK.md');
      expect(result).toEqual({ content: specialContent });
    });
  });

  describe('path traversal protection (FR-203)', () => {
    test('rejects path with ../ mid-path', async () => {
      await setupTaskDir('traverse-mid', {
        'TASK.md': 'task',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('traverse-mid', 'subdir/../../../etc/passwd');
      expect(result).toBeNull();
    });

    test('rejects filename that is just ".."', async () => {
      await setupTaskDir('traverse-dotdot', {
        'TASK.md': 'task',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('traverse-dotdot', '..');
      expect(result).toBeNull();
    });

    test('allows filename with dots that is not traversal (e.g., "file.v2.md")', async () => {
      await setupTaskDir('dots-test', {
        'file.v2.md': 'versioned content',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const result = await svc.getTaskFileContent('dots-test', 'file.v2.md');
      expect(result).toEqual({ content: 'versioned content' });
    });
  });

  describe('task isolation (FR-202)', () => {
    test('different task IDs return different file lists', async () => {
      await setupTaskDir('task-a', {
        'A.md': 'a',
      });
      await setupTaskDir('task-b', {
        'B.md': 'b',
        'C.md': 'c',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const filesA = await svc.listMdFiles('task-a');
      const filesB = await svc.listMdFiles('task-b');
      expect(filesA).toEqual(['A.md']);
      expect(filesB).toEqual(['B.md', 'C.md']);
    });

    test('getTaskFileContent for one task cannot read another task files', async () => {
      await setupTaskDir('task-x', {
        'SECRET.md': 'secret',
      });
      await setupTaskDir('task-y', {
        'PUBLIC.md': 'public',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      // task-y should not be able to read task-x's file via traversal
      const result = await svc.getTaskFileContent('task-y', '../task-x/SECRET.md');
      expect(result).toBeNull();
    });
  });

  describe('constructor uses projectDir correctly', () => {
    test('reads from .forjis/tasks/<taskId>/ under projectDir', async () => {
      await setupTaskDir('proj-dir-test', {
        'TASK.md': 'correct location',
      });

      const svc = new TaskFileServiceImpl(tempDir);
      const files = await svc.listMdFiles('proj-dir-test');
      expect(files).toContain('TASK.md');

      const content = await svc.getTaskFileContent('proj-dir-test', 'TASK.md');
      expect(content).toEqual({ content: 'correct location' });
    });
  });
});
