/**
 * Unit tests for orgs-writer.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeOrgsConfig } from '../../writers/orgs-writer.js';
import { createTestContext } from './helpers.js';

describe('writeOrgsConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orgs-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes orgs.yaml with version and orgs array', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeOrgsConfig(ctx);

    expect(result.file).toBe('orgs.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'orgs.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['version']).toBe(1);
    expect(Array.isArray(parsed['orgs'])).toBe(true);
  });

  it('resolves agent paths to absolute file paths', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeOrgsConfig(ctx);

    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'orgs.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const orgs = parsed['orgs'] as Array<Record<string, unknown>>;
    const teams = orgs[0]['teams'] as Array<Record<string, unknown>>;
    const roles = teams[0]['roles'] as Array<Record<string, unknown>>;

    expect(roles[0]['agent']).toContain('/agents/');
  });

  it('includes outcomes array on each role', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeOrgsConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'orgs.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const orgs = parsed['orgs'] as Array<Record<string, unknown>>;
    const teams = orgs[0]['teams'] as Array<Record<string, unknown>>;
    const roles = teams[0]['roles'] as Array<Record<string, unknown>>;

    expect(roles[0]['outcomes']).toEqual([]);
  });

  it('skips write on second call with same input', async () => {
    const ctx = createTestContext(tmpDir);
    const first = await writeOrgsConfig(ctx);
    expect(first.written).toBe(true);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeOrgsConfig(ctx2);
    expect(second.written).toBe(false);
  });
});
