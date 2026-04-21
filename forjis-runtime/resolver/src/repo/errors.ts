/**
 * Error classes for repository resolution.
 *
 * Each error type represents a specific failure mode during repository
 * resolution, manifest parsing, or resource lookup. All errors extend
 * the base RepoError class for consistent error handling.
 */

import type { ResourceType } from './types.js';

/** Base error class for all repository-related failures. */
export class RepoError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'RepoError';
  }
}

/** Thrown when a git clone or checkout operation fails. */
export class GitCloneError extends RepoError {
  constructor(
    public readonly url: string,
    public readonly ref: string,
    cause: Error
  ) {
    super(
      `Failed to clone git repository ${url} at ref ${ref}: ${cause.message}`,
      cause
    );
    this.name = 'GitCloneError';
  }
}

/** Thrown when a local directory path does not exist. */
export class DirNotFoundError extends RepoError {
  constructor(public readonly dirPath: string) {
    super(`Local directory not found: ${dirPath}`);
    this.name = 'DirNotFoundError';
  }
}

/** Thrown when a repository directory does not contain manifest.yaml. */
export class ManifestNotFoundError extends RepoError {
  constructor(public readonly repoPath: string) {
    super(`manifest.yaml not found in repository at ${repoPath}`);
    this.name = 'ManifestNotFoundError';
  }
}

/** Thrown when manifest.yaml has invalid or missing required fields. */
export class ManifestValidationError extends RepoError {
  constructor(
    public readonly repoPath: string,
    public readonly details: string
  ) {
    super(`Invalid manifest.yaml in ${repoPath}: ${details}`);
    this.name = 'ManifestValidationError';
  }
}

/** Thrown when a resource name cannot be found in any repository. */
export class ResourceNotFoundError extends RepoError {
  constructor(
    public readonly resourceType: ResourceType,
    public readonly resourceName: string
  ) {
    super(`${resourceType} "${resourceName}" not found in any repository`);
    this.name = 'ResourceNotFoundError';
  }
}

/** Thrown when a resource name exists in multiple repositories without a namespace prefix. */
export class AmbiguousResourceError extends RepoError {
  constructor(
    public readonly resourceType: ResourceType,
    public readonly resourceName: string,
    public readonly repos: string[]
  ) {
    super(
      `${resourceType} "${resourceName}" is ambiguous — found in repositories: ${repos.join(', ')}. ` +
        `Use a namespace prefix (e.g., "${repos[0]}:${resourceName}") to disambiguate.`
    );
    this.name = 'AmbiguousResourceError';
  }
}
