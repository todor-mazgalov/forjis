/**
 * GitResolver — clones git repositories to the cache at pinned refs.
 *
 * Uses the system git binary via child_process to clone repositories.
 * Supports branch/tag refs (via --branch) and commit hash refs
 * (via clone + checkout). Caches are reused when the URL+ref combination
 * already exists in the cache directory.
 */

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { CacheManager } from './cache.js';
import { GitCloneError } from './errors.js';
import type { GitRepoConfig } from './types.js';

const execFileAsync = promisify(execFile);

/** Pattern matching a full 40-character hex commit hash. */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Resolves git repositories by cloning them to the cache.
 *
 * When a cached copy exists for the given URL+ref combination, it is
 * returned immediately without any git operations. Otherwise, the
 * repository is cloned to the cache directory.
 */
export class GitResolver {
  /** In-flight clone promises keyed by cache path, used to deduplicate concurrent resolves. */
  private inFlight = new Map<string, Promise<string>>();

  /**
   * Creates a GitResolver instance.
   *
   * @param cache - The CacheManager for computing and checking cache paths.
   */
  constructor(private readonly cache: CacheManager) {}

  /**
   * Resolves a git repository configuration to a local cache path.
   *
   * Clones the repository if not already cached. Returns the cache path
   * immediately if the URL+ref combination is already present.
   *
   * @param config - The git repository configuration with URL and ref.
   * @returns The absolute path to the cached repository directory.
   * @throws {GitCloneError} If the clone or checkout operation fails.
   */
  async resolve(config: GitRepoConfig): Promise<string> {
    const cachePath = this.cache.gitCachePath(config.url, config.ref);

    if (await this.cache.exists(cachePath)) {
      return cachePath;
    }

    if (this.inFlight.has(cachePath)) {
      return this.inFlight.get(cachePath)!;
    }

    const clonePromise = (async (): Promise<string> => {
      await this.cache.ensureCacheRoot();

      try {
        if (isCommitHash(config.ref)) {
          await this.cloneAtCommitHash(config.url, config.ref, cachePath);
        } else {
          await this.cloneAtBranchOrTag(config.url, config.ref, cachePath);
        }
      } catch (error) {
        await cleanupPartialClone(cachePath);
        throw wrapGitError(config.url, config.ref, error);
      }

      return cachePath;
    })();

    this.inFlight.set(cachePath, clonePromise);

    try {
      return await clonePromise;
    } finally {
      this.inFlight.delete(cachePath);
    }
  }

  /**
   * Clones a repository at a branch or tag ref using --branch.
   *
   * @param url - The git repository URL.
   * @param ref - The branch or tag name.
   * @param cachePath - The target cache directory path.
   */
  private async cloneAtBranchOrTag(
    url: string,
    ref: string,
    cachePath: string
  ): Promise<void> {
    await execFileAsync('git', [
      'clone',
      '--branch',
      ref,
      '--single-branch',
      '--depth',
      '1',
      url,
      cachePath,
    ]);
  }

  /**
   * Clones a repository and checks out a specific commit hash.
   *
   * Since --branch does not accept commit hashes, we first clone
   * the repository as a blobless clone (--filter=blob:none --no-checkout)
   * to avoid downloading unnecessary file contents, then checkout the
   * specific commit.
   *
   * @param url - The git repository URL.
   * @param commitHash - The 40-character hex commit hash.
   * @param cachePath - The target cache directory path.
   */
  private async cloneAtCommitHash(
    url: string,
    commitHash: string,
    cachePath: string
  ): Promise<void> {
    await execFileAsync('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      url,
      cachePath,
    ]);
    await execFileAsync('git', ['checkout', commitHash], { cwd: cachePath });
  }
}

/**
 * Checks whether a ref string is a 40-character hex commit hash.
 *
 * @param ref - The git ref to check.
 * @returns True if the ref matches the commit hash pattern.
 */
function isCommitHash(ref: string): boolean {
  return COMMIT_HASH_PATTERN.test(ref);
}

/**
 * Removes a partially cloned cache directory to prevent corrupted state.
 *
 * @param cachePath - The directory to remove.
 */
async function cleanupPartialClone(cachePath: string): Promise<void> {
  try {
    await rm(cachePath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; ignore errors
  }
}

/**
 * Wraps an unknown error into a GitCloneError with URL and ref context.
 *
 * @param url - The git repository URL.
 * @param ref - The git ref that was requested.
 * @param error - The original error from the git operation.
 * @returns A GitCloneError wrapping the original error.
 */
function wrapGitError(url: string, ref: string, error: unknown): GitCloneError {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new GitCloneError(url, ref, cause);
}
