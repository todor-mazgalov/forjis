/**
 * Task file service implementation for the web dashboard backend.
 *
 * Implements the TaskFileService interface by listing and reading `.md` files
 * from the `.forjis/tasks/<taskId>/` directory on disk. Includes path traversal
 * protection via resolve-and-prefix checking to ensure only files within the
 * allowed task directory are served.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { TaskFileService } from '@forjis/shared';

/**
 * Implements TaskFileService by reading files from the `.forjis/tasks/` directory tree.
 *
 * Reads files from `<projectDir>/.forjis/tasks/<taskId>/`.
 * All paths are validated against the base directory to prevent traversal attacks.
 */
export class TaskFileServiceImpl implements TaskFileService {
  /**
   * Creates a TaskFileServiceImpl.
   *
   * @param projectDir - The root project directory containing the `.forjis` folder.
   */
  constructor(private readonly projectDir: string) {}

  /**
   * Lists `.md` files in a task's directory.
   *
   * Uses `readdir` to enumerate files in `<projectDir>/.forjis/tasks/<taskId>/`,
   * filters to only `.md` extensions, and returns them sorted alphabetically.
   * Returns an empty array if the directory does not exist or cannot be read.
   *
   * @param taskId - The task identifier (used as directory name).
   * @returns Sorted array of `.md` filenames found in the task directory.
   */
  async listMdFiles(taskId: string): Promise<string[]> {
    const taskDir = join(this.projectDir, '.forjis', 'tasks', taskId);

    try {
      const entries = await readdir(taskDir);
      return entries
        .filter((name) => name.endsWith('.md'))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Returns the text content of a file within a task's directory.
   *
   * Constructs the allowed base as `<projectDir>/.forjis/tasks/<taskId>`,
   * resolves the full path, and verifies it stays within the base directory.
   * Returns null for path traversal attempts and missing files.
   *
   * @param taskId - The task identifier (used as directory name).
   * @param filename - The filename to read within the task directory.
   * @returns The file content wrapped in a JSON envelope, or null if not found or disallowed.
   */
  async getTaskFileContent(taskId: string, filename: string): Promise<{ content: string } | null> {
    const base = join(this.projectDir, '.forjis', 'tasks', taskId);
    const fullPath = resolve(base, filename);

    if (!fullPath.startsWith(base + sep) && fullPath !== base) {
      return null;
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      return { content };
    } catch {
      return null;
    }
  }
}
