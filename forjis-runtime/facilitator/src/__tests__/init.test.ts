/**
 * Unit tests for commands/init.ts — specifically the .gitignore
 * write-through behaviour introduced by the cache-harden change
 * (spec R10).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureGitignoreEntry, initCommand } from '../commands/init.js';

describe('ensureGitignoreEntry', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'init-gitignore-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates .gitignore when missing', async () => {
    await ensureGitignoreEntry(tmp, '.forjis/context/');
    const content = await readFile(join(tmp, '.gitignore'), 'utf-8');
    expect(content).toBe('.forjis/context/\n');
  });

  it('appends the line when it is missing; existing bytes preserved', async () => {
    const prior = 'node_modules/\ndist/\n';
    await writeFile(join(tmp, '.gitignore'), prior);
    await ensureGitignoreEntry(tmp, '.forjis/context/');
    const content = await readFile(join(tmp, '.gitignore'), 'utf-8');
    expect(content.startsWith(prior)).toBe(true);
    expect(content.trim().split('\n')).toContain('.forjis/context/');
  });

  it('is idempotent — re-running does not duplicate the line', async () => {
    await ensureGitignoreEntry(tmp, '.forjis/context/');
    await ensureGitignoreEntry(tmp, '.forjis/context/');
    const content = await readFile(join(tmp, '.gitignore'), 'utf-8');
    const matches = content
      .split('\n')
      .filter((l) => l.trim() === '.forjis/context/');
    expect(matches).toHaveLength(1);
  });

  it('appends the explicit line even when a broader entry exists', async () => {
    await writeFile(join(tmp, '.gitignore'), '.forjis/\n');
    await ensureGitignoreEntry(tmp, '.forjis/context/');
    const content = await readFile(join(tmp, '.gitignore'), 'utf-8');
    expect(content).toMatch(/\.forjis\/\n/);
    expect(content).toMatch(/\.forjis\/context\/\n/);
  });

  it('inserts a newline before appending when prior file has no trailing newline', async () => {
    await writeFile(join(tmp, '.gitignore'), 'node_modules/');
    await ensureGitignoreEntry(tmp, '.forjis/context/');
    const content = await readFile(join(tmp, '.gitignore'), 'utf-8');
    expect(content).toBe('node_modules/\n.forjis/context/\n');
  });
});

describe('initCommand — end-to-end scaffold', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'init-cmd-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes build.forjis and adds .forjis/context/ to .gitignore', async () => {
    await initCommand(tmp);
    const build = await readFile(join(tmp, 'build.forjis'), 'utf-8');
    expect(build).toContain('version: 1');
    const gitignore = await readFile(join(tmp, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.forjis/context/');
  });
});
