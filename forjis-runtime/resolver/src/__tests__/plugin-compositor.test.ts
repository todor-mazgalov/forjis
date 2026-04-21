/**
 * Unit tests for plugin-compositor.ts — parsePlugin, verifyPluginDependencies, composeRuntime.
 *
 * Migrated from facilitator with updated imports (ResolverError replaces CliError).
 */

import { jest } from '@jest/globals';
import { parsePlugin, verifyPluginDependencies, composeRuntime } from '../plugin-compositor.js';
import { ResolverError, PluginDependencyError, PluginValidationError } from '../errors.js';
import type { BuildConfig, PluginDef } from '../types.js';
import type { ResourceRegistry } from '../repo/index.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Creates a minimal valid plugin YAML string. */
function minimalPluginYaml(name = 'test-plugin'): string {
  return [
    `name: ${name}`,
    `version: 1.0.0`,
  ].join('\n');
}

/** Creates a plugin with one org containing one team and one role. */
function pluginWithRoleYaml(pluginName: string, roleName: string): string {
  return [
    `name: ${pluginName}`,
    `version: 1.0.0`,
    `orgs:`,
    `  - name: product-team`,
    `    teams:`,
    `      - name: engineering`,
    `        roles:`,
    `          - name: ${roleName}`,
    `            agent: backend-agent`,
    `            skills:`,
    `              - java`,
    `              - spring`,
  ].join('\n');
}

/** Creates a mock ResourceRegistry that always resolves. */
function mockRegistryAlwaysResolves(): ResourceRegistry {
  return {
    resolve: jest.fn().mockReturnValue({ filePath: '/fake/path.yaml', name: 'resource' }),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ResourceRegistry;
}

/** Creates a mock ResourceRegistry that throws on any resolve. */
function mockRegistryNeverResolves(): ResourceRegistry {
  return {
    resolve: jest.fn().mockImplementation(() => { throw new Error('not found'); }),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ResourceRegistry;
}

/** Creates a minimal BuildConfig. */
function minimalBuildConfig(overrides?: Partial<BuildConfig>): BuildConfig {
  return {
    version: 1,
    repositories: [{ type: 'git', url: 'https://github.com/a/b.git', ref: 'v1' }],
    plugins: [],
    orgs: [],
    tasks: null,
    outcome: null,
    constraints: null,
    tokenBudget: null,
    personas: null,
    healthCheck: null,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// parsePlugin — schema validation
// --------------------------------------------------------------------------

describe('parsePlugin — schema validation', () => {
  it('parses a minimal valid plugin', () => {
    const plugin = parsePlugin(minimalPluginYaml('my-plugin'));
    expect(plugin.name).toBe('my-plugin');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.requires).toEqual({ agents: [], skills: [], hooks: [] });
    expect(plugin.orgs).toEqual([]);
    expect(plugin.pipeline).toBeNull();
    expect(plugin.outcome).toBeNull();
    expect(plugin.metrics).toBeInstanceOf(Map);
  });

  it('throws PluginValidationError when name is missing', () => {
    const yaml = `version: 1.0.0`;
    expect(() => parsePlugin(yaml)).toThrow(PluginValidationError);
  });

  it('throws PluginValidationError when version is missing', () => {
    const yaml = `name: test-plugin`;
    expect(() => parsePlugin(yaml)).toThrow(PluginValidationError);
  });

  it('parses custom metrics into a Map', () => {
    const yaml = [
      'name: my-plugin',
      'version: 1.0.0',
      'metrics:',
      '  security_score:',
      '    description: Security assessment score',
      '    criteria:',
      '      - No known CVEs',
      '    scale: "0=no security issues, 100=critical vulnerabilities"',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    expect(plugin.metrics.has('security_score')).toBe(true);
  });

  it('parses outcome rules in plugin', () => {
    const yaml = [
      'name: my-plugin',
      'version: 1.0.0',
      'outcome:',
      '  default_action: halt',
      '  default_max_retries: 1',
      '  rules:',
      '    - fail: "completeness < 70"',
      '      action: halt',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    expect(plugin.outcome!.rules).toHaveLength(1);
    expect(plugin.outcome!.rules[0].expression).toBe('completeness < 70');
  });
});

// --------------------------------------------------------------------------
// verifyPluginDependencies
// --------------------------------------------------------------------------

describe('verifyPluginDependencies', () => {
  it('throws PluginDependencyError when required agent is missing', () => {
    const plugin = parsePlugin(
      ['name: my-plugin', 'version: 1.0.0', 'requires:', '  agents:', '    - backend-agent'].join('\n')
    );
    const registry = mockRegistryNeverResolves();
    expect(() => verifyPluginDependencies(plugin, registry)).toThrow(PluginDependencyError);
  });

  it('does not throw when all required resources are available', () => {
    const plugin = parsePlugin(
      ['name: my-plugin', 'version: 1.0.0', 'requires:', '  agents:', '    - backend-agent'].join('\n')
    );
    const registry = mockRegistryAlwaysResolves();
    expect(() => verifyPluginDependencies(plugin, registry)).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// composeRuntime — role scoping
// --------------------------------------------------------------------------

describe('composeRuntime — role scoping', () => {
  it('emits plugin roles with bare name and a separate plugin field', () => {
    const plugin = parsePlugin(pluginWithRoleYaml('software-dev', 'BackendDev'));
    const config = minimalBuildConfig({
      orgs: [{ name: 'my-team', extends: 'software-dev:product-team', roles: [] }],
    });
    const registry = mockRegistryAlwaysResolves();

    const runtime = composeRuntime(config, [plugin], registry);

    const allRoles = runtime.orgs.flatMap(o => o.teams.flatMap(t => t.roles));
    const backendDev = allRoles.find(r => r.name === 'BackendDev');
    expect(backendDev).toBeDefined();
    expect(backendDev!.plugin).toBe('software-dev');
  });
});

// --------------------------------------------------------------------------
// composeRuntime — user org extends plugin org
// --------------------------------------------------------------------------

describe('composeRuntime — user org extends plugin org', () => {
  it('inherited org includes base plugin roles plus new user roles', () => {
    const plugin = parsePlugin(pluginWithRoleYaml('software-dev', 'BackendDev'));
    const config = minimalBuildConfig({
      orgs: [
        {
          name: 'my-team',
          extends: 'software-dev:product-team',
          roles: [
            { name: 'DataEngineer', agent: 'data-agent', skills: ['python'] },
          ],
        },
      ],
    });
    const registry = mockRegistryAlwaysResolves();

    const runtime = composeRuntime(config, [plugin], registry);

    const allRoles = runtime.orgs[0].teams.flatMap(t => t.roles);
    expect(
      allRoles.some(r => r.name === 'BackendDev' && r.plugin === 'software-dev'),
    ).toBe(true);
    expect(allRoles.some(r => r.name === 'DataEngineer')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// composeRuntime — user role extends plugin role
// --------------------------------------------------------------------------

describe('composeRuntime — user role extends plugin role', () => {
  it('user role extension overrides skills while preserving agent from base', () => {
    const plugin = parsePlugin(pluginWithRoleYaml('software-dev', 'BackendDev'));
    const config = minimalBuildConfig({
      orgs: [
        {
          name: 'my-team',
          extends: 'software-dev:product-team',
          roles: [
            {
              name: 'KotlinBackend',
              extends: 'software-dev:BackendDev',
              skills: ['kotlin'],
            },
          ],
        },
      ],
    });
    const registry = mockRegistryAlwaysResolves();

    const runtime = composeRuntime(config, [plugin], registry);

    const allRoles = runtime.orgs.flatMap(o => o.teams.flatMap(t => t.roles));
    const overriddenRole = allRoles.find(r => r.name === 'KotlinBackend');
    expect(overriddenRole!.skills).toEqual(['kotlin']);
    expect(overriddenRole!.agent).toBe('backend-agent');
  });
});

// --------------------------------------------------------------------------
// composeRuntime — outcome rule precedence
// --------------------------------------------------------------------------

describe('composeRuntime — outcome rule precedence', () => {
  function buildPluginWithOutcomeRule(expression: string, action: 'halt' | 'retry'): PluginDef {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'outcome:',
      '  rules:',
      `    - fail: "${expression}"`,
      `      action: ${action}`,
    ].join('\n');
    return parsePlugin(yaml);
  }

  it('build file rule overrides plugin rule for same expression', () => {
    const plugin = buildPluginWithOutcomeRule('completeness < 70', 'halt');
    const config = minimalBuildConfig({
      outcome: {
        enabled: true,
        rules: [
          { type: 'fail', expression: 'completeness < 70', action: 'retry', maxRetries: 3 },
        ],
        defaultAction: 'halt',
        defaultMaxRetries: 1,
      },
    });
    const registry = mockRegistryAlwaysResolves();

    const runtime = composeRuntime(config, [plugin], registry);

    const rule = runtime.outcomeRules.find(r => r.expression === 'completeness < 70');
    expect(rule!.action).toBe('retry');
    expect(rule!.maxRetries).toBe(3);
  });

  it('outcome enabled:false returns empty outcomeRules', () => {
    const plugin = buildPluginWithOutcomeRule('completeness < 70', 'halt');
    const config = minimalBuildConfig({
      outcome: {
        enabled: false,
        rules: [],
        defaultAction: 'halt',
        defaultMaxRetries: 1,
      },
    });
    const registry = mockRegistryAlwaysResolves();

    const runtime = composeRuntime(config, [plugin], registry);
    expect(runtime.outcomeRules).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// composeRuntime — constraint resolution
// --------------------------------------------------------------------------

describe('composeRuntime — constraint resolution', () => {
  it('resolves specific include to an existing group', () => {
    const yaml = [
      'name: my-plugin',
      'version: 1.0.0',
      'constraints:',
      '  - name: git',
      '    mandatory: "Always respect .gitignore."',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    const config = minimalBuildConfig({
      constraints: {
        include: [{ pluginName: 'my-plugin', groupName: 'git' }],
        mandatory: '',
        optional: '',
      },
    });
    const registry = mockRegistryAlwaysResolves();
    const runtime = composeRuntime(config, [plugin], registry);

    expect(runtime.resolvedConstraints.mandatory).toBe('Always respect .gitignore.');
  });

  it('throws ResolverError for non-existent group include', () => {
    const yaml = [
      'name: my-plugin',
      'version: 1.0.0',
      'constraints:',
      '  - name: git',
      '    mandatory: "Rule."',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    const config = minimalBuildConfig({
      constraints: {
        include: [{ pluginName: 'my-plugin', groupName: 'nonexistent' }],
        mandatory: '',
        optional: '',
      },
    });
    const registry = mockRegistryAlwaysResolves();

    expect(() => composeRuntime(config, [plugin], registry)).toThrow(ResolverError);
  });

  it('produces empty strings when no constraints configured', () => {
    const config = minimalBuildConfig({ constraints: null });
    const registry = mockRegistryAlwaysResolves();
    const runtime = composeRuntime(config, [], registry);

    expect(runtime.resolvedConstraints.mandatory).toBe('');
    expect(runtime.resolvedConstraints.optional).toBe('');
  });
});

// --------------------------------------------------------------------------
// composeRuntime — pillar passthrough
// --------------------------------------------------------------------------

describe('composeRuntime — pillar passthrough', () => {
  it('returns empty pillars when loadedPillars is not provided', () => {
    const config = minimalBuildConfig({ constraints: null });
    const registry = mockRegistryAlwaysResolves();
    const runtime = composeRuntime(config, [], registry);

    expect(runtime.resolvedConstraints.pillars).toEqual([]);
  });

  it('returns provided loadedPillars in resolvedConstraints', () => {
    const config = minimalBuildConfig({
      constraints: { include: [], mandatory: '', optional: '', pillars: ['a.md'] },
    });
    const registry = mockRegistryAlwaysResolves();
    const loadedPillars = [{ path: 'a.md', content: '# Architecture' }];
    const runtime = composeRuntime(config, [], registry, loadedPillars);

    expect(runtime.resolvedConstraints.pillars).toEqual(loadedPillars);
  });

  it('preserves mandatory/optional behavior when loadedPillars is provided', () => {
    const config = minimalBuildConfig({
      constraints: { include: [], mandatory: 'Do not push', optional: 'Use camelCase', pillars: [] },
    });
    const registry = mockRegistryAlwaysResolves();
    const loadedPillars = [{ path: 'guide.md', content: 'Content' }];
    const runtime = composeRuntime(config, [], registry, loadedPillars);

    expect(runtime.resolvedConstraints.mandatory).toBe('Do not push');
    expect(runtime.resolvedConstraints.optional).toBe('Use camelCase');
    expect(runtime.resolvedConstraints.pillars).toEqual(loadedPillars);
  });
});

// --------------------------------------------------------------------------
// parsePlugin — role outcomes parsing
// --------------------------------------------------------------------------

describe('parsePlugin — role outcomes parsing', () => {
  it('parses outcomes field on a plugin role', () => {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'orgs:',
      '  - name: product-team',
      '    teams:',
      '      - name: engineering',
      '        roles:',
      '          - name: BackendDev',
      '            agent: backend-agent',
      '            outcomes:',
      '              - dev',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    const role = plugin.orgs[0].teams[0].roles[0];
    expect(role.outcomes).toEqual(['dev']);
  });

  it('leaves outcomes undefined when not present on role', () => {
    const yaml = pluginWithRoleYaml('software-dev', 'BackendDev');
    const plugin = parsePlugin(yaml);
    const role = plugin.orgs[0].teams[0].roles[0];
    expect(role.outcomes).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// parsePlugin — outcome groups parsing
// --------------------------------------------------------------------------

describe('parsePlugin — outcome groups parsing', () => {
  it('parses outcome.groups with metrics and rules', () => {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'outcome:',
      '  default_action: halt',
      '  default_max_retries: 1',
      '  rules: []',
      '  groups:',
      '    - name: dev',
      '      metrics:',
      '        completeness:',
      '          description: Code completeness',
      '          criteria:',
      '            - All requirements addressed',
      '          scale: "0-100"',
      '      rules:',
      '        - fail: "completeness < 70"',
      '          action: halt',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    expect(plugin.outcome).not.toBeNull();
    expect(plugin.outcome!.groups).toHaveLength(1);
    expect(plugin.outcome!.groups![0].name).toBe('dev');
    expect(plugin.outcome!.groups![0].metrics['completeness'].description).toBe('Code completeness');
    expect(plugin.outcome!.groups![0].rules).toHaveLength(1);
    expect(plugin.outcome!.groups![0].rules[0].expression).toBe('completeness < 70');
  });

  it('leaves groups undefined when not present in outcome block', () => {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'outcome:',
      '  default_action: halt',
      '  default_max_retries: 1',
      '  rules: []',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    expect(plugin.outcome).not.toBeNull();
    expect(plugin.outcome!.groups).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// composeRuntime — role outcomes forwarding
// --------------------------------------------------------------------------

describe('composeRuntime — role outcomes forwarding', () => {
  it('forwards outcomes from plugin role through extends', () => {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'orgs:',
      '  - name: product-team',
      '    teams:',
      '      - name: engineering',
      '        roles:',
      '          - name: BackendDev',
      '            agent: backend-agent',
      '            skills:',
      '              - java',
      '            outcomes:',
      '              - dev',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    const config = minimalBuildConfig({
      orgs: [{ name: 'my-team', extends: 'software-dev:product-team', roles: [] }],
    });
    const registry = mockRegistryAlwaysResolves();
    const runtime = composeRuntime(config, [plugin], registry);

    const allRoles = runtime.orgs.flatMap(o => o.teams.flatMap(t => t.roles));
    const role = allRoles.find(r => r.name === 'BackendDev' && r.plugin === 'software-dev');
    expect(role).toBeDefined();
    expect(role!.outcomes).toEqual(['dev']);
  });

  it('user role outcomes override base role outcomes', () => {
    const yaml = [
      'name: software-dev',
      'version: 1.0.0',
      'orgs:',
      '  - name: product-team',
      '    teams:',
      '      - name: engineering',
      '        roles:',
      '          - name: BackendDev',
      '            agent: backend-agent',
      '            outcomes:',
      '              - dev',
    ].join('\n');
    const plugin = parsePlugin(yaml);
    const config = minimalBuildConfig({
      orgs: [{
        name: 'my-team',
        extends: 'software-dev:product-team',
        roles: [{
          name: 'CustomDev',
          extends: 'software-dev:BackendDev',
          outcomes: ['security'],
        }],
      }],
    });
    const registry = mockRegistryAlwaysResolves();
    const runtime = composeRuntime(config, [plugin], registry);

    const allRoles = runtime.orgs.flatMap(o => o.teams.flatMap(t => t.roles));
    const role = allRoles.find(r => r.name === 'CustomDev');
    expect(role).toBeDefined();
    expect(role!.outcomes).toEqual(['security']);
  });
});
