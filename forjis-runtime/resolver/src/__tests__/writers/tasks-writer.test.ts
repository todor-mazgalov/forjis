/**
 * Unit tests for tasks-writer.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeTasksConfig } from '../../writers/tasks-writer.js';
import { createTestContext } from './helpers.js';

describe('writeTasksConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tasks-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes tasks.yaml with correct fields', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeTasksConfig(ctx);

    expect(result.file).toBe('tasks.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'tasks.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['source']).toBe('dir');
    expect(parsed['path']).toBe('./tasks');
    expect(parsed['poll_interval']).toBe('5m');
    expect(parsed['max_concurrent']).toBe(2);
    expect(parsed['auto_dependencies']).toBe(false);
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writeTasksConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeTasksConfig(ctx2);
    expect(second.written).toBe(false);
  });
});
