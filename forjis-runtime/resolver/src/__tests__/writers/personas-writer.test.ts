/**
 * Unit tests for personas-writer.ts.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { writePersonasConfig } from '../../writers/personas-writer.js';
import { createTestContext } from './helpers.js';

describe('writePersonasConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'personas-writer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes personas.yaml with empty array when no personas dir configured', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writePersonasConfig(ctx);

    expect(result.file).toBe('personas.yaml');
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed['dir']).toBeNull();
    expect(parsed['personas']).toEqual([]);
  });

  it('derives persona name from the markdown filename', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'analyst.md'), [
      '---',
      'description: Data analysis persona',
      'tools:',
      '  - Read',
      '  - Bash',
      'model: claude-sonnet-4-20250514',
      '---',
      'You are an analyst.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };

    const result = await writePersonasConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed['dir']).toBe('personas');
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('analyst');
    expect(personas[0]['description']).toBe('Data analysis persona');
    expect(personas[0]['tools']).toEqual(['Read', 'Bash']);
    expect(personas[0]['content']).toBe('You are an analyst.');
  });

  it('ignores name field in frontmatter and uses filename instead', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'my-assistant.md'), [
      '---',
      'name: wrong-name',
      'description: Should use filename',
      '---',
      'Body text.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('my-assistant');
  });

  it('handles persona files without YAML frontmatter', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'simple-bot.md'), 'Just plain markdown content.');

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('simple-bot');
    expect(personas[0]['content']).toBe('Just plain markdown content.');
    expect(personas[0]['description']).toBe('');
  });

  it('skips write when checksum is unchanged', async () => {
    const ctx = createTestContext(tmpDir);
    await writePersonasConfig(ctx);

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    const second = await writePersonasConfig(ctx2);
    expect(second.written).toBe(false);
  });

  it('regenerates when a new persona file is added after initial write', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'analyst.md'), [
      '---',
      'description: Data analysis persona',
      'tools:',
      '  - Read',
      'model: claude-sonnet-4-20250514',
      '---',
      'You are an analyst.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);
    expect(ctx.cacheEntries['config:personas']).toBeDefined();

    // Add a second persona file
    await writeFile(join(personasDir, 'designer.md'), [
      '---',
      'description: UX designer persona',
      'tools:',
      '  - Read',
      '  - Write',
      'model: claude-sonnet-4-20250514',
      '---',
      'You are a designer.',
    ].join('\n'));

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    ctx2.buildConfig.personas = { dir: 'personas' };
    const second = await writePersonasConfig(ctx2);
    expect(second.written).toBe(true);

    const content = await readFile(join(ctx2.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(2);
    expect(personas[0]['name']).toBe('analyst');
    expect(personas[1]['name']).toBe('designer');
  });

  it('writes dir as string when personas dir is configured with trailing slash', async () => {
    const personasDir = join(tmpDir, 'my-personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'tester.md'), [
      '---',
      'description: QA tester',
      'tools:',
      '  - Bash',
      'model: ""',
      '---',
      'You are a tester.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'my-personas/' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed['dir']).toBe('my-personas/');
    expect(parsed).toHaveProperty('personas');
    const personas = parsed['personas'] as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('tester');
  });

  it('output YAML has dir as first key before personas', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await writePersonasConfig(ctx);
    expect(result.written).toBe(true);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const dirIndex = content.indexOf('dir:');
    const personasIndex = content.indexOf('personas:');
    expect(dirIndex).toBeGreaterThanOrEqual(0);
    expect(personasIndex).toBeGreaterThan(dirIndex);
  });

  it('derives names correctly for filenames with underscores and dots', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'my_assistant.md'), [
      '---',
      'description: Underscore name',
      '---',
      'Underscore persona.',
    ].join('\n'));
    await writeFile(join(personasDir, 'v2.0-bot.md'), [
      '---',
      'description: Dotted name',
      '---',
      'Dotted persona.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(2);
    expect(personas[0]['name']).toBe('my_assistant');
    expect(personas[1]['name']).toBe('v2.0-bot');
  });

  it('derives names for multiple persona files simultaneously', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'alpha.md'), '---\ndescription: Alpha\n---\nAlpha body.');
    await writeFile(join(personasDir, 'beta.md'), '---\ndescription: Beta\n---\nBeta body.');
    await writeFile(join(personasDir, 'gamma.md'), '---\ndescription: Gamma\n---\nGamma body.');

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(3);
    // Sorted alphabetically by filename
    expect(personas[0]['name']).toBe('alpha');
    expect(personas[1]['name']).toBe('beta');
    expect(personas[2]['name']).toBe('gamma');
    // Each gets its own description from frontmatter
    expect(personas[0]['description']).toBe('Alpha');
    expect(personas[1]['description']).toBe('Beta');
    expect(personas[2]['description']).toBe('Gamma');
  });

  it('ignores non-md files in the personas directory', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'valid.md'), 'Valid persona.');
    await writeFile(join(personasDir, 'ignore-me.txt'), 'Not a persona.');
    await writeFile(join(personasDir, 'also-ignore.yaml'), 'name: nope');

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('valid');
  });

  it('handles empty YAML frontmatter without crashing', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'empty-front.md'), '---\n\n---\nBody after empty frontmatter.');

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('empty-front');
    expect(personas[0]['content']).toBe('Body after empty frontmatter.');
    expect(personas[0]['description']).toBe('');
  });

  it('frontmatter name field does not leak into output when present', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'real-name.md'), [
      '---',
      'name: fake-name',
      'description: Has both name fields',
      'tools:',
      '  - Read',
      '---',
      'Content here.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    const content = await readFile(join(ctx.configDir, 'personas.yaml'), 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown>;
    const personas = parsed['personas'] as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]['name']).toBe('real-name');
    // Ensure 'fake-name' does not appear anywhere in the output
    expect(content).not.toContain('fake-name');
  });

  it('regenerates when an existing persona file is modified', async () => {
    const personasDir = join(tmpDir, 'personas');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, 'analyst.md'), [
      '---',
      'description: Original description',
      'tools:',
      '  - Read',
      'model: claude-sonnet-4-20250514',
      '---',
      'Original content.',
    ].join('\n'));

    const ctx = createTestContext(tmpDir);
    ctx.buildConfig.personas = { dir: 'personas' };
    await writePersonasConfig(ctx);

    // Modify the persona file
    await writeFile(join(personasDir, 'analyst.md'), [
      '---',
      'description: Updated description',
      'tools:',
      '  - Read',
      '  - Bash',
      'model: claude-sonnet-4-20250514',
      '---',
      'Updated content.',
    ].join('\n'));

    const ctx2 = createTestContext(tmpDir, ctx.cacheEntries);
    ctx2.buildConfig.personas = { dir: 'personas' };
    const second = await writePersonasConfig(ctx2);
    expect(second.written).toBe(true);
  });
});
