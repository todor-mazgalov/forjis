/**
 * Resource service implementation for the web dashboard backend.
 *
 * Implements the ResourceService interface by reading from RuntimeConfig
 * and ResourceRegistry. All data is in-memory (no I/O), so responses are
 * effectively instant, well within the 200ms NFR target.
 */

import { resolve, sep } from 'node:path';

import type { RuntimeConfig } from '../types.js';
import type { ResourceRegistry } from '@forjis/resolver';
import type { ResourceService } from '@forjis/shared';
import type {
  ResourcesResponse,
  OrgResource,
  AgentResource,
  SkillResource,
  HookResource,
  PluginResource,
} from '@forjis/shared';

/**
 * Implements ResourceService by reading from RuntimeConfig and ResourceRegistry.
 *
 * Receives both objects by reference at construction time. The response is
 * built fresh on each call by mapping the in-memory data structures to the
 * API response shapes.
 */
export class ResourceServiceImpl implements ResourceService {
  /** Absolute plugin root paths, normalized once at construction. */
  private readonly normalizedRoots: readonly string[];

  /**
   * Creates a ResourceServiceImpl.
   *
   * @param runtime - The fully composed runtime configuration.
   * @param registry - The resource registry with all resolved resources.
   */
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly registry: ResourceRegistry,
  ) {
    const getRoots = (registry as { getPluginRoots?: () => string[] }).getPluginRoots;
    const roots = typeof getRoots === 'function' ? getRoots.call(registry) : [];
    this.normalizedRoots = roots.map((r) => resolve(r));
  }

  /**
   * Returns all loaded resources organized by type.
   *
   * Maps RuntimeConfig.orgs to OrgResource[] (with nested teams and roles).
   * Maps ResourceRegistry.listByType() calls to agent, skill, hook, and
   * plugin arrays. Each entry includes a name and source repository.
   *
   * @returns The full resources response.
   */
  getResources(): ResourcesResponse {
    const orgs = this.mapOrgs();
    const agents = this.mapResourceType<AgentResource>('agent');
    const skills = this.mapResourceType<SkillResource>('skill');
    const hooks = this.mapResourceType<HookResource>('hook');
    const plugins = this.mapResourceType<PluginResource>('plugin');

    return { orgs, agents, skills, hooks, plugins };
  }

  /**
   * Maps the runtime org hierarchy to the API response shape.
   *
   * @returns Array of OrgResource with nested teams and roles.
   */
  private mapOrgs(): OrgResource[] {
    return this.runtime.orgs.map((org) => ({
      name: org.name,
      source: org.name,
      teams: org.teams.map((team) => ({
        name: team.name,
        roles: team.roles.map((role) => {
          const hookPaths = [
            ...role.hooks.pre,
            ...role.hooks.validation,
            ...role.hooks.post,
          ].map((p) => this.toPluginRelative(p));
          return {
            name: role.name,
            agent: role.agent,
            skills: role.skills,
            agentPath: this.toPluginRelative(role.agent),
            skillPaths: role.skills.map((p) => this.toPluginRelative(p)),
            hookPaths,
            outcomePaths: role.outcomes ?? [],
            personaPaths: [],
            constraintPaths: [],
          };
        }),
      })),
    }));
  }

  /**
   * Converts an absolute resource path to a plugin-root-relative path so the
   * client can round-trip it through /api/plugins/file. Returns the original
   * path when no plugin root owns it (e.g. user-provided absolute paths).
   */
  private toPluginRelative(absolutePath: string): string {
    if (!absolutePath) return '';
    const normalized = resolve(absolutePath);
    for (const root of this.normalizedRoots) {
      if (normalized === root) return '';
      if (normalized.startsWith(root + sep)) {
        return normalized
          .slice(root.length + 1)
          .split(sep)
          .join('/');
      }
    }
    return absolutePath;
  }

  /**
   * Maps a resource type from the registry to the API response shape.
   *
   * @param type - The resource type to map (agent, skill, hook, or plugin).
   * @returns Array of resource entries with name and source.
   */
  private mapResourceType<T extends { name: string; source: string }>(
    type: 'agent' | 'skill' | 'hook' | 'plugin',
  ): T[] {
    return this.registry.listByType(type).map((entry) => ({
      name: entry.name,
      source: entry.repoName,
    })) as T[];
  }
}
