/**
 * Atomic read/write of `.forjis/context/tree.yaml`.
 *
 * `tree.yaml` is the authoritative file-level context index: one
 * `{ path, oid, summary }` entry per non-skipped tracked / untracked-
 * not-ignored file under the project root. See
 * `openspec/changes/cache-harden/specs/requirements/spec.md` R5.
 *
 * The reader is best-effort — missing file or malformed YAML returns
 * an empty `{files: []}` structure plus a single `[context-cache]:
 * skipped — malformed tree.yaml` log line. Never throws. The writer
 * uses an atomic `<path>.tmp` + rename via `atomicWriteFile` so the
 * on-disk file is never observed in a partially-written state.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { atomicWriteFile } from '../state.js';

/** Warning-line prefix shared with the rest of the context-cache module. */
const WARN_PREFIX = '[context-cache]:';

/** A single file entry in `tree.yaml`. */
export interface TreeEntry {
  /** Project-relative POSIX path. */
  path: string;
  /** 40-char lowercase hex git blob oid. */
  oid: string;
  /** Single-sentence ≤120-char factual summary (may be empty on prior failure). */
  summary: string;
}

/** Parsed shape of `tree.yaml`. */
export interface TreeYaml {
  files: TreeEntry[];
}

/** Options for {@link readTreeYaml}. */
export interface ReadTreeYamlOptions {
  /** Warning sink. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/**
 * Reads and parses `.forjis/context/tree.yaml`.
 *
 * Missing file → `{files: []}` (silent, no warning). Malformed YAML or
 * a shape that does not match the expected schema → `{files: []}` plus
 * a single warning line. Never throws.
 *
 * @param path - Absolute path to `tree.yaml`.
 * @param opts - Optional injection seams (warn).
 * @returns The parsed structure, or an empty placeholder on failure.
 */
export async function readTreeYaml(
  path: string,
  opts?: ReadTreeYamlOptions,
): Promise<TreeYaml> {
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return { files: [] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    warn(`${WARN_PREFIX} skipped — malformed tree.yaml at "${path}"`);
    return { files: [] };
  }

  const validated = coerceTreeYaml(parsed);
  if (validated === null) {
    warn(`${WARN_PREFIX} skipped — malformed tree.yaml at "${path}"`);
    return { files: [] };
  }
  return validated;
}

/**
 * Writes `tree.yaml` atomically.
 *
 * Serialises via `yaml.stringify` with 2-space indent. The atomic
 * write uses a temp-file + rename under the hood, so readers never see
 * a partially written file.
 *
 * @param path - Absolute path of the target file.
 * @param data - The structure to serialise.
 */
export async function writeTreeYaml(path: string, data: TreeYaml): Promise<void> {
  const content = stringifyYaml({ files: data.files }, { indent: 2 });
  await atomicWriteFile(path, content);
}

/**
 * Validates the parsed YAML shape.
 *
 * Returns `null` when the input does not match the expected schema (so
 * the reader can fall back to `{files: []}` + warn).
 */
function coerceTreeYaml(raw: unknown): TreeYaml | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const files = obj['files'];
  if (!Array.isArray(files)) return null;

  const validated: TreeEntry[] = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry['path'] !== 'string' ||
      typeof entry['oid'] !== 'string' ||
      typeof entry['summary'] !== 'string'
    ) {
      return null;
    }
    validated.push({
      path: entry['path'],
      oid: entry['oid'],
      summary: entry['summary'],
    });
  }

  return { files: validated };
}
