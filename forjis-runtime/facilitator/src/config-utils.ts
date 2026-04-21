/**
 * Shared configuration utilities for @forjis/facilitator commands.
 */

/**
 * Reads just the engine name from build.forjis without full parsing.
 *
 * Uses the resolver's build file parsing to extract the engine field.
 *
 * @param buildFilePath - Absolute path to the build.forjis file.
 * @returns The engine name string (defaults to 'claude').
 */
export async function readEngineFromConfig(buildFilePath: string): Promise<string> {
  const { loadBuildFile, parseBuildFile } = await import('@forjis/resolver');
  const content = await loadBuildFile(buildFilePath);
  const config = parseBuildFile(content);
  return config.engine ?? 'claude';
}
