/**
 * Hand-rolled YAML frontmatter parser for `.forjis/exploration/*.md`.
 *
 * Kept module-local so the context-cache module owns a deterministic
 * parse surface without pulling in gray-matter (design.md §Common
 * Mandatory Constraints — no new deps when `yaml` is already present).
 *
 * Supports the 4-field (legacy) frontmatter
 * (`status`, `createdAt`, `taskId`, `taskSummary`) plus the
 * post-cache-harden additions (`files_touched`, `invalidatedAt`,
 * `invalidatedBy`). The parser tolerates unknown keys.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Parsed split of an exploration markdown file. */
export interface ExplorationParsed {
  /** Trimmed original frontmatter text (without the `---` fences). */
  frontmatterRaw: string;
  /** Parsed YAML frontmatter as a mutable record. */
  frontmatter: Record<string, unknown>;
  /** Body bytes after the closing `---` fence (line ending preserved). */
  body: string;
}

/** File-touched entry shape inside frontmatter. */
export interface FilesTouchedEntry {
  path: string;
  oid: string;
}

/**
 * Parses an exploration file into frontmatter + body.
 *
 * Returns `null` when the file does not begin with a YAML frontmatter
 * fenced by `---` / `---`. Throws only on malformed YAML inside the
 * fence — callers that want best-effort behaviour must catch.
 *
 * @param fileContent - Raw file content read via `readFile(..., 'utf-8')`.
 * @returns The parsed split, or `null` when no frontmatter present.
 */
export function parseExplorationFile(
  fileContent: string,
): ExplorationParsed | null {
  if (!fileContent.startsWith('---')) return null;
  // Find the first newline after the opening fence.
  const firstNlIdx = fileContent.indexOf('\n');
  if (firstNlIdx === -1) return null;
  // Locate the closing `---` on its own line.
  const closingFence = fileContent.indexOf('\n---', firstNlIdx);
  if (closingFence === -1) return null;

  const frontmatterRaw = fileContent.slice(firstNlIdx + 1, closingFence);
  // Body starts after `\n---` and (typically) a following newline.
  let bodyStart = closingFence + 4; // skip '\n---'
  if (fileContent[bodyStart] === '\r') bodyStart++;
  if (fileContent[bodyStart] === '\n') bodyStart++;
  const body = fileContent.slice(bodyStart);

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(frontmatterRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  return { frontmatterRaw, frontmatter, body };
}

/**
 * Re-serialises an exploration file from frontmatter + body.
 *
 * Emits `---\n<yaml>\n---\n<body>` — matches the shape Step 9 writes
 * today. `frontmatter` is serialised via `yaml.stringify` with 2-space
 * indent. The body is emitted verbatim after the closing fence.
 *
 * @param frontmatter - Parsed / mutated frontmatter object.
 * @param body - Bytes after the fence (preserve verbatim).
 * @returns The fully re-serialised file content.
 */
export function serializeExplorationFile(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = stringifyYaml(frontmatter, { indent: 2 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Extracts the `files_touched` list from a parsed frontmatter.
 *
 * Accepts only arrays of `{path, oid}` mappings. Returns an empty
 * array when the key is missing, malformed, or explicitly `[]`.
 *
 * @param frontmatter - Parsed frontmatter record.
 * @returns A validated list of entries; empty when absent / malformed.
 */
export function extractFilesTouched(
  frontmatter: Record<string, unknown>,
): FilesTouchedEntry[] {
  const raw = frontmatter['files_touched'];
  if (!Array.isArray(raw)) return [];
  const entries: FilesTouchedEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj['path'] !== 'string' || typeof obj['oid'] !== 'string') {
      continue;
    }
    entries.push({ path: obj['path'], oid: obj['oid'] });
  }
  return entries;
}

/**
 * Returns `true` when the parsed frontmatter carries a non-empty
 * `files_touched` list (the R1 / R3 admission criterion).
 */
export function hasFilesTouched(
  frontmatter: Record<string, unknown>,
): boolean {
  return extractFilesTouched(frontmatter).length > 0;
}
