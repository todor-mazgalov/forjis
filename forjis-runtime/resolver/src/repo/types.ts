/**
 * Shared type definitions for repository resolution.
 *
 * These types define the data structures used across all repo modules:
 * repository configurations, resolved repositories, manifests,
 * and resource registry entries.
 */

/** Git repository declaration from build.forjis. */
export interface GitRepoConfig {
  type: 'git';
  url: string;
  ref: string;
}

/** Local directory repository declaration from build.forjis. */
export interface DirRepoConfig {
  type: 'dir';
  path: string;
}

/** Union of all repository configuration types. */
export type RepoConfig = GitRepoConfig | DirRepoConfig;

/** Result of resolving a repository to a local cache path with its parsed manifest. */
export interface ResolvedRepo {
  config: RepoConfig;
  cachePath: string;
  manifest: Manifest;
}

/** Parsed manifest.yaml from a repository root. */
export interface Manifest {
  name: string;
  version: string;
  description?: string;
  contents: ManifestContents;
}

/** Listing of resource names declared in a manifest. */
export interface ManifestContents {
  agents: string[];
  skills: string[];
  hooks: string[];
  plugins: string[];
}

/** The four resource types that a repository can provide. */
export type ResourceType = 'agent' | 'skill' | 'hook' | 'plugin';

/** A resolved resource entry pointing to a file in a cached repository. */
export interface ResourceEntry {
  type: ResourceType;
  name: string;
  repoName: string;
  filePath: string;
}

/** Parsed qualified resource name with optional namespace prefix. */
export interface QualifiedName {
  namespace?: string;
  name: string;
}
