/**
 * Personas config file writer.
 *
 * Generates `.forjis/config/personas.yaml` by discovering persona markdown
 * files from the configured directory. Each persona's name is derived from
 * its markdown filename (e.g., `analyst.md` → name `analyst`), making the
 * filename the single source of truth. Optional properties (description,
 * tools, model) are still parsed from YAML frontmatter when present.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { WriterContext, WriteResult } from '../types.js';

/** Cache key used for the personas config file. */
const CACHE_KEY = 'config:personas';

/** Output filename. */
const FILE_NAME = 'personas.yaml';

/** Regex to split YAML frontmatter from markdown body. */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Generates .forjis/config/personas.yaml.
 *
 * Discovers persona markdown files from the configured directory,
 * derives persona names from filenames, parses optional YAML
 * frontmatter (description, tools, model), captures the body as
 * content, and serializes the full list.
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writePersonasConfig(ctx: WriterContext): Promise<WriteResult> {
  const personasDir = ctx.buildConfig.personas?.dir;
  const absDirPath = personasDir ? join(ctx.projectDir, personasDir) : null;

  const sourceHash = absDirPath
    ? await computeDirectoryHash(absDirPath)
    : computeHash('');

  if (!isChanged(CACHE_KEY, sourceHash, ctx.previousCache)) {
    return { file: FILE_NAME, written: false };
  }

  const personas = absDirPath ? await discoverPersonas(absDirPath) : [];
  const data = { dir: personasDir ?? null, personas };
  const content = stringifyYaml(data, { indent: 2 });

  await ensureDir(ctx.configDir);
  await atomicWriteFile(join(ctx.configDir, FILE_NAME), content);

  ctx.cacheEntries[CACHE_KEY] = {
    sourceHash: sourceHash,
    targetPaths: [FILE_NAME],
    generatedAt: new Date().toISOString(),
  };

  return { file: FILE_NAME, written: true };
}

/**
 * Computes a SHA-256 hash from the sorted file names and raw contents
 * of all .md files in a directory. This ensures any file addition,
 * removal, or modification is detected by the checksum cache.
 *
 * @param dirPath - Absolute path to the personas directory.
 * @returns A hex digest representing the directory state.
 */
async function computeDirectoryHash(dirPath: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return computeHash('');
  }

  const mdFiles = entries.filter(f => f.endsWith('.md')).sort();
  const parts: string[] = [];

  for (const file of mdFiles) {
    const content = await readFile(join(dirPath, file), 'utf-8');
    parts.push(`${file}\n${content}`);
  }

  return computeHash(parts.join('\0'));
}

/**
 * Discovers and parses persona markdown files from a directory.
 *
 * Each persona's name is derived from its filename (e.g., `analyst.md`
 * produces the name `analyst`). Any `name` field in the YAML frontmatter
 * is ignored — the filename is the single source of truth.
 *
 * @param dirPath - Absolute path to the personas directory.
 * @returns An array of parsed persona objects.
 */
async function discoverPersonas(
  dirPath: string
): Promise<Record<string, unknown>[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(f => f.endsWith('.md')).sort();
  const personas: Record<string, unknown>[] = [];

  for (const file of mdFiles) {
    const name = derivePersonaName(file);
    const parsed = await parsePersonaFile(join(dirPath, file), name);
    personas.push(parsed);
  }

  return personas;
}

/**
 * Derives the persona name from its markdown filename by stripping the
 * `.md` extension.
 *
 * @param filename - The markdown filename (e.g., `my-assistant.md`).
 * @returns The persona name (e.g., `my-assistant`).
 */
function derivePersonaName(filename: string): string {
  return filename.replace(/\.md$/, '');
}

/**
 * Parses a single persona markdown file with optional YAML frontmatter.
 *
 * The `name` parameter is always used as the persona name, regardless of
 * whether a `name` field exists in the frontmatter. Files without
 * frontmatter are valid — they produce a persona with only a name and
 * the full file content as the body.
 *
 * @param filePath - Absolute path to the markdown file.
 * @param name - The persona name derived from the filename.
 * @returns A parsed persona object.
 */
async function parsePersonaFile(
  filePath: string,
  name: string
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, 'utf-8');
  const match = FRONTMATTER_REGEX.exec(raw);

  if (!match) {
    return { name, description: '', tools: [], model: '', content: raw.trim() };
  }

  const frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  const body = match[2].trim();

  return {
    name,
    description: frontmatter['description'] ?? '',
    tools: frontmatter['tools'] ?? [],
    model: frontmatter['model'] ?? '',
    content: body,
  };
}
