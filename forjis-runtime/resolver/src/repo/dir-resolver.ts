/**
 * DirResolver — resolves local directory repositories with hash-based staleness detection.
 *
 * Computes a SHA-256 content hash of all files in a directory, uses the hash
 * to determine cache validity, and copies directory contents to the cache
 * when the hash changes or no cache entry exists.
 */

import { createHash } from 'node:crypto';
import { cp, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import type { CacheManager } from './cache.js';
import { DirNotFoundError, RepoError } from './errors.js';
import type { DirRepoConfig } from './types.js';

/**
 * Resolves local directory repositories by content hashing and caching.
 *
 * When the directory content has not changed (same hash), the existing
 * cache entry is reused. When content changes, a new cache entry is created.
 */
export class DirResolver {
  /**
   * Creates a DirResolver instance.
   *
   * @param cache - The CacheManager for computing and checking cache paths.
   */
  constructor(private readonly cache: CacheManager) {}

  /**
   * Resolves a local directory repository to a cached copy.
   *
   * Checks that the source directory exists, computes a content hash,
   * and either returns the existing cache entry or creates a new one.
   *
   * @param config - The directory repository configuration with the source path.
   * @returns The absolute path to the cached directory.
   * @throws {DirNotFoundError} If the source directory does not exist.
   * @throws {RepoError} If copying or hashing fails.
   */
  async resolve(config: DirRepoConfig): Promise<string> {
    await this.assertDirectoryExists(config.path);

    const hash = await this.computeHash(config.path);
    const dirName = basename(config.path);
    const cachePath = this.cache.dirCachePath(dirName, hash);

    if (await this.cache.exists(cachePath)) {
      return cachePath;
    }

    await this.cache.ensureCacheRoot();
    await this.copyToCache(config.path, cachePath);

    return cachePath;
  }

  /**
   * Computes a SHA-256 content hash of all files in a directory.
   *
   * Collects all files recursively, sorts them by relative path,
   * hashes each file's relative path and content, then combines
   * all individual hashes into a final digest.
   *
   * @param dirPath - The absolute path to the directory to hash.
   * @returns A 64-character hex SHA-256 hash string.
   * @throws {RepoError} If the directory cannot be read or hashed.
   */
  async computeHash(dirPath: string): Promise<string> {
    try {
      const files = await collectFiles(dirPath);
      files.sort();

      const combinedHash = createHash('sha256');

      for (const relPath of files) {
        const absPath = join(dirPath, relPath);
        const content = await readFile(absPath);

        const fileHash = createHash('sha256');
        fileHash.update(relPath);
        fileHash.update(content);
        combinedHash.update(fileHash.digest());
      }

      return combinedHash.digest('hex');
    } catch (error) {
      if (error instanceof RepoError) {
        throw error;
      }
      throw new RepoError(
        `Failed to compute content hash for ${dirPath}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Asserts that a directory exists at the given path.
   *
   * @param dirPath - The path to verify.
   * @throws {DirNotFoundError} If the directory does not exist.
   */
  private async assertDirectoryExists(dirPath: string): Promise<void> {
    try {
      const stats = await stat(dirPath);
      if (!stats.isDirectory()) {
        throw new DirNotFoundError(dirPath);
      }
    } catch (error) {
      if (error instanceof DirNotFoundError) {
        throw error;
      }
      throw new DirNotFoundError(dirPath);
    }
  }

  /**
   * Copies directory contents to the cache path.
   *
   * @param source - The source directory path.
   * @param destination - The target cache directory path.
   * @throws {RepoError} If the copy operation fails.
   */
  private async copyToCache(source: string, destination: string): Promise<void> {
    try {
      await cp(source, destination, { recursive: true });
    } catch (error) {
      throw new RepoError(
        `Failed to copy directory ${source} to cache at ${destination}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}

/**
 * Recursively collects all file paths in a directory, returning relative paths.
 *
 * @param dirPath - The root directory to scan.
 * @param basePath - The base path for computing relative paths (defaults to dirPath).
 * @returns A list of relative file paths sorted alphabetically.
 */
async function collectFiles(
  dirPath: string,
  basePath?: string
): Promise<string[]> {
  const root = basePath ?? dirPath;
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, root);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }

  return files;
}
