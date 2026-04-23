/**
 * Unit tests for task-rules-writer.ts.
 *
 * Covers the happy path (writes `task-rules.yaml` with the emitted rules in
 * include order), the always-emit contract when no rules are resolved
 * (FR-012), and the skip-on-unchanged-checksum behaviour shared with the
 * other writers.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writeTaskRulesConfig } from '../../writers/task-rules-writer.js';
import type { ResolvedTaskRule } from '../../types.js';
import { createTestContext } from './helpers.js';

const SAMPLE_RULE: ResolvedTaskRule = {
  name: 'text-rename',
  plugin: 'software-dev',
  matches: { task_title: '^rename .+ to .+' },
  skip: ['playground:Frontend:Explorer'],
  prompt_prepends: { developer: 'Single-edit rename.' },
};

const SECOND_RULE: ResolvedTaskRule = {
  name: 'bump-dep',
  plugin: 'software-dev',
  matches: { task_title: '^bump .+' },
  skip: [],
  prompt_prepends: {},
};

describe('writeTaskRulesConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'task-rules-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('7.19 writes task-rules.yaml with version: 1 and rules in include order', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.resolvedTaskRules = [SAMPLE_RULE, SECOND_RULE];

    const result = await writeTaskRulesConfig(ctx);
    expect(result.file).toBe('task-rules.yaml');
    expect(result.written).toBe(true);

    const raw = await readFile(join(ctx.configDir, 'task-rules.yaml'), 'utf-8');
    expect(raw).toContain('# Machine-generated. Order is significant (first-match-wins).');

    const parsed = parseYaml(raw) as { version: number; rules: ResolvedTaskRule[] };
    expect(parsed.version).toBe(1);
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0].name).toBe('text-rename');
    expect(parsed.rules[0].plugin).toBe('software-dev');
    expect(parsed.rules[0].matches).toEqual({ task_title: '^rename .+ to .+' });
    expect(parsed.rules[0].skip).toEqual(['playground:Frontend:Explorer']);
    expect(parsed.rules[0].prompt_prepends).toEqual({ developer: 'Single-edit rename.' });
    expect(parsed.rules[1].name).toBe('bump-dep');
  });

  it('7.20 emits an empty list when no rules are resolved', async () => {
    const ctx = createTestContext(tmpDir);
    ctx.resolvedTaskRules = [];

    const result = await writeTaskRulesConfig(ctx);
    expect(result.written).toBe(true);

    const raw = await readFile(join(ctx.configDir, 'task-rules.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as { version: number; rules: ResolvedTaskRule[] };
    expect(parsed.version).toBe(1);
    expect(parsed.rules).toEqual([]);
  });

  it('7.21 skips write when the checksum matches the previous cache entry', async () => {
    const first = createTestContext(tmpDir);
    first.resolvedTaskRules = [SAMPLE_RULE];

    const firstResult = await writeTaskRulesConfig(first);
    expect(firstResult.written).toBe(true);

    const filePath = join(first.configDir, 'task-rules.yaml');
    const mtime1 = (await stat(filePath)).mtimeMs;

    const second = createTestContext(tmpDir, first.cacheEntries);
    second.resolvedTaskRules = [SAMPLE_RULE];

    const secondResult = await writeTaskRulesConfig(second);
    expect(secondResult.written).toBe(false);

    const mtime2 = (await stat(filePath)).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });
});
