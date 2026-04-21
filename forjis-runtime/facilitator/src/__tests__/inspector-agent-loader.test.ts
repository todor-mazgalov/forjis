/**
 * Unit tests for inspector-agent-loader.ts.
 *
 * Validates default-path resolution, override handling (absolute and
 * relative-to-configDir), frontmatter parsing of the bundled agent, and
 * error paths for malformed agent files.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getDefaultClarifierPath,
  loadClarifierAgent,
} from '../inspector-agent-loader.js';

describe('getDefaultClarifierPath', () => {
  it('returns a path that exists on disk when no override is supplied', () => {
    const path = getDefaultClarifierPath();
    expect(path).toMatch(/forjis-inspector\.md$/);
    // The bundled asset must be reachable from the loader's compiled
    // location; the tested function throws if it isn't.
    expect(() => getDefaultClarifierPath()).not.toThrow();
  });

  it('honours an absolute override path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'forjis-clarifier-abs-'));
    const overridePath = join(tmp, 'custom.md');
    await writeFile(overridePath, '---\nname: x\ndescription: y\nmodel: z\ntools: [Read]\n---\n\nbody\n', 'utf-8');
    try {
      expect(getDefaultClarifierPath({ clarifier: overridePath })).toBe(overridePath);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('resolves a relative override against configDir', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'forjis-clarifier-rel-'));
    const overridePath = join(tmp, 'custom.md');
    await writeFile(overridePath, '---\nname: x\ndescription: y\nmodel: z\ntools: [Read]\n---\n\nbody\n', 'utf-8');
    try {
      expect(getDefaultClarifierPath({ clarifier: 'custom.md' }, tmp)).toBe(overridePath);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when the override path does not exist', () => {
    expect(() =>
      getDefaultClarifierPath({ clarifier: '/nonexistent/agents/clarifier.md' })
    ).toThrow(/not found/);
  });

  it('treats an empty-string override as if no override was supplied', () => {
    expect(getDefaultClarifierPath({ clarifier: '' })).toMatch(/forjis-inspector\.md$/);
  });
});

describe('loadClarifierAgent — bundled default', () => {
  it('parses the bundled agent and returns expected frontmatter values', () => {
    const agent = loadClarifierAgent();
    expect(agent.name).toBe('forjis-inspector');
    expect(agent.model).toBe('sonnet');
    expect(agent.tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Glob']));
    expect(agent.description.length).toBeGreaterThan(0);
    expect(agent.sourcePath).toMatch(/forjis-inspector\.md$/);
  });

  it('returns a non-empty body containing the contract markers', () => {
    const agent = loadClarifierAgent();
    expect(agent.body.length).toBeGreaterThan(100);
    expect(agent.body).toContain('question');
    expect(agent.body).toContain('finalize');
  });
});

describe('loadClarifierAgent — error paths', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'forjis-clarifier-err-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('throws when the frontmatter delimiter is missing', async () => {
    const path = join(tmp, 'no-frontmatter.md');
    await writeFile(path, 'just a markdown body, no frontmatter\n', 'utf-8');
    expect(() => loadClarifierAgent({ clarifier: path })).toThrow(
      /missing a YAML frontmatter/
    );
  });

  it('throws when a required frontmatter key is missing', async () => {
    const path = join(tmp, 'missing-name.md');
    await writeFile(
      path,
      '---\ndescription: x\nmodel: sonnet\ntools: [Read]\n---\n\nbody\n',
      'utf-8'
    );
    expect(() => loadClarifierAgent({ clarifier: path })).toThrow(
      /missing required frontmatter field "name"/
    );
  });

  it('throws when tools is missing', async () => {
    const path = join(tmp, 'missing-tools.md');
    await writeFile(
      path,
      '---\nname: x\ndescription: y\nmodel: z\n---\n\nbody\n',
      'utf-8'
    );
    expect(() => loadClarifierAgent({ clarifier: path })).toThrow(
      /missing required frontmatter field "tools"/
    );
  });

  it('throws when the body is empty after the frontmatter', async () => {
    const path = join(tmp, 'empty-body.md');
    await writeFile(
      path,
      '---\nname: x\ndescription: y\nmodel: z\ntools: [Read]\n---\n\n   \n',
      'utf-8'
    );
    expect(() => loadClarifierAgent({ clarifier: path })).toThrow(
      /empty body/
    );
  });

  it('accepts comma-separated tools string form', async () => {
    const path = join(tmp, 'csv-tools.md');
    await writeFile(
      path,
      '---\nname: x\ndescription: y\nmodel: z\ntools: "Read, Write, Glob"\n---\n\nbody\n',
      'utf-8'
    );
    const agent = loadClarifierAgent({ clarifier: path });
    expect(agent.tools).toEqual(['Read', 'Write', 'Glob']);
  });
});
