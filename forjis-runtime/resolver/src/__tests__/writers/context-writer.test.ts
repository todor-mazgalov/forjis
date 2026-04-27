/**
 * Unit tests for context-writer.ts.
 *
 * Verifies the resolver writes `.forjis/config/context.yaml` atomically
 * with the resolved {@link ContextConfig} values, and skips the write
 * when the checksum cache entry is unchanged.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeContextConfig } from '../../writers/context-writer.js';
import { createTestContext } from './helpers.js';

describe('writeContextConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'context-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes context.yaml with the resolved values', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeContextConfig(ctx);

    expect(result.file).toBe('context.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(
      join(ctx.configDir, 'context.yaml'),
      'utf-8',
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed['refresh_on_task']).toBe(true);
    expect(parsed['inline_top_n']).toBe(20);
    expect(parsed['concurrency']).toBe(16);
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writeContextConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeContextConfig(ctx2);
    expect(second.written).toBe(false);
  });

  it('emits explicit false / custom inline_top_n when present in build config', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.context = {
      refresh_on_task: false,
      inline_top_n: 5,
      concurrency: 8,
    };

    await writeContextConfig(ctx);
    const content = await readFile(
      join(ctx.configDir, 'context.yaml'),
      'utf-8',
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed['refresh_on_task']).toBe(false);
    expect(parsed['inline_top_n']).toBe(5);
    expect(parsed['concurrency']).toBe(8);
  });
});
