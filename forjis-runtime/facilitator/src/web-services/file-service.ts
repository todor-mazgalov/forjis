/**
 * File content service implementation for the web dashboard backend.
 *
 * Implements the FileService interface by reading OpenSpec change artifact
 * files from disk. Includes path traversal protection via resolve-and-prefix
 * checking to ensure only files within the allowed change directory are served.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FileService } from '@forjis/shared';

/**
 * Implements FileService by reading files from the OpenSpec changes directory.
 *
 * Reads files from `<projectDir>/openspec/changes/<taskId>/<relativePath>`.
 * All paths are validated against the base directory to prevent traversal attacks.
 */
export class FileServiceImpl implements FileService {
  /**
   * Creates a FileServiceImpl.
   *
   * @param projectDir - The root project directory containing the openspec folder.
   */
  constructor(private readonly projectDir: string) {}

  /**
   * Returns the text content of a file within a task's change directory.
   *
   * Constructs the allowed base as `<projectDir>/openspec/changes/<taskId>`,
   * resolves the full path, and verifies it starts with `base + sep`.
   * Returns null for path traversal attempts and missing files.
   *
   * @param taskId - The task identifier (used as directory name).
   * @param relativePath - The relative file path within the change directory.
   * @returns The file content wrapped in a JSON envelope, or null if not found or disallowed.
   */
  async getFileContent(taskId: string, relativePath: string): Promise<{ content: string } | null> {
    const base = join(this.projectDir, 'openspec', 'changes', taskId);
    const fullPath = resolve(base, relativePath);

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

  /**
   * Returns the text content of a file by project-relative path.
   *
   * Resolves the path against the project root directory. Includes
   * traversal protection to ensure the resolved path stays within
   * the project directory boundary.
   *
   * @param projectPath - The project-relative path to the file.
   * @returns The file content wrapped in a JSON envelope, or null if not found or disallowed.
   */
  async getFileByProjectPath(projectPath: string): Promise<{ content: string } | null> {
    const normalizedBase = resolve(this.projectDir);
    const fullPath = resolve(this.projectDir, projectPath);

    if (!fullPath.startsWith(normalizedBase + sep) && fullPath !== normalizedBase) {
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
