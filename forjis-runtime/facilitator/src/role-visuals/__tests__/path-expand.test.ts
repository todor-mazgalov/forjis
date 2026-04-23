/**
 * Unit tests for `expandFileGlob` / `expandDirRecursive` in path-expand.ts.
 *
 * Uses `mkdtemp` fixtures exclusively — no filesystem access outside
 * the per-test temp root. Covers glob matches, empty globs,
 * `..`-escape rejection, symlink-escape containment, depth boundaries,
 * and the 5 MB per-file size gate.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expandDirRecursive, expandFileGlob } from '../path-expand.js';

describe('expandFileGlob', () => {
  let tmpDir: string;
  let realTmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'path-expand-glob-'));
    // On macOS `/var/folders/...` resolves to `/private/var/folders/...`
    // via realpath. The expander normalises every emitted path, so
    // expectations must compare against the resolved form.
    realTmpDir = await realpath(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns matches for a simple glob', async () => {
    await mkdir(join(tmpDir, 'design', 'mockups'), { recursive: true });
    await writeFile(join(tmpDir, 'design', 'mockups', 'a.png'), 'x', 'utf-8');
    await writeFile(join(tmpDir, 'design', 'mockups', 'b.png'), 'y', 'utf-8');
    await writeFile(join(tmpDir, 'design', 'mockups', 'c.txt'), 'z', 'utf-8');

    const result = await expandFileGlob('file://design/mockups/*.png', {
      projectDir: tmpDir,
    });
    expect(result.paths).toEqual([
      join(realTmpDir, 'design', 'mockups', 'a.png'),
      join(realTmpDir, 'design', 'mockups', 'b.png'),
    ]);
    expect(result.escapeWarnings).toEqual([]);
  });

  it('returns empty when no files match', async () => {
    await mkdir(join(tmpDir, 'design'), { recursive: true });
    const result = await expandFileGlob('file://design/*.png', {
      projectDir: tmpDir,
    });
    expect(result.paths).toEqual([]);
  });

  it('rejects patterns with raw .. segments', async () => {
    const result = await expandFileGlob('file://../../etc/*.png', {
      projectDir: tmpDir,
    });
    expect(result.paths).toEqual([]);
    expect(result.escapeWarnings[0]).toContain('".." segment');
  });

  it('drops matches whose realpath escapes projectDir via symlink', async () => {
    await mkdir(join(tmpDir, 'inside'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'outside-fixture-'));
    try {
      await writeFile(join(outside, 'secret.png'), 'x', 'utf-8');
      await symlink(
        join(outside, 'secret.png'),
        join(tmpDir, 'inside', 'leak.png')
      );

      const result = await expandFileGlob('file://inside/*.png', {
        projectDir: tmpDir,
      });
      expect(result.paths).toEqual([]);
      expect(result.escapeWarnings[0]).toMatch(/escapes projectDir/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('expandDirRecursive', () => {
  let tmpDir: string;
  let realTmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'path-expand-dir-'));
    realTmpDir = await realpath(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('honours max depth (default 3)', async () => {
    // Tree structure under dir://root:
    //   root/a.txt                (depth 1)
    //   root/sub1/b.txt            (depth 2)
    //   root/sub1/sub2/c.txt       (depth 3)
    //   root/sub1/sub2/sub3/d.txt  (depth 4 — dropped)
    await mkdir(join(tmpDir, 'root', 'sub1', 'sub2', 'sub3'), {
      recursive: true,
    });
    await writeFile(join(tmpDir, 'root', 'a.txt'), 'a', 'utf-8');
    await writeFile(join(tmpDir, 'root', 'sub1', 'b.txt'), 'b', 'utf-8');
    await writeFile(join(tmpDir, 'root', 'sub1', 'sub2', 'c.txt'), 'c', 'utf-8');
    await writeFile(join(tmpDir, 'root', 'sub1', 'sub2', 'sub3', 'd.txt'), 'd', 'utf-8');

    const result = await expandDirRecursive('dir://root', { projectDir: tmpDir });
    expect(result.paths).toEqual([
      join(realTmpDir, 'root', 'a.txt'),
      join(realTmpDir, 'root', 'sub1', 'b.txt'),
      join(realTmpDir, 'root', 'sub1', 'sub2', 'c.txt'),
    ]);
  });

  it('drops files exceeding maxFileSize with a skip record', async () => {
    await mkdir(join(tmpDir, 'root'), { recursive: true });
    await writeFile(join(tmpDir, 'root', 'small.bin'), 'xy', 'utf-8');
    await writeFile(
      join(tmpDir, 'root', 'big.bin'),
      Buffer.alloc(2048, 1)
    );

    const result = await expandDirRecursive('dir://root', {
      projectDir: tmpDir,
      maxFileSize: 1024,
    });
    expect(result.paths).toEqual([join(realTmpDir, 'root', 'small.bin')]);
    expect(result.skipped.some(s => s.reason === 'too-large')).toBe(true);
  });

  it('rejects raw .. segments', async () => {
    const result = await expandDirRecursive('dir://../outside', {
      projectDir: tmpDir,
    });
    expect(result.paths).toEqual([]);
    expect(result.skipped[0].reason).toBe('escape');
  });

  it('drops files whose realpath escapes via symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-dir-'));
    try {
      await writeFile(join(outside, 'escaped.txt'), 'boom', 'utf-8');
      await mkdir(join(tmpDir, 'root'), { recursive: true });
      await symlink(join(outside, 'escaped.txt'), join(tmpDir, 'root', 'link.txt'));

      const result = await expandDirRecursive('dir://root', {
        projectDir: tmpDir,
      });
      expect(result.paths).toEqual([]);
      expect(result.skipped.some(s => s.reason === 'escape')).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
