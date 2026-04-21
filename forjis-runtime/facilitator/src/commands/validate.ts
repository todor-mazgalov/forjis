/**
 * Validate command for @forjis/cli.
 *
 * Runs the full resolver pipeline to verify that the build file, repositories,
 * and plugins are all valid. Reports success or the first error encountered.
 */

import { resolve as resolveConfig } from '@forjis/resolver';
import { dirname } from 'node:path';

/**
 * Handles the `forjis validate` command.
 *
 * Delegates to @forjis/resolver to run the full resolution pipeline.
 * If any step fails (build file parsing, repository resolution, plugin
 * loading, config generation), the error propagates to the caller.
 *
 * @param buildFilePath - Path to the build.forjis file.
 * @throws {Error} Re-throws the first error encountered during validation.
 */
export async function validateCommand(buildFilePath: string): Promise<void> {
  const projectDir = dirname(buildFilePath);
  await resolveConfig(buildFilePath, { projectDir });
  console.log('Validation passed');
}
