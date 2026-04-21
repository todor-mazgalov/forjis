/**
 * Registry commands for @forjis/cli.
 *
 * Provides `registry list` to display all available resources grouped
 * by type, and `registry add` to append a new repository entry to
 * the build file.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolveRepositories, loadBuildFile, parseBuildFile } from '@forjis/resolver';

import { BuildFileNotFoundError } from '../errors.js';

/**
 * Handles the `forjis registry list` command.
 *
 * Loads the build file, resolves repositories, and prints all
 * available resources grouped by type. Shows namespace prefixes
 * where naming conflicts exist.
 *
 * @param buildFilePath - Path to the build.forjis file.
 */
export async function registryListCommand(buildFilePath: string): Promise<void> {
  const content = await loadBuildFile(buildFilePath);
  const config = parseBuildFile(content);
  const { registry } = await resolveRepositories(config.repositories);

  const conflicts = registry.getConflicts();
  const types = ['agent', 'skill', 'hook', 'plugin'] as const;

  for (const type of types) {
    const entries = registry.listByType(type);
    if (entries.length === 0) {
      continue;
    }

    console.log(`\n${type.toUpperCase()}S:`);
    for (const entry of entries) {
      const conflictKey = `${type}:${entry.name}`;
      const needsPrefix = conflicts.has(conflictKey);
      const displayName = needsPrefix ? `${entry.repoName}:${entry.name}` : entry.name;
      console.log(`  ${displayName}  (from ${entry.repoName})`);
    }
  }
}

/**
 * Handles the `forjis registry add <urlOrPath>` command.
 *
 * Determines if the input is a git URL or local directory path,
 * reads the existing build file, appends the appropriate repository
 * entry, and writes it back.
 *
 * @param buildFilePath - Path to the build.forjis file.
 * @param urlOrPath - A git URL or local directory path to add.
 * @throws {BuildFileNotFoundError} If the build file does not exist.
 */
export async function registryAddCommand(
  buildFilePath: string,
  urlOrPath: string
): Promise<void> {
  let rawContent: string;
  try {
    rawContent = await readFile(buildFilePath, 'utf-8');
  } catch {
    throw new BuildFileNotFoundError(buildFilePath);
  }

  const isGit = urlOrPath.startsWith('http://') ||
    urlOrPath.startsWith('https://') ||
    urlOrPath.startsWith('git@');

  let entry: string;
  if (isGit) {
    entry = `  - type: git\n    url: "${urlOrPath}"\n    ref: "main"`;
  } else {
    entry = `  - type: dir\n    path: "${urlOrPath}"`;
  }

  const reposMatch = rawContent.match(/^repositories:\s*$/m);
  if (reposMatch) {
    const insertPos = rawContent.indexOf('\n', rawContent.indexOf('repositories:')) + 1;
    rawContent = rawContent.slice(0, insertPos) + entry + '\n' + rawContent.slice(insertPos);
  } else {
    rawContent += `\nrepositories:\n${entry}\n`;
  }

  await writeFile(buildFilePath, rawContent, 'utf-8');
  console.log(`Added ${isGit ? 'git' : 'dir'} repository: ${urlOrPath}`);
}
