/**
 * Orgs config file writer.
 *
 * Generates `.forjis/config/orgs.yaml` containing the fully resolved
 * org/team/role hierarchy with absolute file paths for agents, skills,
 * and hooks, plus outcome group references on each role.
 */

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { computeHash, isChanged } from '../checksum-cache.js';
import { atomicWriteFile, ensureDir } from '../state.js';
import type { WriterContext, WriteResult } from '../types.js';

/** Cache key used for the orgs config file. */
const CACHE_KEY = 'config:orgs';

/** Output filename. */
const FILE_NAME = 'orgs.yaml';

/**
 * Generates .forjis/config/orgs.yaml.
 *
 * Produces the fully resolved org/team/role hierarchy with:
 * - Absolute file paths for agent, skill, and hook references
 * - outcomes array on each role (FR-027)
 * - version field at top level
 *
 * @param ctx - The shared writer context.
 * @returns A WriteResult indicating whether the file was written or skipped.
 */
export async function writeOrgsConfig(ctx: WriterContext): Promise<WriteResult> {
  const orgsData = buildOrgsData(ctx);
  const content = stringifyYaml(orgsData, { indent: 2 });
  const hash = computeHash(content);

  if (!isChanged(CACHE_KEY, hash, ctx.previousCache)) {
    return { file: FILE_NAME, written: false };
  }

  await ensureDir(ctx.configDir);
  await atomicWriteFile(join(ctx.configDir, FILE_NAME), content);

  ctx.cacheEntries[CACHE_KEY] = {
    sourceHash: hash,
    targetPaths: [FILE_NAME],
    generatedAt: new Date().toISOString(),
  };

  return { file: FILE_NAME, written: true };
}

/**
 * Builds the orgs data structure for YAML serialization.
 *
 * Resolves agent, skill, and hook references to absolute paths via the registry.
 */
function buildOrgsData(ctx: WriterContext): Record<string, unknown> {
  const orgs = ctx.config.orgs.map(org => ({
    name: org.name,
    teams: org.teams.map(team => ({
      name: team.name,
      roles: team.roles.map(role => {
        const agentPath = resolveResourcePath(ctx, 'agent', role.agent);
        const skillPaths = role.skills.map(s => resolveResourcePath(ctx, 'skill', s));
        const hookPaths = {
          pre: role.hooks.pre.map(h => resolveResourcePath(ctx, 'hook', h)),
          validation: role.hooks.validation.map(h => resolveResourcePath(ctx, 'hook', h)),
          post: role.hooks.post.map(h => resolveResourcePath(ctx, 'hook', h)),
        };

        return {
          name: role.name,
          agent: agentPath,
          skills: skillPaths,
          hooks: hookPaths,
          outcomes: role.outcomes ?? [],
          ...(role.stage ? { stage: role.stage } : {}),
          ...(role.expertise ? { expertise: role.expertise } : {}),
          ...(role.visuals && role.visuals.length > 0 ? { visuals: role.visuals } : {}),
        };
      }),
    })),
  }));

  return { version: 1, orgs };
}

/**
 * Resolves a resource name to an absolute file path via the registry.
 *
 * @param ctx - The writer context containing the registry.
 * @param type - The resource type.
 * @param name - The resource name.
 * @returns The absolute file path for the resource.
 */
function resolveResourcePath(
  ctx: WriterContext,
  type: 'agent' | 'skill' | 'hook',
  name: string
): string {
  const entry = ctx.registry.resolve(type, name);
  return entry.filePath;
}
