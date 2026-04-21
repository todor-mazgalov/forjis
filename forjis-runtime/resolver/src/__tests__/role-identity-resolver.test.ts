/**
 * Unit tests for resolver-time role identity validation.
 *
 * These tests assert that `composeRuntime` rejects source-config names
 * whose role fields contain reserved characters (`:` outside the internal
 * `plugin:` scoping prefix, or `@`) — the guard introduced by the
 * fix-roles-display change. They also verify that valid roles emerge with
 * populated `org` and `team` fields.
 */

import { jest } from '@jest/globals';
import { composeRuntime, parsePlugin } from '../plugin-compositor.js';
import { ResolverError } from '../errors.js';
import type { BuildConfig } from '../types.js';
import type { ResourceRegistry } from '../repo/index.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function mockRegistryAlwaysResolves(): ResourceRegistry {
  return {
    resolve: jest.fn().mockReturnValue({ filePath: '/fake/path.yaml', name: 'resource' }),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ResourceRegistry;
}

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
// Denormalised identity on RuntimeRole
// --------------------------------------------------------------------------

describe('composeRuntime — denormalised org/team on RuntimeRole', () => {
  it('populates org and team from the parent containers', () => {
    const plugin = parsePlugin([
      'name: software-dev',
      'version: 1.0.0',
      'orgs:',
      '  - name: product-team',
      '    teams:',
      '      - name: engineering',
      '        roles:',
      '          - name: BackendDev',
      '            agent: dev-agent',
    ].join('\n'));

    const config = minimalBuildConfig({
      orgs: [{ name: 'my-team', extends: 'software-dev:product-team', roles: [] }],
    });

    const runtime = composeRuntime(config, [plugin], mockRegistryAlwaysResolves());
    const role = runtime.orgs[0].teams[0].roles[0];

    expect(role.org).toBe('my-team');
    expect(role.team).toBe('engineering');
  });
});

// --------------------------------------------------------------------------
// Reserved-character rejection
// --------------------------------------------------------------------------

describe('composeRuntime — reserved-character rejection', () => {
  it('rejects a role whose name contains "@"', () => {
    const config = minimalBuildConfig({
      orgs: [
        {
          name: 'my-team',
          roles: [
            { name: 'bad@role', agent: 'dev-agent', skills: [] },
          ],
        },
      ],
    });

    expect(() => composeRuntime(config, [], mockRegistryAlwaysResolves())).toThrow(ResolverError);
  });

  it('rejects a team name that contains "@"', () => {
    const config = minimalBuildConfig({
      orgs: [
        {
          name: 'my-team',
          teams: [
            {
              name: 'bad@team',
              roles: [{ name: 'ok-role', agent: 'dev-agent', skills: [] }],
            },
          ],
          roles: [],
        },
      ],
    });

    expect(() => composeRuntime(config, [], mockRegistryAlwaysResolves())).toThrow(ResolverError);
  });

  it('rejects an org name that contains a newline', () => {
    const config = minimalBuildConfig({
      orgs: [
        {
          name: 'bad\nname',
          roles: [
            { name: 'ok-role', agent: 'dev-agent', skills: [] },
          ],
        },
      ],
    });

    expect(() => composeRuntime(config, [], mockRegistryAlwaysResolves())).toThrow(ResolverError);
  });

  it('accepts a role whose internal plugin: prefix is an implementation detail', () => {
    const plugin = parsePlugin([
      'name: software-dev',
      'version: 1.0.0',
      'orgs:',
      '  - name: product-team',
      '    teams:',
      '      - name: engineering',
      '        roles:',
      '          - name: BackendDev',
      '            agent: dev-agent',
    ].join('\n'));

    const config = minimalBuildConfig({
      orgs: [{ name: 'my-team', extends: 'software-dev:product-team', roles: [] }],
    });

    // Scoped name `software-dev:BackendDev` contains `:` but the validation
    // is scoped to the bare user-authored `BackendDev`, so this must pass.
    expect(() => composeRuntime(config, [plugin], mockRegistryAlwaysResolves())).not.toThrow();
  });
});
