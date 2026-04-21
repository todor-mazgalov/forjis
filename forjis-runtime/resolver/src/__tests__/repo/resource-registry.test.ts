/**
 * Unit tests for ResourceRegistry (repo/registry.ts).
 *
 * Covers: basic registration and resolution, namespace-prefixed resolution,
 * conflict detection, parseQualifiedName, and ambiguity errors.
 */

import { ResourceRegistry } from '../../repo/registry.js';
import { AmbiguousResourceError, ResourceNotFoundError } from '../../repo/errors.js';
import type { ResolvedRepo, ResourceType } from '../../repo/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal ResolvedRepo with the given name, cachePath, and resource lists. */
function makeRepo(
  name: string,
  cachePath: string,
  contents: Partial<{ agents: string[]; skills: string[]; hooks: string[]; plugins: string[] }> = {}
): ResolvedRepo {
  return {
    config: { type: 'dir', path: cachePath },
    cachePath,
    manifest: {
      name,
      version: '1.0.0',
      contents: {
        agents: contents.agents ?? [],
        skills: contents.skills ?? [],
        hooks: contents.hooks ?? [],
        plugins: contents.plugins ?? [],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// parseQualifiedName
// ---------------------------------------------------------------------------

describe('ResourceRegistry.parseQualifiedName', () => {
  const registry = new ResourceRegistry([]);

  it('returns only name when no colon is present', () => {
    const result = registry.parseQualifiedName('analyst');
    expect(result).toEqual({ name: 'analyst' });
    expect(result.namespace).toBeUndefined();
  });

  it('splits on the first colon into namespace and name', () => {
    const result = registry.parseQualifiedName('forjis-std:analyst');
    expect(result.namespace).toBe('forjis-std');
    expect(result.name).toBe('analyst');
  });

  it('handles names that contain additional colons (only first colon is the separator)', () => {
    const result = registry.parseQualifiedName('my-repo:some:name');
    expect(result.namespace).toBe('my-repo');
    expect(result.name).toBe('some:name');
  });

  it('handles an empty string gracefully (no colon)', () => {
    const result = registry.parseQualifiedName('');
    expect(result).toEqual({ name: '' });
  });

  it('handles a string that starts with a colon — empty namespace, name is the rest', () => {
    const result = registry.parseQualifiedName(':analyst');
    expect(result.namespace).toBe('');
    expect(result.name).toBe('analyst');
  });
});

// ---------------------------------------------------------------------------
// Basic registration and resolution
// ---------------------------------------------------------------------------

describe('ResourceRegistry — basic registration and resolution', () => {
  it('resolves a unique agent by plain name', () => {
    const repo = makeRepo('my-repo', '/cache/my-repo', { agents: ['dev-agent'] });
    const registry = new ResourceRegistry([repo]);

    const entry = registry.resolve('agent', 'dev-agent');

    expect(entry.name).toBe('dev-agent');
    expect(entry.repoName).toBe('my-repo');
    expect(entry.type).toBe('agent');
    expect(entry.filePath).toBe('/cache/my-repo/agents/dev-agent.md');
  });

  it('resolves a unique skill by plain name', () => {
    const repo = makeRepo('pkg', '/cache/pkg', { skills: ['typescript'] });
    const registry = new ResourceRegistry([repo]);

    const entry = registry.resolve('skill', 'typescript');

    expect(entry.name).toBe('typescript');
    expect(entry.filePath).toBe('/cache/pkg/skills/typescript/SKILL.md');
  });

  it('resolves a unique hook by plain name', () => {
    const repo = makeRepo('pkg', '/cache/pkg', { hooks: ['pre-commit'] });
    const registry = new ResourceRegistry([repo]);

    const entry = registry.resolve('hook', 'pre-commit');

    expect(entry.filePath).toBe('/cache/pkg/hooks/pre-commit.md');
  });

  it('resolves a unique plugin by plain name', () => {
    const repo = makeRepo('pkg', '/cache/pkg', { plugins: ['my-plugin'] });
    const registry = new ResourceRegistry([repo]);

    const entry = registry.resolve('plugin', 'my-plugin');

    expect(entry.filePath).toBe('/cache/pkg/plugins/my-plugin.forjis.yaml');
  });

  it('throws ResourceNotFoundError for an unknown resource name', () => {
    const repo = makeRepo('my-repo', '/cache/my-repo', { agents: ['dev-agent'] });
    const registry = new ResourceRegistry([repo]);

    expect(() => registry.resolve('agent', 'nonexistent')).toThrow(ResourceNotFoundError);
  });

  it('throws ResourceNotFoundError when looking up the wrong type', () => {
    const repo = makeRepo('my-repo', '/cache/my-repo', { agents: ['dev-agent'] });
    const registry = new ResourceRegistry([repo]);

    // 'dev-agent' is an agent, not a skill
    expect(() => registry.resolve('skill', 'dev-agent')).toThrow(ResourceNotFoundError);
  });

  it('resolves resources from multiple repos without conflict', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['agent-alpha'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['agent-beta'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    const alpha = registry.resolve('agent', 'agent-alpha');
    const beta = registry.resolve('agent', 'agent-beta');

    expect(alpha.repoName).toBe('repo-a');
    expect(beta.repoName).toBe('repo-b');
  });
});

// ---------------------------------------------------------------------------
// Namespace-prefixed resolution
// ---------------------------------------------------------------------------

describe('ResourceRegistry — namespace-prefixed resolution', () => {
  it('resolves a resource using namespace prefix when multiple repos declare the same name', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['analyst'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['analyst'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    const entryA = registry.resolve('agent', 'repo-a:analyst');
    const entryB = registry.resolve('agent', 'repo-b:analyst');

    expect(entryA.repoName).toBe('repo-a');
    expect(entryB.repoName).toBe('repo-b');
  });

  it('throws ResourceNotFoundError when namespace does not match any repo', () => {
    const repo = makeRepo('repo-a', '/cache/a', { agents: ['analyst'] });
    const registry = new ResourceRegistry([repo]);

    expect(() => registry.resolve('agent', 'nonexistent-repo:analyst')).toThrow(
      ResourceNotFoundError
    );
  });

  it('throws ResourceNotFoundError when name does not exist in the specified namespace', () => {
    const repo = makeRepo('repo-a', '/cache/a', { agents: ['analyst'] });
    const registry = new ResourceRegistry([repo]);

    expect(() => registry.resolve('agent', 'repo-a:missing')).toThrow(ResourceNotFoundError);
  });

  it('resolves a unique resource with a namespace prefix (single repo)', () => {
    const repo = makeRepo('forjis-std', '/cache/std', { agents: ['backend-agent'] });
    const registry = new ResourceRegistry([repo]);

    const entry = registry.resolve('agent', 'forjis-std:backend-agent');

    expect(entry.name).toBe('backend-agent');
    expect(entry.repoName).toBe('forjis-std');
  });
});

// ---------------------------------------------------------------------------
// Conflict detection — getConflicts
// ---------------------------------------------------------------------------

describe('ResourceRegistry.getConflicts', () => {
  it('returns an empty map when there are no conflicts', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['agent-alpha'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['agent-beta'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    expect(registry.getConflicts().size).toBe(0);
  });

  it('detects a conflict when two repos share the same agent name', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['analyst'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['analyst'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    const conflicts = registry.getConflicts();

    expect(conflicts.has('agent:analyst')).toBe(true);
    expect(conflicts.get('agent:analyst')).toEqual(expect.arrayContaining(['repo-a', 'repo-b']));
  });

  it('detects a conflict across different resource types independently', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['shared'], skills: ['shared'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['shared'], skills: ['shared'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    const conflicts = registry.getConflicts();

    expect(conflicts.has('agent:shared')).toBe(true);
    expect(conflicts.has('skill:shared')).toBe(true);
  });

  it('does not flag a name that only appears in one repo', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['unique-agent', 'shared-agent'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['shared-agent'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    const conflicts = registry.getConflicts();

    expect(conflicts.has('agent:unique-agent')).toBe(false);
    expect(conflicts.has('agent:shared-agent')).toBe(true);
  });

  it('returns no conflicts from an empty registry', () => {
    const registry = new ResourceRegistry([]);
    expect(registry.getConflicts().size).toBe(0);
  });

  it('includes all conflicting repo names in the map value', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['common'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['common'] });
    const repoC = makeRepo('repo-c', '/cache/c', { agents: ['common'] });
    const registry = new ResourceRegistry([repoA, repoB, repoC]);

    const conflictRepos = registry.getConflicts().get('agent:common');

    expect(conflictRepos).toHaveLength(3);
    expect(conflictRepos).toEqual(expect.arrayContaining(['repo-a', 'repo-b', 'repo-c']));
  });
});

// ---------------------------------------------------------------------------
// Ambiguity errors
// ---------------------------------------------------------------------------

describe('ResourceRegistry — ambiguity errors', () => {
  it('throws AmbiguousResourceError when resolving by plain name with multiple matches', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['analyst'] });
    const repoB = makeRepo('repo-b', '/cache/b', { agents: ['analyst'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    expect(() => registry.resolve('agent', 'analyst')).toThrow(AmbiguousResourceError);
  });

  it('AmbiguousResourceError message includes the conflicting repo names', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { skills: ['linter'] });
    const repoB = makeRepo('repo-b', '/cache/b', { skills: ['linter'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    let caught: AmbiguousResourceError | undefined;
    try {
      registry.resolve('skill', 'linter');
    } catch (err) {
      caught = err as AmbiguousResourceError;
    }

    expect(caught).toBeInstanceOf(AmbiguousResourceError);
    expect(caught!.repos).toEqual(expect.arrayContaining(['repo-a', 'repo-b']));
    expect(caught!.message).toContain('repo-a');
    expect(caught!.message).toContain('repo-b');
  });

  it('namespace prefix resolves the ambiguity without throwing', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { hooks: ['notify'] });
    const repoB = makeRepo('repo-b', '/cache/b', { hooks: ['notify'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    // Plain name is ambiguous, but namespaced is not
    expect(() => registry.resolve('hook', 'notify')).toThrow(AmbiguousResourceError);
    expect(() => registry.resolve('hook', 'repo-a:notify')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listByType and listAll
// ---------------------------------------------------------------------------

describe('ResourceRegistry.listByType and listAll', () => {
  it('listByType returns only entries of the requested type', () => {
    const repo = makeRepo('pkg', '/cache/pkg', {
      agents: ['agent-one', 'agent-two'],
      skills: ['skill-one'],
    });
    const registry = new ResourceRegistry([repo]);

    const agents = registry.listByType('agent');
    const skills = registry.listByType('skill');

    expect(agents).toHaveLength(2);
    expect(skills).toHaveLength(1);
    expect(agents.every((e) => e.type === 'agent')).toBe(true);
  });

  it('listByType returns empty array for a type with no resources', () => {
    const repo = makeRepo('pkg', '/cache/pkg', { agents: ['some-agent'] });
    const registry = new ResourceRegistry([repo]);

    expect(registry.listByType('hook')).toHaveLength(0);
  });

  it('listAll returns every resource across all types and repos', () => {
    const repoA = makeRepo('repo-a', '/cache/a', { agents: ['a1'], skills: ['s1'] });
    const repoB = makeRepo('repo-b', '/cache/b', { hooks: ['h1'] });
    const registry = new ResourceRegistry([repoA, repoB]);

    const all = registry.listAll();

    expect(all).toHaveLength(3);
    expect(all.map((e) => e.name)).toEqual(expect.arrayContaining(['a1', 's1', 'h1']));
  });

  it('listAll returns empty array for an empty registry', () => {
    const registry = new ResourceRegistry([]);
    expect(registry.listAll()).toHaveLength(0);
  });
});
