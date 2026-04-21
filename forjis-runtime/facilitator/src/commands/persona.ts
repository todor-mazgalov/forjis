/**
 * Persona command handlers for @forjis/cli.
 *
 * Provides three commands:
 * - `personaCreateCommand`: scaffolds a new persona markdown file.
 * - `personaRunCommand`: delegates persona execution to the orchestrator
 *   via engine.invoke() with mode 'persona'.
 * - `personaGenerateCommand`: delegates persona generation to the orchestrator
 *   via engine.invoke() with mode 'persona' and generate modeArgs.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolve as resolveConfig } from '@forjis/resolver';

import { readEngineFromConfig } from '../config-utils.js';
import { loadEngine } from '../engine.js';
import { CliError } from '../errors.js';
import { readYamlFile } from '../state.js';

/**
 * Creates a new persona markdown file in the configured personas directory.
 *
 * Resolves configuration first to ensure .forjis/config/ exists, then reads
 * the personas directory from .forjis/config/personas.yaml and scaffolds
 * a template file.
 *
 * @param cwd - Current working directory (project root).
 * @param buildFilePath - Path to the build.forjis file.
 * @param name - Name of the persona to create.
 * @throws {CliError} If personas config is not found.
 * @throws {CliError} If persona file already exists.
 */
export async function personaCreateCommand(
  cwd: string,
  buildFilePath: string,
  name: string
): Promise<void> {
  await resolveConfig(buildFilePath, { projectDir: cwd });

  const personasConfig = await readYamlFile<{ dir: string }>(
    join(cwd, '.forjis', 'config', 'personas.yaml')
  );

  if (!personasConfig) {
    throw new CliError('Personas config not found. Ensure personas block is configured in build.forjis');
  }

  const personasDir = resolve(cwd, personasConfig.dir);
  const filePath = join(personasDir, `${name}.md`);

  if (await fileExists(filePath)) {
    throw new CliError(`Persona file already exists: ${filePath}`);
  }

  await mkdir(personasDir, { recursive: true });

  const template = buildPersonaTemplate(name);
  await writeFile(filePath, template, 'utf-8');
  console.log(`Created persona: ${filePath}`);
}

/**
 * Executes one or more persona agents by delegating to the orchestrator.
 *
 * Resolves configuration via @forjis/resolver, loads the engine, and invokes
 * with mode 'persona'. All prompt composition and persona discovery is handled
 * by the orchestrator.
 *
 * @param cwd - Current working directory (project root).
 * @param buildFilePath - Path to the build.forjis file.
 * @param names - Comma-separated persona names, or null to run all.
 */
export async function personaRunCommand(
  cwd: string,
  buildFilePath: string,
  names: string | null
): Promise<void> {
  const configResult = await resolveConfig(buildFilePath, { projectDir: cwd });

  const engineName = await readEngineFromConfig(buildFilePath);
  const engine = await loadEngine(engineName);

  console.log('[personas]: delegating to orchestrator...');
  await engine.invoke({
    projectDir: cwd,
    taskId: 'persona',
    taskDescription: names
      ? `Run personas: ${names}`
      : 'Run all personas',
    configDir: configResult.configDir,
    mode: 'persona',
    modeArgs: names ? { names } : undefined,
    dryRun: false,
  });
}

/**
 * Generates a new persona file by delegating to the orchestrator.
 *
 * Resolves configuration via @forjis/resolver, loads the engine, and invokes
 * with mode 'persona' and generate-specific modeArgs. All prompt composition,
 * question generation, and file writing is handled by the orchestrator.
 *
 * @param cwd - Current working directory (project root).
 * @param buildFilePath - Path to the build.forjis file.
 * @param description - Natural-language description of the persona to generate.
 * @param interactive - Whether the orchestrator should ask clarifying questions before generating.
 * @throws {CliError} If personas config is not found or dir is not configured.
 */
export async function personaGenerateCommand(
  cwd: string,
  buildFilePath: string,
  description: string,
  interactive: boolean
): Promise<void> {
  const configResult = await resolveConfig(buildFilePath, { projectDir: cwd });

  const personasConfig = await readYamlFile<{ dir: string | null }>(
    join(cwd, '.forjis', 'config', 'personas.yaml')
  );

  if (!personasConfig) {
    throw new CliError('Personas config not found. Ensure personas block is configured in build.forjis');
  }

  if (!personasConfig.dir) {
    throw new CliError('Personas directory not configured. Add a personas block with dir field to build.forjis.');
  }

  const engineName = await readEngineFromConfig(buildFilePath);
  const engine = await loadEngine(engineName);

  console.log('[persona-generate]: delegating to orchestrator...');
  await engine.invoke({
    projectDir: cwd,
    taskId: 'persona-generate',
    taskDescription: `Generate persona: ${description}`,
    configDir: configResult.configDir,
    mode: 'persona',
    modeArgs: {
      generate: true,
      description,
      ...(interactive ? { interactive: true } : {}),
    },
    dryRun: false,
  });
}

// -- Internal helpers --------------------------------------------------------

/**
 * Generates the scaffold template for a new persona markdown file.
 *
 * @param name - The persona name for the heading.
 * @returns The template markdown string.
 */
function buildPersonaTemplate(name: string): string {
  return `# ${name}

## Background
<!-- Who is this persona? What is their role and experience level? -->

## Product Access
<!-- How does this persona access the product? CLI commands, URLs, etc. -->

## Documentation
<!-- Paths to documentation files this persona should read -->

## Testing Process
<!-- What does this persona test? Step-by-step scenarios to execute -->

## Success Criteria
<!-- What outcomes indicate the product is working correctly? -->
`;
}

/**
 * Checks whether a file exists on disk.
 *
 * @param filePath - Absolute path to the file.
 * @returns True if the file exists, false otherwise.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
