/**
 * CacheManager — manages the ~/.forjis/cache/ directory layout.
 *
 * Provides deterministic cache directory naming for both git repositories
 * (based on URL + ref) and local directories (based on directory name + content hash).
 * Handles cache root creation and existence checks.
 */

import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { RepoError } from './errors.js';

/** Default cache root path under the user's home directory. */
const DEFAULT_CACHE_SUBPATH = '.forjis/cache';

/**
 * Manages the global cache directory at ~/.forjis/cache/.
 *
 * Generates deterministic directory names from repository URLs/refs
 * and local directory paths/hashes. Ensures the cache root exists
 * before any write operations.
 */
export class CacheManager {
  private readonly cacheRoot: string;

  /**
   * Creates a CacheManager instance.
   *
   * @param cacheRoot - Optional override for the cache root path. Defaults to ~/.forjis/cache/.
   */
  constructor(cacheRoot?: string) {
    this.cacheRoot = cacheRoot ?? join(homedir(), DEFAULT_CACHE_SUBPATH);
  }

  /**
   * Returns the cache root path, creating the directory if it does not exist.
   *
   * @returns The absolute path to the cache root directory.
   * @throws {RepoError} If the directory cannot be created (e.g., permission denied).
   */
  async ensureCacheRoot(): Promise<string> {
    try {
      await mkdir(this.cacheRoot, { recursive: true });
    } catch (error) {
      throw new RepoError(
        `Failed to create cache directory at ${this.cacheRoot}`,
        error instanceof Error ? error : undefined
      );
    }
    return this.cacheRoot;
  }

  /**
   * Generates a cache directory name for a git repository.
   *
   * Parses the URL to extract host, org, and repo name, then formats
   * as "{host}-{org}-{repo}-{ref}" with slashes replaced by dashes.
   *
   * @param url - The git repository URL (e.g., "https://github.com/org/repo.git").
   * @param ref - The git ref (tag, branch, or commit hash).
   * @returns A deterministic directory name string.
   */
  gitCacheDirName(url: string, ref: string): string {
    const parsed = parseGitUrl(url);
    const sanitizedRef = ref.replace(/\//g, '-');
    return `${parsed.host}-${parsed.org}-${parsed.repo}-${sanitizedRef}`;
  }

  /**
   * Generates a cache directory name for a local directory.
   *
   * Uses the directory basename and the first 12 characters of the content hash.
   *
   * @param dirName - The basename of the local directory.
   * @param hash - The full SHA-256 content hash (hex string).
   * @returns A deterministic directory name string.
   */
  dirCacheDirName(dirName: string, hash: string): string {
    return `local-${dirName}-${hash.substring(0, 12)}`;
  }

  /**
   * Returns the full absolute cache path for a git repository.
   *
   * @param url - The git repository URL.
   * @param ref - The git ref.
   * @returns The full absolute path to the cache directory.
   */
  gitCachePath(url: string, ref: string): string {
    return join(this.cacheRoot, this.gitCacheDirName(url, ref));
  }

  /**
   * Returns the full absolute cache path for a local directory.
   *
   * @param dirName - The basename of the local directory.
   * @param hash - The full SHA-256 content hash (hex string).
   * @returns The full absolute path to the cache directory.
   */
  dirCachePath(dirName: string, hash: string): string {
    return join(this.cacheRoot, this.dirCacheDirName(dirName, hash));
  }

  /**
   * Checks whether a cache directory exists.
   *
   * Returns false on any filesystem error (non-throwing).
   *
   * @param cachePath - The absolute path to check.
   * @returns True if the directory exists, false otherwise.
   */
  async exists(cachePath: string): Promise<boolean> {
    try {
      const stats = await stat(cachePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Lists all entries in the cache root directory.
   *
   * @returns An array of directory names within the cache root.
   */
  async listEntries(): Promise<string[]> {
    try {
      return await readdir(this.cacheRoot);
    } catch {
      return [];
    }
  }
}

/**
 * Parses a git URL into host, org, and repo components.
 *
 * Supports both HTTPS and SSH URL formats:
 * - https://github.com/org/repo.git
 * - git@github.com:org/repo.git
 *
 * @param url - The git repository URL.
 * @returns An object with host, org, and repo fields.
 */
function parseGitUrl(url: string): { host: string; org: string; repo: string } {
  let host: string;
  let pathPart: string;

  if (url.includes('://')) {
    const urlObj = new URL(url);
    host = urlObj.hostname;
    pathPart = urlObj.pathname.replace(/^\//, '');
  } else {
    const colonIndex = url.indexOf(':');
    const atIndex = url.indexOf('@');
    host = url.substring(atIndex + 1, colonIndex);
    pathPart = url.substring(colonIndex + 1);
  }

  const segments = pathPart.split('/').filter(Boolean);
  const org = segments[0] ?? '';
  let repo = segments[1] ?? '';

  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  return { host, org, repo };
}
