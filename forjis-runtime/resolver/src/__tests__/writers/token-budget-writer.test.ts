/**
 * Unit tests for token-budget-writer.ts.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeTokenBudgetConfig } from '../../writers/token-budget-writer.js';
import { createTestContext } from './helpers.js';

describe('writeTokenBudgetConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'token-budget-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes token-budget.yaml with max_tokens and reset_window', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writeTokenBudgetConfig(ctx);

    expect(result.file).toBe('token-budget.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'token-budget.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed['max_tokens']).toBe(500000);
    expect(parsed['reset_window']).toBe('1h');
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writeTokenBudgetConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writeTokenBudgetConfig(ctx2);
    expect(second.written).toBe(false);
  });
});
