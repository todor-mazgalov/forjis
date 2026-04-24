/**
 * Init command for @forjis/cli.
 *
 * Scaffolds a new build.forjis file in the project directory with
 * placeholder comments and the minimal required structure. Also
 * idempotently appends `.forjis/context/` to the project's root
 * `.gitignore` so the file-level context index stays out of VCS
 * (spec R10).
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CliError } from '../errors.js';
import { atomicWriteFile } from '../state.js';

/** Default scaffold content for a new build.forjis file. */
const SCAFFOLD = `# build.forjis — Forjis build configuration
version: 1

# Repositories: sources for agents, skills, hooks, and plugins
repositories:
  # - type: git
  #   url: "https://github.com/org/forjis-resources.git"
  #   ref: v1.0
  # - type: dir
  #   path: "./local-resources"

# Plugins: apply pre-built workflow definitions
# plugins:
#   - name: software-dev

# Tasks: configure task ingestion
# tasks:
#   source: dir
#   path: "./tasks"
#   poll_interval: 30s

# Outcome: configure assessment rules
# outcome:
#   enabled: true
#   rules:
#     - fail: "completeness < 80"
#       action: retry
#       max_retries: 2

# Personas: configure end-user persona testing
# personas:
#   dir: "./personas"
`;

/**
 * Handles the `forjis init` command.
 *
 * Creates a build.forjis scaffold in the specified directory. Refuses
 * to overwrite an existing file.
 *
 * @param cwd - The directory to create the build file in.
 * @throws {CliError} If build.forjis already exists.
 */
export async function initCommand(cwd: string): Promise<void> {
  const filePath = join(cwd, 'build.forjis');

  try {
    await access(filePath);
    throw new CliError(`build.forjis already exists at ${filePath}`);
  } catch (err) {
    if (err instanceof CliError) {
      throw err;
    }
    /* File does not exist — proceed to create it */
  }

  await atomicWriteFile(filePath, SCAFFOLD);
  console.log(`Created build.forjis at ${filePath}`);

  await ensureGitignoreEntry(cwd, '.forjis/context/');
}

/**
 * Ensures the target project's `.gitignore` contains the given line.
 *
 * Behaviour:
 *   - Missing `.gitignore` → create with `<line>\n`.
 *   - Present + already contains a line whose trimmed content equals
 *     `line` → no-op (silent, no log).
 *   - Present + missing → append `\n<line>\n` (preserves existing
 *     bytes; extra leading newline guards against no-trailing-newline
 *     files).
 *
 * The presence of broader entries (e.g. `.forjis/` or `.forjis/*`)
 * does NOT suppress the explicit append (spec R10).
 *
 * @param projectDir - The target project directory.
 * @param line - The literal line to ensure (without trailing newline).
 */
export async function ensureGitignoreEntry(
  projectDir: string,
  line: string,
): Promise<void> {
  const gitignorePath = join(projectDir, '.gitignore');
  let existing: string | null;
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    existing = null;
  }

  if (existing === null) {
    await atomicWriteFile(gitignorePath, `${line}\n`);
    console.log(`[init]: added ${line} to .gitignore`);
    return;
  }

  const alreadyPresent = existing
    .split('\n')
    .some((l) => l.trim() === line);
  if (alreadyPresent) {
    return;
  }

  const needsLeadingNewline =
    existing.length > 0 && !existing.endsWith('\n');
  const appended =
    existing + (needsLeadingNewline ? '\n' : '') + `${line}\n`;
  await atomicWriteFile(gitignorePath, appended);
  console.log(`[init]: added ${line} to .gitignore`);
}
