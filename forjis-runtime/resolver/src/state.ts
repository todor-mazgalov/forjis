/**
 * State persistence utilities for @forjis/resolver.
 *
 * Provides atomic file writes and directory management for the .forjis/
 * state directory. Atomic writes use a temp-file-then-rename strategy
 * to prevent partial writes on crash.
 */

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { ResolverError } from './errors.js';

/**
 * Ensures a directory exists, creating it recursively if needed.
 *
 * @param dirPath - The absolute path to the directory.
 * @throws {ResolverError} On permission errors or other filesystem failures.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (err) {
    throw new ResolverError(
      `Failed to create directory "${dirPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Atomically writes content to a file using a temp-file-then-rename strategy.
 *
 * Writes to a temporary file first, then renames it to the target path.
 * This ensures the target file is never in a partially-written state.
 * If the rename fails, the temp file is cleaned up.
 *
 * @param filePath - The absolute path to the target file.
 * @param content - The string content to write.
 * @throws {ResolverError} On filesystem failures after cleanup.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;

  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* Temp file may not exist if writeFile failed; ignore cleanup error */
    }
    throw new ResolverError(
      `Failed to write "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
