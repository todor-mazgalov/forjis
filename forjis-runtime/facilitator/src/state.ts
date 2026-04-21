/**
 * State persistence utilities for @forjis/cli.
 *
 * Provides atomic file writes, directory management, and YAML I/O
 * for the .forjis/ state directory. Atomic writes use a temp-file-then-rename
 * strategy to prevent partial writes on crash.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { CliError } from './errors.js';

/**
 * Ensures a directory exists, creating it recursively if needed.
 *
 * @param dirPath - The absolute path to the directory.
 * @throws {CliError} On permission errors or other filesystem failures.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (err) {
    throw new CliError(
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
 * @throws {CliError} On filesystem failures after cleanup.
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
    throw new CliError(
      `Failed to write "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Atomically writes a binary buffer to a file using a temp-file-then-rename strategy.
 *
 * Mirrors the semantics of {@link atomicWriteFile} for `Buffer` payloads that
 * are not valid UTF-8 text (PNGs, base64-decoded opaque blobs, etc.). Writes
 * to a temporary file first, then renames it to the target path so the target
 * file is never observed in a partially-written state. Cleans up the temp
 * file on failure.
 *
 * @param filePath - The absolute path to the target file.
 * @param data - The binary buffer to write.
 * @throws {CliError} On filesystem failures after cleanup.
 */
export async function atomicWriteFileBinary(filePath: string, data: Buffer): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;

  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* Temp file may not exist if writeFile failed; ignore cleanup error */
    }
    throw new CliError(
      `Failed to write "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Reads and parses a YAML file from disk.
 *
 * Returns null if the file does not exist, allowing callers to
 * treat missing state files as "not yet created".
 *
 * @param filePath - The absolute path to the YAML file.
 * @returns The parsed YAML content, or null if the file is missing.
 * @throws {CliError} On parse errors for files that do exist.
 */
export async function readYamlFile<T>(filePath: string): Promise<T | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  try {
    return parseYaml(content) as T;
  } catch (err) {
    throw new CliError(
      `Failed to parse YAML at "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Atomically writes an object as YAML to a file.
 *
 * Serializes the data to YAML format, then uses atomicWriteFile for
 * crash-safe persistence.
 *
 * @param filePath - The absolute path to the target YAML file.
 * @param data - The object to serialize and write.
 */
export async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
  const yaml = stringifyYaml(data, { indent: 2 });
  await atomicWriteFile(filePath, yaml);
}
