/**
 * In-process git blob oid computation.
 *
 * Implements the git blob sha1 format (`sha1("blob " + byteLength + "\0"
 * + content)`) without shelling out to `git hash-object`. Output matches
 * `git hash-object <path>` for the same bytes, character-for-character.
 *
 * Used by the context-cache module (tree.yaml oids, files_touched oids,
 * cache-lookup oid comparison). A `spawnSync('git', ['hash-object',
 * path])` equivalence test in the unit suite pins the format.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/**
 * Computes the git blob sha1 for a byte buffer.
 *
 * Returns the 40-character lowercase hex digest of
 * `sha1("blob " + <byteLength> + "\0" + <content>)`. Deterministic and
 * matches `git hash-object` on the same bytes.
 *
 * @param content - Raw working-tree bytes of the file.
 * @returns The 40-character lowercase hex git blob oid.
 */
export function computeBlobOid(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

/**
 * Computes the git blob sha1 for the working-tree bytes of a file.
 *
 * Reads the file via `fs.readFile` then delegates to {@link computeBlobOid}.
 * Rejects paths that resolve outside `projectDir` (containment check) to
 * prevent out-of-project reads via crafted relative paths.
 *
 * @param projectDir - Absolute project root; paths must resolve inside.
 * @param path - Project-relative POSIX path (or absolute inside projectDir).
 * @returns The 40-character lowercase hex git blob oid.
 * @throws When the resolved path escapes `projectDir` or the file cannot be read.
 */
export async function computeBlobOidForFile(
  projectDir: string,
  path: string,
): Promise<string> {
  const absPath = isAbsolute(path) ? path : resolvePath(projectDir, path);
  const absProject = resolvePath(projectDir);
  if (!absPath.startsWith(absProject)) {
    throw new Error(
      `computeBlobOidForFile: path "${path}" escapes projectDir "${projectDir}"`
    );
  }
  const content = await readFile(absPath);
  return computeBlobOid(content);
}
