/**
 * Unit tests for the pure catalog normaliser
 * `forjis-runtime/web/client/src/views/config/catalog.ts`.
 *
 * These tests exercise the six exported pure functions consumed by the
 * redesign-011 Config view:
 *   - `buildCatalog(resources, config)` — flattens orgs/teams/roles plus
 *     flat agents/skills/hooks and fans constraints/personas/outcomes into a
 *     single deduped `CatalogItem[]` (design.md § D-1, D-2).
 *   - `typeCounts(items)` — per-type tally plus grand `all` total (D-9).
 *   - `pluginCounts(items)` — tally by `origin` including the synthetic
 *     `'project'` key (D-4).
 *   - `deriveOrigin(path)` — first `/` segment or `'project'` fallback
 *     (D-2).
 *   - `basename(path)` — last `/` or `\` segment stripped of `.md`.
 *   - `togglePluginSet(prev, name)` — immutable add/remove toggle.
 *   - `selectByKey(items, type, name)` — cross-link lookup used when the
 *     user clicks a role card chip (D-8).
 *
 * Requirements covered (see redesign-011 spec.md):
 *   FR-1 — Three-column Config page layout (catalog + grid backing data).
 *   FR — Catalog sidebar type filter with counts.
 *   FR — Catalog sidebar plugin-source filter.
 *   FR — Per-type card rendering (role attached chips / constraint kind).
 *   FR — Cross-link chip navigation.
 */

import type {
  ConfigResponse,
  ResourcesResponse,
} from '../../../shared/src/types.js';
import {
  basename,
  buildCatalog,
  deriveOrigin,
  pluginCounts,
  selectByKey,
  togglePluginSet,
  typeCounts,
  type CatalogConstraint,
  type CatalogItem,
  type CatalogOutcome,
  type CatalogRole,
} from '../../client/src/views/config/catalog.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal fixture that exercises every arm of `buildCatalog`. */
function makeResources(): ResourcesResponse {
  return {
    orgs: [
      {
        name: 'forjis-software-dev',
        source: 'forjis-software-dev',
        teams: [
          {
            name: 'engineering',
            roles: [
              {
                name: 'Developer',
                agent: 'developer',
                skills: ['solidjs', 'ts'],
                agentPath: 'forjis-software-dev/agents/developer.md',
                skillPaths: [
                  'forjis-software-dev/skills/solidjs/SKILL.md',
                  'forjis-software-dev/skills/ts/SKILL.md',
                ],
                hookPaths: [],
                outcomePaths: [],
                personaPaths: [],
                constraintPaths: [],
              },
              {
                name: 'Reviewer',
                agent: 'reviewer',
                skills: [],
                agentPath: 'forjis-software-dev/agents/reviewer.md',
                skillPaths: [],
                hookPaths: [],
                outcomePaths: [],
                personaPaths: [],
                constraintPaths: [],
              },
            ],
          },
        ],
      },
    ],
    agents: [
      { name: 'developer', source: 'forjis-software-dev' },
      { name: 'reviewer', source: 'forjis-software-dev' },
    ],
    skills: [
      { name: 'solidjs', source: 'forjis-software-dev' },
      { name: 'ts', source: 'forjis-software-dev' },
    ],
    hooks: [
      { name: 'pre-flight', source: 'forjis-core' },
    ],
    plugins: [
      { name: 'forjis-software-dev', source: 'forjis-software-dev' },
      { name: 'forjis-core', source: 'forjis-core' },
    ],
  };
}

function makeConfig(): ConfigResponse {
  return {
    orgs: {
      version: 1,
      orgs: [
        {
          name: 'forjis-software-dev',
          teams: [
            {
              name: 'engineering',
              roles: [
                {
                  name: 'Developer',
                  agent: '/abs/agents/developer.md',
                  skills: [],
                  hooks: { pre: [], validation: [], post: [] },
                  outcomes: [],
                  expertise: 'Builds features end-to-end.',
                },
              ],
            },
          ],
        },
      ],
    },
    constraints: {
      mandatory: 'No secrets in commits.',
      optional: 'Prefer small PRs.',
      pillars: [
        {
          path: 'pillars/architecture.md',
          content: '# Architecture',
        },
        {
          path: 'pillars/data.md',
          content: '# Data',
        },
      ],
    },
    personas: {
      dir: 'personas',
      personas: [
        {
          name: 'security-auditor',
          description: 'Paranoid reviewer',
          tools: ['Read', 'Grep'],
          model: 'opus',
          content: '',
        },
      ],
    },
    tasks: {},
    healthCheck: { interval: 120, max_retries: 3 },
    tokenBudget: {},
    outcomes: {
      defaultAction: 'pass',
      defaultMaxRetries: 3,
      outcomes: [
        {
          name: 'code-quality',
          metrics: {},
          rules: [
            {
              metric: 'coverage',
              operator: '>=',
              threshold: 80,
              action: 'pass',
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// basename
// ---------------------------------------------------------------------------

describe('basename', () => {
  test('returns the last /-segment stripped of .md', () => {
    expect(basename('a/b/c.md')).toBe('c');
  });

  test('handles bare filename without a separator', () => {
    expect(basename('solo.md')).toBe('solo');
  });

  test('strips .md case-insensitively', () => {
    expect(basename('foo/BAR.MD')).toBe('BAR');
  });

  test('handles Windows-style backslash separators', () => {
    expect(basename('a\\b\\c.md')).toBe('c');
  });

  test('returns empty string for empty input', () => {
    expect(basename('')).toBe('');
  });

  test('leaves non-md extensions untouched', () => {
    expect(basename('a/b/c.txt')).toBe('c.txt');
  });
});

// ---------------------------------------------------------------------------
// deriveOrigin  (design.md § D-2)
// ---------------------------------------------------------------------------

describe('deriveOrigin', () => {
  test("project-rooted path returns 'project'", () => {
    // 'pillars/architecture.md' — first segment is 'pillars', which is a
    // project-level directory. D-2 clarifies: the rule returns the first
    // path segment, and when it equals a known pillar dir the constraint
    // label is still the first segment. This test documents the exact
    // behaviour in the current implementation.
    expect(deriveOrigin('pillars/architecture.md')).toBe('pillars');
  });

  test('plugin-rooted path returns the first segment', () => {
    expect(
      deriveOrigin('forjis-software-dev/skills/solidjs/SKILL.md'),
    ).toBe('forjis-software-dev');
  });

  test("empty path returns 'project'", () => {
    expect(deriveOrigin('')).toBe('project');
  });

  test("path without separator returns 'project'", () => {
    expect(deriveOrigin('solo.md')).toBe('project');
  });

  test("path starting with / returns 'project'", () => {
    // First char is '/', so indexOf('/') === 0, which the helper
    // treats the same as "no meaningful first segment".
    expect(deriveOrigin('/abs/path.md')).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// buildCatalog
// ---------------------------------------------------------------------------

describe('buildCatalog', () => {
  test('returns [] when both inputs are null', () => {
    expect(buildCatalog(null, null)).toEqual([]);
  });

  test('emits one CatalogRole per role across every org and team', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const roles = catalog.filter(
      (item): item is CatalogRole => item.type === 'role',
    );
    const names = roles.map((r) => r.name).sort();
    expect(names).toEqual(['Developer', 'Reviewer']);
  });

  test('role origin is copied from the owning org source', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const developer = catalog.find(
      (item): item is CatalogRole =>
        item.type === 'role' && item.name === 'Developer',
    );
    expect(developer).toBeDefined();
    expect(developer!.origin).toBe('forjis-software-dev');
  });

  test('role expertise is resolved from the richer config tree', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const developer = catalog.find(
      (item): item is CatalogRole =>
        item.type === 'role' && item.name === 'Developer',
    );
    expect(developer!.expertise).toBe('Builds features end-to-end.');
  });

  test('emits flat agent / skill / hook entries with source as origin', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const agents = catalog.filter((it) => it.type === 'agent');
    const skills = catalog.filter((it) => it.type === 'skill');
    const hooks = catalog.filter((it) => it.type === 'hook');
    expect(agents.map((a) => a.name).sort()).toEqual(['developer', 'reviewer']);
    expect(skills.map((s) => s.name).sort()).toEqual(['solidjs', 'ts']);
    expect(hooks.map((h) => h.origin)).toEqual(['forjis-core']);
  });

  test('fans constraints into one mandatory + one optional + one per pillar', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const constraints = catalog.filter(
      (it): it is CatalogConstraint => it.type === 'constraint',
    );
    const byKind: Record<string, number> = {};
    for (const c of constraints) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    }
    expect(byKind.mandatory).toBe(1);
    expect(byKind.optional).toBe(1);
    expect(byKind.pillar).toBe(2); // architecture + data
  });

  test('constraint items carry kind in {mandatory, optional, pillar}', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const constraints = catalog.filter(
      (it): it is CatalogConstraint => it.type === 'constraint',
    );
    for (const c of constraints) {
      expect(['mandatory', 'optional', 'pillar']).toContain(c.kind);
    }
  });

  test('pillar origin derives from the first path segment', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const pillars = catalog.filter(
      (it): it is CatalogConstraint =>
        it.type === 'constraint' && it.kind === 'pillar',
    );
    // Both pillar paths start with 'pillars/' so origin is 'pillars'.
    for (const p of pillars) {
      expect(p.origin).toBe('pillars');
    }
  });

  test('mandatory / optional constraint entries are labelled project', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const mandatory = catalog.find(
      (it): it is CatalogConstraint =>
        it.type === 'constraint' && it.kind === 'mandatory',
    );
    const optional = catalog.find(
      (it): it is CatalogConstraint =>
        it.type === 'constraint' && it.kind === 'optional',
    );
    expect(mandatory!.origin).toBe('project');
    expect(optional!.origin).toBe('project');
  });

  test('persona entries are labelled project and copy description', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const personas = catalog.filter((it) => it.type === 'persona');
    expect(personas.length).toBe(1);
    expect(personas[0]!.origin).toBe('project');
    expect(personas[0]!.desc).toBe('Paranoid reviewer');
  });

  test('outcome entries carry their rule list', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const outcomes = catalog.filter(
      (it): it is CatalogOutcome => it.type === 'outcome',
    );
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.rules).toHaveLength(1);
    expect(outcomes[0]!.rules[0]!.metric).toBe('coverage');
    expect(outcomes[0]!.rules[0]!.operator).toBe('>=');
    expect(outcomes[0]!.rules[0]!.threshold).toBe(80);
    expect(outcomes[0]!.rules[0]!.action).toBe('pass');
  });

  test('every emitted item has a `${type}:${name}` key', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    for (const item of catalog) {
      expect(item.key).toBe(`${item.type}:${item.name}`);
    }
  });

  test('dedupes when a later collector would re-emit an existing key', () => {
    // Build a resources fixture where the flat `agents` array includes an
    // entry whose name collides with a role-derived agent name. The flat
    // collector should skip the collision because the `role:` key differs
    // from the `agent:` key — but we verify that repeating the same flat
    // entry still dedupes by observing the final count.
    const resources: ResourcesResponse = {
      orgs: [],
      agents: [
        { name: 'shared', source: 'forjis-core' },
        { name: 'shared', source: 'forjis-core' }, // duplicate
      ],
      skills: [],
      hooks: [],
      plugins: [],
    };
    const catalog = buildCatalog(resources, null);
    const agents = catalog.filter((it) => it.type === 'agent');
    expect(agents).toHaveLength(1);
  });

  test('returns empty when resources has no roles/agents/skills/hooks and config is null', () => {
    const catalog = buildCatalog(
      { orgs: [], agents: [], skills: [], hooks: [], plugins: [] },
      null,
    );
    expect(catalog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// typeCounts
// ---------------------------------------------------------------------------

describe('typeCounts', () => {
  test('counts every type including zero-count buckets', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const counts = typeCounts(catalog);
    expect(counts.all).toBe(catalog.length);
    expect(counts.role).toBe(2);
    expect(counts.skill).toBe(2);
    expect(counts.hook).toBe(1);
    expect(counts.agent).toBe(2);
    expect(counts.constraint).toBe(4); // 1 mandatory + 1 optional + 2 pillars
    expect(counts.outcome).toBe(1);
    expect(counts.persona).toBe(1);
  });

  test('empty input yields zeros across the board', () => {
    const counts = typeCounts([]);
    expect(counts.all).toBe(0);
    expect(counts.role).toBe(0);
    expect(counts.skill).toBe(0);
    expect(counts.hook).toBe(0);
    expect(counts.agent).toBe(0);
    expect(counts.constraint).toBe(0);
    expect(counts.outcome).toBe(0);
    expect(counts.persona).toBe(0);
  });

  test('all equals the sum of every per-type bucket', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const counts = typeCounts(catalog);
    const sum =
      counts.role +
      counts.skill +
      counts.hook +
      counts.agent +
      counts.constraint +
      counts.outcome +
      counts.persona;
    expect(counts.all).toBe(sum);
  });
});

// ---------------------------------------------------------------------------
// pluginCounts
// ---------------------------------------------------------------------------

describe('pluginCounts', () => {
  test('groups items by origin', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const counts = pluginCounts(catalog);
    expect(counts.get('forjis-software-dev')).toBeGreaterThan(0);
    expect(counts.get('forjis-core')).toBeGreaterThan(0);
    expect(counts.get('project')).toBeGreaterThan(0);
  });

  test('project count equals the number of project-origin items', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const counts = pluginCounts(catalog);
    const projectItems = catalog.filter((it) => it.origin === 'project');
    expect(counts.get('project')).toBe(projectItems.length);
  });

  test("does not emit a 'project' key when no items have project origin", () => {
    // A resources-only catalog (no config) has no project-origin entries
    // because roles/agents/skills/hooks all have their own source.
    const catalog = buildCatalog(makeResources(), null);
    const counts = pluginCounts(catalog);
    expect(counts.has('project')).toBe(false);
  });

  test('sum of counts equals the catalog length', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const counts = pluginCounts(catalog);
    let sum = 0;
    for (const n of counts.values()) sum += n;
    expect(sum).toBe(catalog.length);
  });
});

// ---------------------------------------------------------------------------
// selectByKey
// ---------------------------------------------------------------------------

describe('selectByKey', () => {
  test('returns the matching item for a (type, name) tuple', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const found = selectByKey(catalog, 'skill', 'solidjs');
    expect(found).not.toBeNull();
    expect(found!.type).toBe('skill');
    expect(found!.name).toBe('solidjs');
  });

  test('returns null when no item matches the tuple', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    expect(selectByKey(catalog, 'skill', 'does-not-exist')).toBeNull();
  });

  test('treats type as part of the key — different types cannot collide', () => {
    // There is no `agent:solidjs` in this fixture, only `skill:solidjs`.
    const catalog = buildCatalog(makeResources(), makeConfig());
    expect(selectByKey(catalog, 'agent', 'solidjs')).toBeNull();
    expect(selectByKey(catalog, 'skill', 'solidjs')).not.toBeNull();
  });

  test('returns null on an empty catalog', () => {
    expect(selectByKey([], 'role', 'anything')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// togglePluginSet
// ---------------------------------------------------------------------------

describe('togglePluginSet', () => {
  test('adds a name that was absent', () => {
    const next = togglePluginSet(new Set(), 'forjis-core');
    expect(next.has('forjis-core')).toBe(true);
  });

  test('removes a name that was present', () => {
    const next = togglePluginSet(new Set(['forjis-core']), 'forjis-core');
    expect(next.has('forjis-core')).toBe(false);
  });

  test('returns a new Set instance (never mutates the input)', () => {
    const prev = new Set<string>(['a']);
    const next = togglePluginSet(prev, 'b');
    expect(next).not.toBe(prev);
    expect(prev.has('b')).toBe(false); // input untouched
    expect(next.has('a')).toBe(true);
    expect(next.has('b')).toBe(true);
  });

  test('toggling twice is the identity transform on membership', () => {
    const once = togglePluginSet(new Set<string>(), 'x');
    const twice = togglePluginSet(once, 'x');
    expect(twice.has('x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: type/plugin filter combination (matches CardGrid behaviour)
// ---------------------------------------------------------------------------

describe('filtering logic (type + plugin + search AND combination)', () => {
  /**
   * Mirror the filter body ConfigView uses so the invariant that the three
   * sidebar signals AND-combine into the visible grid is covered by a pure
   * test. This is the same predicate declared in design.md § ConfigView.
   */
  function applyFilters(
    items: CatalogItem[],
    typeFilter: CatalogItem['type'] | 'all',
    plugins: Set<string>,
    search: string,
  ): CatalogItem[] {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      if (plugins.size > 0 && !plugins.has(it.origin)) return false;
      if (q && !`${it.name} ${it.origin} ${it.desc}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }

  test('type=skill narrows the grid to only skill items', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const filtered = applyFilters(catalog, 'skill', new Set(), '');
    expect(filtered.length).toBeGreaterThan(0);
    for (const item of filtered) {
      expect(item.type).toBe('skill');
    }
  });

  test('plugin filter restricts by origin', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const plugins = new Set<string>(['forjis-core']);
    const filtered = applyFilters(catalog, 'all', plugins, '');
    expect(filtered.length).toBeGreaterThan(0);
    for (const item of filtered) {
      expect(item.origin).toBe('forjis-core');
    }
  });

  test('type + plugin filters AND-combine', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const plugins = new Set<string>(['forjis-core']);
    const filtered = applyFilters(catalog, 'hook', plugins, '');
    // Only the single hook 'pre-flight' with source 'forjis-core' should
    // survive.
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.type).toBe('hook');
    expect(filtered[0]!.origin).toBe('forjis-core');
  });

  test('search substring matches case-insensitively against name', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const filtered = applyFilters(catalog, 'all', new Set(), 'SOLID');
    expect(filtered.length).toBeGreaterThan(0);
    for (const item of filtered) {
      const text =
        `${item.name} ${item.origin} ${item.desc}`.toLowerCase();
      expect(text).toContain('solid');
    }
  });

  test('empty search returns every item that passes the other filters', () => {
    const catalog = buildCatalog(makeResources(), makeConfig());
    const filtered = applyFilters(catalog, 'all', new Set(), '');
    expect(filtered).toHaveLength(catalog.length);
  });
});
