/**
 * Unit tests for outcomes-writer.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeOutcomesConfig } from '../../writers/outcomes-writer.js';
import { createTestContext } from './helpers.js';
import type { PluginDef } from '../../types.js';

describe('writeOutcomesConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'outcomes-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes outcomes.yaml with defaultAction, defaultMaxRetries, and outcomes array', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeOutcomesConfig(ctx);

    expect(result.file).toBe('outcomes.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'outcomes.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['defaultAction']).toBe('halt');
    expect(parsed['defaultMaxRetries']).toBe(1);
    expect(Array.isArray(parsed['outcomes'])).toBe(true);

    const outcomes = parsed['outcomes'] as Array<Record<string, unknown>>;
    expect(outcomes[0]['name']).toBe('default');
  });

  it('uses named groups when outcome groups are defined', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.outcome = {
      enabled: true,
      rules: [],
      defaultAction: 'halt',
      defaultMaxRetries: 1,
      groups: [
        {
          name: 'security',
          metrics: {
            security_score: { description: 'Security score', criteria: ['No CVEs'], scale: '0-100' },
          },
          rules: [{ type: 'fail', expression: 'security_score < 80', action: 'halt' }],
        },
      ],
    };

    const result = await writeOutcomesConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'outcomes.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const outcomes = parsed['outcomes'] as Array<Record<string, unknown>>;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]['name']).toBe('security');
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writeOutcomesConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeOutcomesConfig(ctx2);
    expect(second.written).toBe(false);
  });

  it('auto-includes plugin outcome group when referenced by a role', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.orgs = [
      {
        name: 'test-org',
        teams: [
          {
            name: 'default',
            roles: [
              {
                name: 'Developer',
                agent: 'dev-agent',
                skills: ['typescript'],
                hooks: { pre: [], validation: [], post: [] },
                outcomes: ['dev'],
              },
            ],
          },
        ],
      },
    ];
    const plugin: PluginDef = {
      name: 'software-dev',
      version: '1.0.0',
      requires: { agents: [], skills: [], hooks: [] },
      orgs: [],
      pipeline: null,
      outcome: {
        rules: [],
        defaultAction: 'halt',
        defaultMaxRetries: 1,
        groups: [
          {
            name: 'dev',
            metrics: {
              completeness: { description: 'Code completeness', criteria: ['All reqs'], scale: '0-100' },
            },
            rules: [{ type: 'fail', expression: 'completeness < 70', action: 'halt' }],
          },
        ],
      },
      metrics: new Map(),
      constraints: [],
      rules: [],
    };
    ctx.plugins = [plugin];

    const result = await writeOutcomesConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'outcomes.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const outcomes = parsed['outcomes'] as Array<Record<string, unknown>>;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]['name']).toBe('dev');
    expect(outcomes[0]['metrics']).toBeDefined();
  });

  it('build-file group takes precedence over plugin group with same name', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.orgs = [
      {
        name: 'test-org',
        teams: [
          {
            name: 'default',
            roles: [
              {
                name: 'Developer',
                agent: 'dev-agent',
                skills: [],
                hooks: { pre: [], validation: [], post: [] },
                outcomes: ['dev'],
              },
            ],
          },
        ],
      },
    ];
    ctx.buildConfig.outcome = {
      enabled: true,
      rules: [],
      defaultAction: 'halt',
      defaultMaxRetries: 1,
      groups: [
        {
          name: 'dev',
          metrics: {
            build_quality: { description: 'Build quality from build file', criteria: ['Passes CI'], scale: '0-100' },
          },
          rules: [{ type: 'fail', expression: 'build_quality < 80' }],
        },
      ],
    };
    const plugin: PluginDef = {
      name: 'software-dev',
      version: '1.0.0',
      requires: { agents: [], skills: [], hooks: [] },
      orgs: [],
      pipeline: null,
      outcome: {
        rules: [],
        defaultAction: 'halt',
        defaultMaxRetries: 1,
        groups: [
          {
            name: 'dev',
            metrics: {
              completeness: { description: 'Plugin completeness', criteria: ['All reqs'], scale: '0-100' },
            },
            rules: [{ type: 'fail', expression: 'completeness < 70' }],
          },
        ],
      },
      metrics: new Map(),
      constraints: [],
      rules: [],
    };
    ctx.plugins = [plugin];

    const result = await writeOutcomesConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'outcomes.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const outcomes = parsed['outcomes'] as Array<Record<string, unknown>>;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]['name']).toBe('dev');
    const metrics = outcomes[0]['metrics'] as Record<string, unknown>;
    expect(metrics['build_quality']).toBeDefined();
    expect(metrics['completeness']).toBeUndefined();
  });

  it('falls back to default group when no role outcomes and no build-file groups', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.orgs = [
      {
        name: 'test-org',
        teams: [
          {
            name: 'default',
            roles: [
              {
                name: 'Developer',
                agent: 'dev-agent',
                skills: [],
                hooks: { pre: [], validation: [], post: [] },
              },
            ],
          },
        ],
      },
    ];
    ctx.buildConfig.outcome = null;
    ctx.plugins = [];

    const result = await writeOutcomesConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'outcomes.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const outcomes = parsed['outcomes'] as Array<Record<string, unknown>>;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]['name']).toBe('default');
  });
});
