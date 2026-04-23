/**
 * Unit tests for the task-rules capability.
 *
 * Covers the plugin-side parser (`parsePluginRules` via `parsePlugin`),
 * the build-file parser extension (`validateTasks` handling of
 * `tasks.rules.include`), the post-compose resolver pass
 * (`resolveTaskRuleIncludes`), and the sentinel collision probe.
 */

import { parseBuildFile } from '../build-file.js';
import { BuildFileValidationError, PluginValidationError, ResolverError } from '../errors.js';
import { parsePlugin, resolveTaskRuleIncludes } from '../plugin-compositor.js';
import type {
  BuildConfig,
  PluginDef,
  RuntimeOrg,
  TaskRuleIncludeRef,
} from '../types.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Builds a minimal BuildConfig with the given task-rules includes. */
function buildConfigWithIncludes(
  includes: TaskRuleIncludeRef[]
): BuildConfig {
  return {
    version: 1,
    repositories: [{ type: 'git', url: 'https://example.com/r.git', ref: 'v1' }],
    plugins: [],
    orgs: [],
    tasks: {
      pollIntervalMs: 300_000,
      autoDependencies: false,
      rules: { include: includes },
    },
    outcome: null,
    tokenBudget: null,
    constraints: null,
    personas: null,
    healthCheck: null,
    inspector: null,
    dev: null,
  };
}

/** Single-role orgs tree used for triple validation. */
function singleRoleOrgs(): RuntimeOrg[] {
  return [
    {
      name: 'playground',
      teams: [
        {
          name: 'Frontend',
          roles: [
            {
              name: 'Explorer',
              agent: 'fx-agent',
              skills: [],
              hooks: { pre: [], validation: [], post: [] },
              org: 'playground',
              team: 'Frontend',
            },
          ],
        },
      ],
    },
  ];
}

/** Three-role orgs tree used to exercise run→skip rewrite. */
function threeRoleOrgs(): RuntimeOrg[] {
  return [
    {
      name: 'playground',
      teams: [
        {
          name: 'Frontend',
          roles: [
            buildRole('Explorer'),
            buildRole('Developer'),
            buildRole('Reviewer'),
          ],
        },
      ],
    },
  ];
}

function buildRole(name: string) {
  return {
    name,
    agent: `${name.toLowerCase()}-agent`,
    skills: [],
    hooks: { pre: [], validation: [], post: [] },
    org: 'playground',
    team: 'Frontend',
  };
}

/** Builds a plugin with a single rule declared in YAML. */
function pluginWithOneRule(
  pluginName: string,
  ruleYamlLines: string[]
): PluginDef {
  return parsePlugin([
    `name: ${pluginName}`,
    'version: 1.0.0',
    'rules:',
    ...ruleYamlLines,
  ].join('\n'));
}

// --------------------------------------------------------------------------
// 7.2–7.6 parsePlugin: rules parser
// --------------------------------------------------------------------------

describe('parsePlugin — rules block', () => {
  it('7.2 happy path: parses a rule with matcher and developer prompt_prepend', () => {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'rules:',
      '  - name: text-rename',
      '    matches:',
      '      task_title: "^rename .+ to .+"',
      '    developer:',
      '      prompt_prepend: "Single-edit rename."',
    ].join('\n');

    const plugin = parsePlugin(yaml);
    expect(plugin.rules).toHaveLength(1);
    expect(plugin.rules[0]).toEqual({
      name: 'text-rename',
      matches: { task_title: '^rename .+ to .+' },
      developer: { prompt_prepend: 'Single-edit rename.' },
    });
  });

  it('defaults rules to [] when the plugin omits the block', () => {
    const plugin = parsePlugin(['name: p', 'version: 1.0.0'].join('\n'));
    expect(plugin.rules).toEqual([]);
  });

  it('rejects an empty matches object', () => {
    expect(() => parsePlugin([
      'name: p',
      'version: 1.0.0',
      'rules:',
      '  - name: x',
      '    matches: {}',
    ].join('\n'))).toThrow(PluginValidationError);
  });

  it('7.3 rejects a top-level skip key with "plugin rules cannot reference project roles"', () => {
    try {
      parsePlugin([
        'name: p',
        'version: 1.0.0',
        'rules:',
        '  - name: x',
        '    matches:',
        '      task_title: ".*"',
        '    skip:',
        '      - a:b:c',
      ].join('\n'));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginValidationError);
      expect((err as PluginValidationError).message).toContain('plugin rules cannot reference project roles');
    }
  });

  it('7.4 rejects a top-level run key', () => {
    try {
      parsePlugin([
        'name: p',
        'version: 1.0.0',
        'rules:',
        '  - name: x',
        '    matches:',
        '      task_title: ".*"',
        '    run:',
        '      - a:b:c',
      ].join('\n'));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginValidationError);
      expect((err as PluginValidationError).message).toContain('plugin rules cannot reference project roles');
    }
  });

  it('7.5 rejects a triple-literal inside a developer prompt_prepend', () => {
    try {
      parsePlugin([
        'name: p',
        'version: 1.0.0',
        'rules:',
        '  - name: x',
        '    matches:',
        '      task_title: ".*"',
        '    developer:',
        '      prompt_prepend: "playground:Frontend:Developer"',
      ].join('\n'));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginValidationError);
      expect((err as PluginValidationError).message).toContain('plugin rules cannot reference project roles');
    }
  });

  it('7.6 rejects duplicate rule names within a plugin', () => {
    expect(() => parsePlugin([
      'name: p',
      'version: 1.0.0',
      'rules:',
      '  - name: rename',
      '    matches: { task_title: "^a" }',
      '  - name: rename',
      '    matches: { task_title: "^b" }',
    ].join('\n'))).toThrow(PluginValidationError);
  });
});

// --------------------------------------------------------------------------
// 7.7–7.11 parseBuildFile: tasks.rules.include
// --------------------------------------------------------------------------

describe('parseBuildFile — tasks.rules.include', () => {
  it('7.7 happy path parses include with skip list', () => {
    const yaml = [
      'version: 1',
      'tasks:',
      '  rules:',
      '    include:',
      '      - rule: "a:b"',
      '        skip:',
      '          - o:t:r',
    ].join('\n');

    const config = parseBuildFile(yaml);
    expect(config.tasks?.rules?.include).toEqual([
      { pluginName: 'a', ruleName: 'b', skip: ['o:t:r'] },
    ]);
  });

  it('7.8 rejects include that carries both skip and run', () => {
    const yaml = [
      'version: 1',
      'tasks:',
      '  rules:',
      '    include:',
      '      - rule: "a:b"',
      '        skip: []',
      '        run: []',
    ].join('\n');

    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(e => e.includes('mutually exclusive'))).toBe(true);
    }
  });

  it('7.9 rejects include that carries neither skip nor run and points at skip: []', () => {
    const yaml = [
      'version: 1',
      'tasks:',
      '  rules:',
      '    include:',
      '      - rule: "a:b"',
    ].join('\n');
    try {
      parseBuildFile(yaml);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BuildFileValidationError);
      const msgs = (err as BuildFileValidationError).errors.join(' | ');
      expect(msgs).toContain('skip: []');
    }
  });

  it('7.10 rejects wildcard rule reference', () => {
    const yaml = [
      'version: 1',
      'tasks:',
      '  rules:',
      '    include:',
      '      - rule: "a:*"',
      '        skip: []',
    ].join('\n');

    try {
      parseBuildFile(yaml);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BuildFileValidationError);
      expect((err as BuildFileValidationError).errors.some(e => e.includes('wildcards are not supported'))).toBe(true);
    }
  });

  it('7.11 rejects malformed two-segment triple', () => {
    const yaml = [
      'version: 1',
      'tasks:',
      '  rules:',
      '    include:',
      '      - rule: "a:b"',
      '        skip:',
      '          - "Frontend:Developer"',
    ].join('\n');

    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
  });
});

// --------------------------------------------------------------------------
// 7.12–7.16 resolveTaskRuleIncludes
// --------------------------------------------------------------------------

describe('resolveTaskRuleIncludes — resolution', () => {
  it('7.12 rejects unknown plugin in rule reference', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('software-dev', [
        '  - name: known',
        '    matches: { task_title: "^x" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'nonexistent', ruleName: 'anything', skip: [] },
    ]);
    try {
      resolveTaskRuleIncludes(build, plugins, singleRoleOrgs());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).message).toContain('nonexistent');
    }
  });

  it('7.13 rejects unknown rule in a known plugin', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('software-dev', [
        '  - name: known',
        '    matches: { task_title: "^x" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'software-dev', ruleName: 'ghost', skip: [] },
    ]);
    try {
      resolveTaskRuleIncludes(build, plugins, singleRoleOrgs());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      const msg = (err as ResolverError).message;
      expect(msg).toContain('software-dev');
      expect(msg).toContain('ghost');
    }
  });

  it('7.14 rejects unknown role triple', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('software-dev', [
        '  - name: r',
        '    matches: { task_title: "^x" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'software-dev', ruleName: 'r', skip: ['playground:Frontend:Astronaut'] },
    ]);
    try {
      resolveTaskRuleIncludes(build, plugins, singleRoleOrgs());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).message).toContain('playground:Frontend:Astronaut');
    }
  });

  it('7.15 run with one triple becomes the complementary skip list', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('sd', [
        '  - name: r',
        '    matches: { task_title: "^x" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'sd', ruleName: 'r', run: ['playground:Frontend:Developer'] },
    ]);

    const resolved = resolveTaskRuleIncludes(build, plugins, threeRoleOrgs());
    expect(resolved).toHaveLength(1);
    expect(resolved[0].skip).toEqual([
      'playground:Frontend:Explorer',
      'playground:Frontend:Reviewer',
    ]);
  });

  it('7.16 empty run: [] rewrites to all roles in skip', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('sd', [
        '  - name: r',
        '    matches: { task_title: "^x" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'sd', ruleName: 'r', run: [] },
    ]);

    const resolved = resolveTaskRuleIncludes(build, plugins, threeRoleOrgs());
    expect(resolved[0].skip).toEqual([
      'playground:Frontend:Explorer',
      'playground:Frontend:Developer',
      'playground:Frontend:Reviewer',
    ]);
  });

  it('preserves include order in the resolved array', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('sd', [
        '  - name: r1',
        '    matches: { task_title: "^r1" }',
        '  - name: r2',
        '    matches: { task_title: "^r2" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'sd', ruleName: 'r2', skip: [] },
      { pluginName: 'sd', ruleName: 'r1', skip: [] },
    ]);

    const resolved = resolveTaskRuleIncludes(build, plugins, singleRoleOrgs());
    expect(resolved.map(r => r.name)).toEqual(['r2', 'r1']);
  });

  it('returns [] when no tasks.rules block is present', () => {
    const plugins: PluginDef[] = [];
    const build: BuildConfig = {
      version: 1,
      repositories: [],
      plugins: [],
      orgs: [],
      tasks: null,
      outcome: null,
      tokenBudget: null,
      constraints: null,
      personas: null,
      healthCheck: null,
      inspector: null,
      dev: null,
    };
    expect(resolveTaskRuleIncludes(build, plugins, [])).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 7.17–7.18 sentinel collision probe
// --------------------------------------------------------------------------

describe('resolveTaskRuleIncludes — sentinel collision probe', () => {
  it('7.17 rejects two rules whose task_title regexes both match the sentinel', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('software-dev', [
        '  - name: text-rename',
        '    matches: { task_title: "^rename .+ to .+" }',
        '  - name: broad-rename',
        '    matches: { task_title: "^.*rename.*$" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'software-dev', ruleName: 'text-rename', skip: [] },
      { pluginName: 'software-dev', ruleName: 'broad-rename', skip: [] },
    ]);

    try {
      resolveTaskRuleIncludes(build, plugins, singleRoleOrgs());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      const msg = (err as ResolverError).message;
      expect(msg).toContain('software-dev:text-rename');
      expect(msg).toContain('software-dev:broad-rename');
    }
  });

  it('7.18 disjoint regexes pass: "^rename" and "^bump" do not collide', () => {
    const plugins: PluginDef[] = [
      pluginWithOneRule('sd', [
        '  - name: text-rename',
        '    matches: { task_title: "^rename .+ to .+" }',
        '  - name: bump-dep',
        '    matches: { task_title: "^bump .+" }',
      ]),
    ];
    const build = buildConfigWithIncludes([
      { pluginName: 'sd', ruleName: 'text-rename', skip: [] },
      { pluginName: 'sd', ruleName: 'bump-dep', skip: [] },
    ]);
    const resolved = resolveTaskRuleIncludes(build, plugins, singleRoleOrgs());
    expect(resolved).toHaveLength(2);
  });
});
