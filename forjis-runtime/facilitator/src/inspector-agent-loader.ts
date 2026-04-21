/**
 * Loader for the Forjis Inspector clarifier agent.
 *
 * Resolves the agent markdown file (default: bundled
 * `assets/forjis-inspector.md`; override: `inspector.clarifier` from the
 * resolved RuntimeConfig) and parses its YAML frontmatter + markdown body
 * into a normalised {@link ClarifierAgent} ready for the engine subprocess
 * machinery to spawn.
 *
 * This module is intentionally pure file I/O + parsing — no engine
 * coupling, no networking, no persistence. The clarifier subprocess is
 * wired up in inspector-005-clarifier-orchestration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

/**
 * Inspector configuration block as carried on `RuntimeConfig.inspector`.
 *
 * Re-declared here (rather than imported from `@forjis/resolver`) so the
 * loader stays usable in test scaffolds that don't construct a full
 * runtime config.
 */
export interface ClarifierAgentConfig {
  /**
   * Optional clarifier override. When set, treated as either an absolute
   * path or a path relative to {@link configDir}. When omitted, the
   * bundled default is used.
   */
  clarifier?: string;
}

/**
 * A parsed clarifier agent ready for engine invocation.
 */
export interface ClarifierAgent {
  /** Frontmatter `name`, e.g. `"forjis-inspector"`. */
  name: string;
  /** Frontmatter `description`. */
  description: string;
  /** Frontmatter `model`, e.g. `"sonnet"`. */
  model: string;
  /** Frontmatter `tools` normalised to a string array. */
  tools: string[];
  /** Markdown body (after frontmatter), trimmed. Always non-empty. */
  body: string;
  /** Absolute filesystem path the agent was loaded from. */
  sourcePath: string;
}

/**
 * Bundled default agent path, anchored to this loader's compiled location.
 * After `tsc`, this file lives at
 * `forjis-runtime/facilitator/dist/inspector-agent-loader.js`, so
 * `../assets/forjis-inspector.md` lands on the bundled asset shipped via
 * `package.json#files`.
 */
const BUNDLED_DEFAULT = fileURLToPath(
  new URL('../assets/forjis-inspector.md', import.meta.url)
);

/**
 * Resolve the agent file path the loader will read.
 *
 * Resolution order:
 *
 * 1. {@link config.clarifier} when provided — absolute paths are used
 *    as-is; relative paths resolve against {@link configDir}.
 * 2. The bundled `assets/forjis-inspector.md` shipped inside
 *    `@forjis/facilitator`.
 *
 * @param config - Optional inspector config block from `RuntimeConfig.inspector`.
 * @param configDir - Optional `.forjis/config/` directory used to anchor
 *                    relative override paths.
 * @returns Absolute filesystem path to the agent markdown file.
 * @throws When the override path is set but does not exist on disk, or
 *         when no override is set and the bundled asset is missing.
 */
export function getDefaultClarifierPath(
  config?: ClarifierAgentConfig,
  configDir?: string
): string {
  if (config?.clarifier !== undefined && config.clarifier !== '') {
    const override = config.clarifier;
    const resolved = isAbsolute(override)
      ? override
      : resolvePath(configDir ?? process.cwd(), override);

    if (!existsSync(resolved)) {
      throw new Error(
        `Inspector clarifier override not found at "${resolved}" ` +
          `(resolved from inspector.clarifier="${override}").`
      );
    }
    return resolved;
  }

  if (!existsSync(BUNDLED_DEFAULT)) {
    throw new Error(
      `Bundled clarifier agent not found at "${BUNDLED_DEFAULT}". ` +
        `The @forjis/facilitator package may be installed without its ` +
        `assets/ directory. Set inspector.clarifier in build.forjis to ` +
        `point at a custom agent file.`
    );
  }

  return BUNDLED_DEFAULT;
}

/**
 * Read and parse the clarifier agent file into a {@link ClarifierAgent}.
 *
 * @param config - Optional inspector config block from `RuntimeConfig.inspector`.
 * @param configDir - Optional `.forjis/config/` directory.
 * @returns The parsed agent.
 * @throws When the file is missing, the frontmatter delimiter is missing,
 *         the YAML inside the frontmatter is malformed, any required
 *         frontmatter key is absent, or the body is empty.
 */
export function loadClarifierAgent(
  config?: ClarifierAgentConfig,
  configDir?: string
): ClarifierAgent {
  const sourcePath = getDefaultClarifierPath(config, configDir);
  const raw = readFileSync(sourcePath, 'utf-8');

  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `Clarifier agent at "${sourcePath}" is missing a YAML frontmatter ` +
        `block (expected leading "---\\n...\\n---\\n").`
    );
  }

  const [, frontmatterText, bodyText] = match;

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('frontmatter is not a YAML mapping');
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Clarifier agent at "${sourcePath}" has invalid YAML frontmatter: ${reason}`
    );
  }

  const name = requireStringField(frontmatter, 'name', sourcePath);
  const description = requireStringField(frontmatter, 'description', sourcePath);
  const model = requireStringField(frontmatter, 'model', sourcePath);
  const tools = normaliseTools(frontmatter['tools'], sourcePath);

  const body = bodyText.trim();
  if (body.length === 0) {
    throw new Error(
      `Clarifier agent at "${sourcePath}" has an empty body after the frontmatter.`
    );
  }

  return { name, description, model, tools, body, sourcePath };
}

/**
 * Asserts that a frontmatter key is present and is a non-empty string.
 */
function requireStringField(
  frontmatter: Record<string, unknown>,
  key: string,
  sourcePath: string
): string {
  const value = frontmatter[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Clarifier agent at "${sourcePath}" is missing required frontmatter field "${key}".`
    );
  }
  return value;
}

/**
 * Normalises the `tools` frontmatter field into a string array.
 *
 * Accepts YAML array form (`[Read, Write, Glob]`) or a comma-separated
 * string (`"Read, Write, Glob"`). Empty results are rejected.
 */
function normaliseTools(value: unknown, sourcePath: string): string[] {
  if (Array.isArray(value)) {
    const items = value.map((entry) => String(entry).trim()).filter((s) => s.length > 0);
    if (items.length === 0) {
      throw new Error(
        `Clarifier agent at "${sourcePath}" has an empty tools array.`
      );
    }
    return items;
  }

  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      throw new Error(
        `Clarifier agent at "${sourcePath}" has an empty tools list.`
      );
    }
    return items;
  }

  throw new Error(
    `Clarifier agent at "${sourcePath}" is missing required frontmatter field "tools".`
  );
}
