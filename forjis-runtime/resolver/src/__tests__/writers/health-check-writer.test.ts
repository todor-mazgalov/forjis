/**
 * Unit tests for health-check-writer.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeHealthCheckConfig } from '../../writers/health-check-writer.js';
import { createTestContext } from './helpers.js';

describe('writeHealthCheckConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'health-check-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes health-check.yaml with interval and max_retries', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeHealthCheckConfig(ctx);

    expect(result.file).toBe('health-check.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'health-check.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['interval']).toBe(300);
    expect(parsed['max_retries']).toBe(3);
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writeHealthCheckConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeHealthCheckConfig(ctx2);
    expect(second.written).toBe(false);
  });
});
