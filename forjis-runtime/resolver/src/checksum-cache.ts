/**
 * Checksum cache for resolver optimization.
 *
 * Stores SHA-256 hashes of source content so that config writers can
 * skip regenerating files whose inputs have not changed. The cache file
 * lives at `.forjis/resolver-cache/checksums.json` in the target project.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ResolverError } from './errors.js';
import { atomicWriteFile, ensureDir } from './state.js';
import type { ChecksumCache, ChecksumEntry } from './types.js';

export type { ChecksumCache, ChecksumEntry };

/** Returns the absolute path to the checksums.json file. */
function getCachePath(projectDir: string): string {
  return join(projectDir, '.forjis', 'resolver-cache', 'checksums.json');
}

/**
 * Read the checksum cache from .forjis/resolver-cache/checksums.json.
 *
 * Returns null if the file does not exist. Throws on JSON parse errors
 * so callers are not silently working with corrupt data.
 *
 * @param projectDir - The root directory of the target project.
 * @returns The parsed ChecksumCache, or null if no cache file exists.
 * @throws {ResolverError} If the cache file exists but contains invalid JSON.
 */
export async function readChecksumCache(projectDir: string): Promise<ChecksumCache | null> {
  const cachePath = getCachePath(projectDir);

  let content: string;
  try {
    content = await readFile(cachePath, 'utf-8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(content) as ChecksumCache;
  } catch (err) {
    throw new ResolverError(
      `Failed to parse checksum cache at "${cachePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Write the checksum cache to .forjis/resolver-cache/checksums.json.
 *
 * Creates the parent directory if it does not exist. Uses atomic writes
 * to prevent partial file corruption on crash.
 *
 * @param projectDir - The root directory of the target project.
 * @param cache - The cache data to persist.
 */
export async function writeChecksumCache(projectDir: string, cache: ChecksumCache): Promise<void> {
  const cachePath = getCachePath(projectDir);
  const cacheDir = join(projectDir, '.forjis', 'resolver-cache');

  await ensureDir(cacheDir);
  await atomicWriteFile(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Compute SHA-256 hex digest of a string.
 *
 * Used to hash source content for cache comparison. Deterministic for
 * identical input strings.
 *
 * @param content - The string content to hash.
 * @returns The SHA-256 hex digest.
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a source has changed since the last cache entry.
 *
 * Returns true if the file should be regenerated (i.e., the source is new
 * or its hash differs from the cached value).
 *
 * @param sourceId - The identifier for the source in the cache.
 * @param currentHash - The current SHA-256 hash of the source content.
 * @param cache - The previous checksum cache (may be null).
 * @returns True if the source has changed and should be regenerated.
 */
export function isChanged(
  sourceId: string,
  currentHash: string,
  cache: ChecksumCache | null
): boolean {
  if (!cache) {
    return true;
  }

  const entry = cache.entries[sourceId];
  if (!entry) {
    return true;
  }

  return entry.sourceHash !== currentHash;
}
