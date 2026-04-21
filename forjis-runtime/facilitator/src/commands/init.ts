/**
 * Init command for @forjis/cli.
 *
 * Scaffolds a new build.forjis file in the project directory with
 * placeholder comments and the minimal required structure.
 */

import { access } from 'node:fs/promises';
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
}
