/**
 * Unit tests for ConfigServiceImpl.
 *
 * Requirements validated:
 *   CONFIG-002 — Service reads orgs.yaml and returns org/team/role hierarchy
 *   CONFIG-003 — Service reads constraints.yaml with mandatory, optional, pillars
 *   CONFIG-004 — Service reads personas.yaml and returns persona list
 *   CONFIG-005 — Service reads tasks.yaml and health-check.yaml
 *   CONFIG-006 — Service reads token-budget.yaml (empty object when not configured)
 *   CONFIG-001 — Missing config files produce sensible defaults (no crash)
 *   CONFIG-001 — Service implements ConfigService interface (getConfig returns ConfigResponse)
 *
 * Tests use real temp directories with fixture YAML files written via fs/promises.
 * Each test writes only the YAML files it needs; missing files resolve to defaults.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import { ConfigServiceImpl } from '../web-services/config-service.js';
import type { ConfigResponse } from '@forjis/shared';

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Creates a temporary directory under the OS tmpdir, writes YAML fixture
 * files to it, and returns the path plus a cleanup function.
 *
 * @param files - Record of filename -> JS object. Each is stringified as YAML.
 * @returns { dir, cleanup }
 */
async function makeTempConfigDir(
  files: Record<string, unknown>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'forjis-config-service-test-'));
  for (const [filename, data] of Object.entries(files)) {
    await writeFile(join(dir, filename), stringifyYaml(data, { indent: 2 }), 'utf-8');
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ===========================================================================
// Fixture data
// ===========================================================================

const fixtureOrgs = {
  version: 1,
  orgs: [
    {
      name: 'test-org',
      teams: [
        {
          name: 'core',
          roles: [
            {
              name: 'developer',
              agent: '/abs/path/forjis-developer.md',
              skills: ['/abs/path/skill-ts.md', '/abs/path/skill-go.md'],
              hooks: {
                pre: ['/abs/path/pre-hook.sh'],
                validation: [],
                post: [],
              },
              outcomes: ['quality', 'tests'],
              stage: 'developer',
              expertise: 'TypeScript and Go specialist',
            },
          ],
        },
      ],
    },
  ],
};

const fixtureConstraints = {
  mandatory: 'Never push directly to main. All changes via PRs.',
  optional: 'Prefer TypeScript over JavaScript.',
  pillars: [
    { path: 'docs/engineering-standards.md', content: '# Engineering Standards\nBe excellent.' },
  ],
};

const fixturePersonas = {
  dir: '/abs/personas',
  personas: [
    {
      name: 'terry',
      description: 'A pragmatic reviewer',
      tools: ['Read', 'Grep', 'Bash'],
      model: 'claude-sonnet-4-5',
      content: '# Terry\nYou are a pragmatic code reviewer.',
    },
  ],
};

const fixtureTasks = {
  source: 'local',
  path: '.forjis/tasks',
  poll_interval: '5s',
  max_concurrent: 2,
  auto_dependencies: true,
};

const fixtureHealthCheck = {
  interval: 300,
  max_retries: 3,
};

const fixtureTokenBudget = {
  max_tokens: 500000,
  reset_window: '1h',
};

const fixtureOutcomes = {
  defaultAction: 'retry',
  defaultMaxRetries: 3,
  outcomes: [
    {
      name: 'quality',
      metrics: { test_coverage: 'percentage of lines covered' },
      rules: [
        { metric: 'test_coverage', operator: '>=', threshold: 80, action: 'pass' },
      ],
    },
  ],
};

// ===========================================================================
// Tests: full config with all files present
// ===========================================================================

describe('ConfigServiceImpl — all config files present', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let result: ConfigResponse;

  beforeAll(async () => {
    ({ dir, cleanup } = await makeTempConfigDir({
      'orgs.yaml': fixtureOrgs,
      'constraints.yaml': fixtureConstraints,
      'personas.yaml': fixturePersonas,
      'tasks.yaml': fixtureTasks,
      'health-check.yaml': fixtureHealthCheck,
      'token-budget.yaml': fixtureTokenBudget,
      'outcomes.yaml': fixtureOutcomes,
    }));

    const service = new ConfigServiceImpl(dir);
    result = await service.getConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * CONFIG-001: getConfig() resolves to a ConfigResponse without throwing.
   */
  it('resolves without throwing when all files are present', () => {
    expect(result).toBeDefined();
  });

  /**
   * CONFIG-002: orgs.yaml is parsed and returned as the orgs field.
   */
  it('returns correct orgs version and org list', () => {
    expect(result.orgs.version).toBe(1);
    expect(result.orgs.orgs).toHaveLength(1);
    expect(result.orgs.orgs[0].name).toBe('test-org');
  });

  /**
   * CONFIG-002: Team and role hierarchy is preserved correctly.
   */
  it('returns full org/team/role hierarchy', () => {
    const org = result.orgs.orgs[0];
    expect(org.teams).toHaveLength(1);
    expect(org.teams[0].name).toBe('core');
    expect(org.teams[0].roles).toHaveLength(1);

    const role = org.teams[0].roles[0];
    expect(role.name).toBe('developer');
    expect(role.agent).toBe('/abs/path/forjis-developer.md');
    expect(role.skills).toEqual(['/abs/path/skill-ts.md', '/abs/path/skill-go.md']);
    expect(role.hooks.pre).toEqual(['/abs/path/pre-hook.sh']);
    expect(role.hooks.validation).toEqual([]);
    expect(role.hooks.post).toEqual([]);
    expect(role.outcomes).toEqual(['quality', 'tests']);
    expect(role.stage).toBe('developer');
    expect(role.expertise).toBe('TypeScript and Go specialist');
  });

  /**
   * CONFIG-003: constraints.yaml is parsed with mandatory, optional, and pillars.
   */
  it('returns constraints with mandatory text', () => {
    expect(result.constraints.mandatory).toBe('Never push directly to main. All changes via PRs.');
  });

  it('returns constraints with optional text', () => {
    expect(result.constraints.optional).toBe('Prefer TypeScript over JavaScript.');
  });

  it('returns constraints with pillar documents', () => {
    expect(result.constraints.pillars).toHaveLength(1);
    expect(result.constraints.pillars[0].path).toBe('docs/engineering-standards.md');
    expect(result.constraints.pillars[0].content).toBe('# Engineering Standards\nBe excellent.');
  });

  /**
   * CONFIG-004: personas.yaml is parsed and returned with full persona data.
   */
  it('returns personas dir', () => {
    expect(result.personas.dir).toBe('/abs/personas');
  });

  it('returns persona list with full data (name, description, tools, model, content)', () => {
    expect(result.personas.personas).toHaveLength(1);
    const persona = result.personas.personas[0];
    expect(persona.name).toBe('terry');
    expect(persona.description).toBe('A pragmatic reviewer');
    expect(persona.tools).toEqual(['Read', 'Grep', 'Bash']);
    expect(persona.model).toBe('claude-sonnet-4-5');
    expect(persona.content).toBe('# Terry\nYou are a pragmatic code reviewer.');
  });

  /**
   * CONFIG-005: tasks.yaml fields are present.
   */
  it('returns tasks with all optional fields', () => {
    expect(result.tasks.source).toBe('local');
    expect(result.tasks.path).toBe('.forjis/tasks');
    expect(result.tasks.poll_interval).toBe('5s');
    expect(result.tasks.max_concurrent).toBe(2);
    expect(result.tasks.auto_dependencies).toBe(true);
  });

  /**
   * CONFIG-005: health-check.yaml fields are present.
   */
  it('returns healthCheck with interval and max_retries', () => {
    expect(result.healthCheck.interval).toBe(300);
    expect(result.healthCheck.max_retries).toBe(3);
  });

  /**
   * CONFIG-006: token-budget.yaml with values returns populated object.
   */
  it('returns tokenBudget with max_tokens and reset_window', () => {
    expect(result.tokenBudget).toMatchObject({
      max_tokens: 500000,
      reset_window: '1h',
    });
  });

  it('returns outcomes with defaultAction, defaultMaxRetries, and outcome groups', () => {
    expect(result.outcomes.defaultAction).toBe('retry');
    expect(result.outcomes.defaultMaxRetries).toBe(3);
    expect(result.outcomes.outcomes).toHaveLength(1);
    expect(result.outcomes.outcomes[0].name).toBe('quality');
    expect(result.outcomes.outcomes[0].rules).toHaveLength(1);
    expect(result.outcomes.outcomes[0].rules[0].metric).toBe('test_coverage');
  });
});

// ===========================================================================
// Tests: missing config files produce sensible defaults
// ===========================================================================

describe('ConfigServiceImpl — missing config files (defaults)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let result: ConfigResponse;

  beforeAll(async () => {
    // Write NO yaml files — empty directory
    ({ dir, cleanup } = await makeTempConfigDir({}));

    const service = new ConfigServiceImpl(dir);
    result = await service.getConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * CONFIG-001: Service does not throw when all files are missing.
   * Requirement: "Missing files are replaced with sensible defaults".
   */
  it('resolves without throwing when all files are missing', () => {
    expect(result).toBeDefined();
  });

  it('defaults to empty orgs list when orgs.yaml is missing', () => {
    expect(result.orgs.version).toBe(1);
    expect(result.orgs.orgs).toEqual([]);
  });

  it('defaults to empty constraint strings when constraints.yaml is missing', () => {
    expect(result.constraints.mandatory).toBe('');
    expect(result.constraints.optional).toBe('');
    expect(result.constraints.pillars).toEqual([]);
  });

  it('defaults to empty personas list when personas.yaml is missing', () => {
    expect(result.personas.dir).toBe('');
    expect(result.personas.personas).toEqual([]);
  });

  it('defaults to empty tasks object when tasks.yaml is missing', () => {
    expect(result.tasks).toEqual({});
  });

  it('defaults to interval=300, max_retries=3 when health-check.yaml is missing', () => {
    expect(result.healthCheck.interval).toBe(300);
    expect(result.healthCheck.max_retries).toBe(3);
  });

  it('defaults to empty tokenBudget object when token-budget.yaml is missing', () => {
    expect(result.tokenBudget).toEqual({});
  });

  it('defaults to halt action and empty outcomes when outcomes.yaml is missing', () => {
    expect(result.outcomes.defaultAction).toBe('halt');
    expect(result.outcomes.defaultMaxRetries).toBe(2);
    expect(result.outcomes.outcomes).toEqual([]);
  });
});

// ===========================================================================
// Tests: constraints.yaml with no pillars field
// ===========================================================================

describe('ConfigServiceImpl — constraints without pillars', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let result: ConfigResponse;

  beforeAll(async () => {
    ({ dir, cleanup } = await makeTempConfigDir({
      'constraints.yaml': {
        mandatory: 'Always write tests.',
        optional: '',
        // no pillars field
      },
    }));

    const service = new ConfigServiceImpl(dir);
    result = await service.getConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * CONFIG-003: pillars defaults to [] when not present in constraints.yaml.
   */
  it('defaults pillars to empty array when not in YAML', () => {
    expect(result.constraints.pillars).toEqual([]);
  });

  it('returns the mandatory text correctly', () => {
    expect(result.constraints.mandatory).toBe('Always write tests.');
  });

  it('returns empty string for optional when empty in YAML', () => {
    expect(result.constraints.optional).toBe('');
  });
});

// ===========================================================================
// Tests: personas.yaml with empty personas array
// ===========================================================================

describe('ConfigServiceImpl — empty personas array', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let result: ConfigResponse;

  beforeAll(async () => {
    ({ dir, cleanup } = await makeTempConfigDir({
      'personas.yaml': {
        dir: '/abs/personas',
        personas: [],
      },
    }));

    const service = new ConfigServiceImpl(dir);
    result = await service.getConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * CONFIG-004 (empty state): "No personas configured" behavior — service
   * returns empty array so frontend can render the empty state message.
   */
  it('returns empty personas array when personas list is empty', () => {
    expect(result.personas.personas).toEqual([]);
  });

  it('preserves the dir field even with no personas', () => {
    expect(result.personas.dir).toBe('/abs/personas');
  });
});

// ===========================================================================
// Tests: token-budget.yaml as empty object
// ===========================================================================

describe('ConfigServiceImpl — empty token-budget.yaml', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let result: ConfigResponse;

  beforeAll(async () => {
    ({ dir, cleanup } = await makeTempConfigDir({
      'token-budget.yaml': {}, // empty object in YAML
    }));

    const service = new ConfigServiceImpl(dir);
    result = await service.getConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * CONFIG-006: tokenBudget is {} when file exists but is empty object.
   */
  it('returns empty tokenBudget object when file contains empty YAML', () => {
    // YAML "null" or "{}" should produce either null or {} — defaulted to {}
    // by the service's `?? {}` fallback.
    expect(typeof result.tokenBudget).toBe('object');
    expect(result.tokenBudget).toBeTruthy();
  });
});

// ===========================================================================
// Tests: tasks.yaml with only required fields (max_concurrent absent)
// ===========================================================================

describe('ConfigServiceImpl — tasks.yaml with optional fields absent', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let result: ConfigResponse;

  beforeAll(async () => {
    ({ dir, cleanup } = await makeTempConfigDir({
      'tasks.yaml': {
        source: 'local',
        path: '.forjis/tasks',
        poll_interval: '10s',
        auto_dependencies: false,
        // max_concurrent intentionally absent
      },
    }));

    const service = new ConfigServiceImpl(dir);
    result = await service.getConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * CONFIG-005 (optional fields): max_concurrent is absent when not in YAML.
   */
  it('max_concurrent is undefined when not in tasks YAML', () => {
    expect(result.tasks.max_concurrent).toBeUndefined();
  });

  it('present task fields are returned correctly', () => {
    expect(result.tasks.source).toBe('local');
    expect(result.tasks.path).toBe('.forjis/tasks');
    expect(result.tasks.auto_dependencies).toBe(false);
  });
});
