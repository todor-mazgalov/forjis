/**
 * Unit tests for constraints-writer.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeConstraintsConfig } from '../../writers/constraints-writer.js';
import { createTestContext } from './helpers.js';

describe('writeConstraintsConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'constraints-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes constraints.yaml with mandatory and optional fields', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeConstraintsConfig(ctx);

    expect(result.file).toBe('constraints.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['mandatory']).toBe('Do not push to main.');
    expect(parsed['optional']).toBe('');
    expect(parsed['included']).toBeUndefined();
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writeConstraintsConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeConstraintsConfig(ctx2);
    expect(second.written).toBe(false);
  });

  it('serializes pillars with path and content when non-empty', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.resolvedConstraints.pillars = [
      { path: 'specs/arch.md', content: '# Architecture' },
    ];
    await writeConstraintsConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['pillars']).toBeDefined();
    const pillars = parsed['pillars'] as Array<{ path: string; content: string }>;
    expect(pillars).toHaveLength(1);
    expect(pillars[0].path).toBe('specs/arch.md');
    expect(pillars[0].content).toBe('# Architecture');
  });

  it('omits pillars key when array is empty', async () => {
    const ctx = createTestContext(tmpDir);
    await writeConstraintsConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['pillars']).toBeUndefined();
  });

  it('pillars coexist with mandatory and optional fields', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.config.resolvedConstraints.pillars = [
      { path: 'a.md', content: 'content' },
    ];
    await writeConstraintsConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'constraints.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['mandatory']).toBe('Do not push to main.');
    expect(parsed['optional']).toBe('');
    expect(parsed['pillars']).toBeDefined();
  });
});
