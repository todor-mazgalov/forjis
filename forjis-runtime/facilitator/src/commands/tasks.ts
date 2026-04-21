/**
 * Task management commands for @forjis/cli.
 *
 * Provides subcommands for managing task lifecycle files:
 * - activate: rename underscore-prefixed tasks to enable them
 * - clean: remove runtime state (.forjis/ and openspec/)
 * - remove: delete non-underscore task files + clean
 * - nuke: delete all task files + clean
 */

import { createInterface } from 'node:readline';
import { readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadBuildFile, parseBuildFile } from '@forjis/resolver';

/**
 * Resolves the absolute tasks directory path from build.forjis.
 *
 * @param projectDir - The project root directory.
 * @param buildFilePath - Path to the build.forjis file.
 * @returns The absolute path to the tasks directory (defaults to './tasks' if not configured).
 */
async function getTasksPath(projectDir: string, buildFilePath: string): Promise<string> {
  const content = await loadBuildFile(buildFilePath);
  const config = parseBuildFile(content);

  return resolve(projectDir, config.tasks?.path ?? 'tasks');
}

/**
 * Lists directory entries, returning an empty array if the directory does not exist.
 */
async function safeReaddir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath) as unknown as string[];
  } catch {
    return [];
  }
}

/**
 * Prompts the user for y/n confirmation before a destructive action.
 *
 * @param action - Description of the action (e.g., "remove", "activate").
 * @param files - List of files that will be affected.
 * @returns True if the user confirms, false otherwise.
 */
async function confirmAction(action: string, files: string[]): Promise<boolean> {
  console.log(`This will ${action} the following ${files.length} file(s):`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('Continue? (y/n) ', resolve);
    });
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * Removes runtime state directories (.forjis/ and openspec/).
 *
 * Uses recursive removal with force to avoid errors on missing dirs.
 *
 * @param projectDir - The project root directory.
 */
async function cleanRuntimeDirs(projectDir: string): Promise<void> {
  const dirs = [
    join(projectDir, '.forjis'),
    join(projectDir, 'openspec'),
  ];

  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Handles the `forjis tasks activate` command.
 *
 * Renames all underscore-prefixed task files by removing the leading underscore.
 *
 * @param projectDir - The project root directory.
 * @param buildFilePath - Path to the build.forjis file.
 * @param force - Skip confirmation prompt when true.
 */
export async function tasksActivateCommand(
  projectDir: string,
  buildFilePath: string,
  force: boolean
): Promise<void> {
  const tasksPath = await getTasksPath(projectDir, buildFilePath);
  const entries = await safeReaddir(tasksPath);
  const underscored = entries.filter((e) => e.startsWith('_'));

  if (underscored.length === 0) {
    console.log('No underscore-prefixed task files found.');
    return;
  }

  if (!force) {
    const confirmed = await confirmAction('activate (rename)', underscored);
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  for (const file of underscored) {
    const oldPath = join(tasksPath, file);
    const newPath = join(tasksPath, file.slice(1));
    await rename(oldPath, newPath);
    console.log(`  ${file} → ${file.slice(1)}`);
  }

  console.log(`Activated ${underscored.length} task(s).`);
}

/**
 * Handles the `forjis tasks clean` command.
 *
 * Removes .forjis/ and openspec/ directories without touching task files.
 *
 * @param projectDir - The project root directory.
 * @param force - Skip confirmation prompt when true.
 */
export async function tasksCleanCommand(
  projectDir: string,
  force: boolean
): Promise<void> {
  const dirs = ['.forjis', 'openspec'];
  const existing: string[] = [];

  for (const dir of dirs) {
    const entries = await safeReaddir(join(projectDir, dir));
    if (entries.length > 0) {
      existing.push(`${dir}/`);
    }
  }

  if (existing.length === 0) {
    console.log('Nothing to clean — .forjis/ and openspec/ are already empty.');
    return;
  }

  if (!force) {
    const confirmed = await confirmAction('clean (remove contents of)', existing);
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  await cleanRuntimeDirs(projectDir);
  console.log('Cleaned .forjis/ and openspec/ directories.');
}

/**
 * Handles the `forjis tasks remove` command.
 *
 * Removes all non-underscore-prefixed task files and performs a clean.
 *
 * @param projectDir - The project root directory.
 * @param buildFilePath - Path to the build.forjis file.
 * @param force - Skip confirmation prompt when true.
 */
export async function tasksRemoveCommand(
  projectDir: string,
  buildFilePath: string,
  force: boolean
): Promise<void> {
  const tasksPath = await getTasksPath(projectDir, buildFilePath);
  const entries = await safeReaddir(tasksPath);
  const toRemove = entries.filter((e) => !e.startsWith('_'));

  if (toRemove.length === 0) {
    console.log('No non-underscore task files found.');
    return;
  }

  if (!force) {
    const confirmed = await confirmAction('remove', toRemove);
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  for (const file of toRemove) {
    await rm(join(tasksPath, file), { recursive: true, force: true });
  }

  await cleanRuntimeDirs(projectDir);
  console.log(`Removed ${toRemove.length} task(s) and cleaned runtime directories.`);
}

/**
 * Handles the `forjis tasks nuke` command.
 *
 * Removes ALL task files (including underscore-prefixed) and performs a clean.
 *
 * @param projectDir - The project root directory.
 * @param buildFilePath - Path to the build.forjis file.
 * @param force - Skip confirmation prompt when true.
 */
export async function tasksNukeCommand(
  projectDir: string,
  buildFilePath: string,
  force: boolean
): Promise<void> {
  const tasksPath = await getTasksPath(projectDir, buildFilePath);
  const entries = await safeReaddir(tasksPath);

  if (entries.length === 0) {
    console.log('No task files found.');
    return;
  }

  if (!force) {
    const confirmed = await confirmAction('nuke (permanently delete)', entries);
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  for (const file of entries) {
    await rm(join(tasksPath, file), { recursive: true, force: true });
  }

  await cleanRuntimeDirs(projectDir);
  console.log(`Nuked ${entries.length} task(s) and cleaned runtime directories.`);
}
