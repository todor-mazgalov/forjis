/**
 * ResourceRegistry — indexes resources from resolved repositories and provides lookups.
 *
 * Builds an internal index from all resolved repositories' manifests, supporting
 * lookups by resource type and name. Handles unique resolution, namespace-prefixed
 * disambiguation, and conflict detection.
 */

import {
  AmbiguousResourceError,
  ResourceNotFoundError,
} from './errors.js';
import type {
  QualifiedName,
  ResolvedRepo,
  ResourceEntry,
  ResourceType,
} from './types.js';

/** Maps a resource type key in ManifestContents to the ResourceType enum value. */
const CONTENT_TYPE_MAP: ReadonlyArray<{
  contentsKey: 'agents' | 'skills' | 'hooks' | 'plugins';
  resourceType: ResourceType;
  directory: string;
  extension: string;
}> = [
  { contentsKey: 'agents', resourceType: 'agent', directory: 'agents', extension: '.md' },
  { contentsKey: 'skills', resourceType: 'skill', directory: 'skills', extension: '/SKILL.md' },
  { contentsKey: 'hooks', resourceType: 'hook', directory: 'hooks', extension: '.md' },
  { contentsKey: 'plugins', resourceType: 'plugin', directory: 'plugins', extension: '.forjis.yaml' },
];

/**
 * Indexes all resources from resolved repositories and provides type+name lookups.
 *
 * Resources are indexed by type and name. When a name is unique across all
 * repositories, it can be resolved without a namespace prefix. When multiple
 * repositories declare the same name for the same type, a namespace prefix
 * is required for disambiguation.
 */
export class ResourceRegistry {
  /**
   * Internal index: ResourceType -> name -> ResourceEntry[]
   * The inner array contains one entry per repository that declares the resource.
   */
  private readonly index: Map<ResourceType, Map<string, ResourceEntry[]>>;

  /**
   * Creates a ResourceRegistry from a list of resolved repositories.
   *
   * Iterates over each repository's manifest contents to build the internal index.
   *
   * @param resolvedRepos - The list of resolved repositories with their manifests.
   */
  constructor(private readonly resolvedRepos: ResolvedRepo[]) {
    this.index = this.buildIndex();
  }

  /**
   * Resolves a resource by type and qualified name.
   *
   * Supports both plain names ("analyst") and namespace-prefixed names
   * ("forjis-std:analyst"). Plain names resolve only when unique across
   * all repositories.
   *
   * @param type - The resource type to look up (agent, skill, hook, plugin).
   * @param qualifiedName - The resource name, optionally prefixed with "namespace:".
   * @returns The matching ResourceEntry.
   * @throws {ResourceNotFoundError} If no matching resource exists.
   * @throws {AmbiguousResourceError} If the name matches multiple repos without a namespace.
   */
  resolve(type: ResourceType, qualifiedName: string): ResourceEntry {
    const parsed = this.parseQualifiedName(qualifiedName);
    const typeIndex = this.index.get(type);

    if (!typeIndex) {
      throw new ResourceNotFoundError(type, qualifiedName);
    }

    if (parsed.namespace) {
      return this.resolveWithNamespace(type, parsed, typeIndex);
    }

    return this.resolveWithoutNamespace(type, parsed.name, typeIndex);
  }

  /**
   * Parses a qualified name string into namespace and name components.
   *
   * Splits on the first ":" character. If no colon is present, the
   * entire string is treated as the name with no namespace.
   *
   * @param input - The qualified name string (e.g., "name" or "ns:name").
   * @returns A QualifiedName with optional namespace.
   */
  parseQualifiedName(input: string): QualifiedName {
    const colonIndex = input.indexOf(':');

    if (colonIndex === -1) {
      return { name: input };
    }

    return {
      namespace: input.substring(0, colonIndex),
      name: input.substring(colonIndex + 1),
    };
  }

  /**
   * Lists all resources of a given type across all repositories.
   *
   * @param type - The resource type to list.
   * @returns An array of all ResourceEntry objects of the given type.
   */
  listByType(type: ResourceType): ResourceEntry[] {
    const typeIndex = this.index.get(type);
    if (!typeIndex) {
      return [];
    }

    const entries: ResourceEntry[] = [];
    for (const entryList of typeIndex.values()) {
      entries.push(...entryList);
    }
    return entries;
  }

  /**
   * Returns the absolute cache paths of every resolved repository.
   *
   * These are the whitelisted plugin roots used by the web layer's
   * plugin file endpoint to validate read requests.
   */
  getPluginRoots(): string[] {
    return this.resolvedRepos.map((r) => r.cachePath);
  }

  /**
   * Lists all resources across all types and repositories.
   *
   * @returns An array of all ResourceEntry objects in the registry.
   */
  listAll(): ResourceEntry[] {
    const entries: ResourceEntry[] = [];
    for (const typeIndex of this.index.values()) {
      for (const entryList of typeIndex.values()) {
        entries.push(...entryList);
      }
    }
    return entries;
  }

  /**
   * Detects all naming conflicts across repositories.
   *
   * A conflict occurs when two or more repositories declare a resource
   * with the same type and name.
   *
   * @returns A map of "type:name" to the list of repository names that declare it.
   */
  getConflicts(): Map<string, string[]> {
    const conflicts = new Map<string, string[]>();

    for (const [type, typeIndex] of this.index) {
      for (const [name, entries] of typeIndex) {
        if (entries.length >= 2) {
          const repoNames = entries.map((entry) => entry.repoName);
          conflicts.set(`${type}:${name}`, repoNames);
        }
      }
    }

    return conflicts;
  }

  /**
   * Builds the internal resource index from all resolved repositories.
   *
   * @returns The populated index map.
   */
  private buildIndex(): Map<ResourceType, Map<string, ResourceEntry[]>> {
    const index = new Map<ResourceType, Map<string, ResourceEntry[]>>();

    for (const mapping of CONTENT_TYPE_MAP) {
      index.set(mapping.resourceType, new Map());
    }

    for (const repo of this.resolvedRepos) {
      this.indexRepository(repo, index);
    }

    return index;
  }

  /**
   * Indexes a single repository's manifest contents into the index.
   *
   * @param repo - The resolved repository to index.
   * @param index - The index to populate.
   */
  private indexRepository(
    repo: ResolvedRepo,
    index: Map<ResourceType, Map<string, ResourceEntry[]>>
  ): void {
    for (const mapping of CONTENT_TYPE_MAP) {
      const names = repo.manifest.contents[mapping.contentsKey];
      const typeIndex = index.get(mapping.resourceType)!;

      for (const name of names) {
        const entry: ResourceEntry = {
          type: mapping.resourceType,
          name,
          repoName: repo.manifest.name,
          filePath: `${repo.cachePath}/${mapping.directory}/${name}${mapping.extension}`,
        };

        const existing = typeIndex.get(name);
        if (existing) {
          existing.push(entry);
        } else {
          typeIndex.set(name, [entry]);
        }
      }
    }
  }

  /**
   * Resolves a resource with a namespace prefix.
   *
   * @param type - The resource type.
   * @param parsed - The parsed qualified name with namespace.
   * @param typeIndex - The type-specific index.
   * @returns The matching ResourceEntry.
   * @throws {ResourceNotFoundError} If no entry matches both namespace and name.
   */
  private resolveWithNamespace(
    type: ResourceType,
    parsed: QualifiedName,
    typeIndex: Map<string, ResourceEntry[]>
  ): ResourceEntry {
    const entries = typeIndex.get(parsed.name);
    if (!entries) {
      throw new ResourceNotFoundError(type, `${parsed.namespace}:${parsed.name}`);
    }

    const match = entries.find((entry) => entry.repoName === parsed.namespace);
    if (!match) {
      throw new ResourceNotFoundError(type, `${parsed.namespace}:${parsed.name}`);
    }

    return match;
  }

  /**
   * Resolves a resource without a namespace prefix.
   *
   * @param type - The resource type.
   * @param name - The resource name.
   * @param typeIndex - The type-specific index.
   * @returns The matching ResourceEntry.
   * @throws {ResourceNotFoundError} If no entry matches the name.
   * @throws {AmbiguousResourceError} If multiple entries match.
   */
  private resolveWithoutNamespace(
    type: ResourceType,
    name: string,
    typeIndex: Map<string, ResourceEntry[]>
  ): ResourceEntry {
    const entries = typeIndex.get(name);

    if (!entries || entries.length === 0) {
      throw new ResourceNotFoundError(type, name);
    }

    if (entries.length === 1) {
      return entries[0];
    }

    const repoNames = entries.map((entry) => entry.repoName);
    throw new AmbiguousResourceError(type, name, repoNames);
  }
}
