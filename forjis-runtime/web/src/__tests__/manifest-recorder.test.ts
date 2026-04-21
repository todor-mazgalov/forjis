/**
 * Backend-layer unit tests for manifest-recorder (Phase D of
 * redesign-013-api-contract-extensions).
 *
 * Validates that:
 *   - First call to a fresh task creates output-files.yaml with the
 *     `files:` header plus one entry.
 *   - Second call with the same (role, path) is a no-op.
 *   - Second call with a different path appends another entry.
 *   - A filePath outside projectDir is dropped.
 *   - The persisted entry's `path` is project-relative with forward slashes.
 *   - The recorded manifest is parseable by ManifestServiceImpl.
 */

import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendManifestEntry, __resetSeen, ManifestServiceImpl } from '@forjis/facilitator';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-manifest-rec-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe('manifest-recorder', () => {
  let projectDir: string;

  beforeEach(async () => {
    __resetSeen();
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('first call writes files: header plus one entry', async () => {
    const ok = await appendManifestEntry(
      projectDir,
      'task-1',
      'Developer',
      join(projectDir, 'src', 'foo.ts'),
      undefined,
      '2026-04-19T10:00:00Z',
    );
    expect(ok).toBe(true);

    const manifestPath = join(projectDir, '.forjis', 'tasks', 'task-1', 'output-files.yaml');
    const raw = await readFile(manifestPath, 'utf-8');

    expect(raw).toContain('files:');
    expect(raw).toContain('- role: Developer');
    expect(raw).toContain('path: src/foo.ts');
    expect(raw).toContain('label: foo.ts');
    expect(raw).toContain('createdAt: "2026-04-19T10:00:00Z"');
  });

  test('second call with same (role, path) is a no-op', async () => {
    await appendManifestEntry(
      projectDir, 'task-2', 'Developer', join(projectDir, 'src', 'a.ts'),
      undefined, '2026-04-19T10:00:00Z',
    );
    const manifestPath = join(projectDir, '.forjis', 'tasks', 'task-2', 'output-files.yaml');
    const before = await readFile(manifestPath, 'utf-8');

    const second = await appendManifestEntry(
      projectDir, 'task-2', 'Developer', join(projectDir, 'src', 'a.ts'),
    );
    expect(second).toBe(false);

    const after = await readFile(manifestPath, 'utf-8');
    expect(after).toBe(before);
  });

  test('second call with a different path appends a second entry', async () => {
    await appendManifestEntry(
      projectDir, 'task-3', 'Developer', join(projectDir, 'src', 'a.ts'),
      undefined, '2026-04-19T10:00:00Z',
    );
    const second = await appendManifestEntry(
      projectDir, 'task-3', 'Developer', join(projectDir, 'src', 'b.ts'),
      undefined, '2026-04-19T10:00:01Z',
    );
    expect(second).toBe(true);

    const manifestPath = join(projectDir, '.forjis', 'tasks', 'task-3', 'output-files.yaml');
    const raw = await readFile(manifestPath, 'utf-8');
    expect(raw).toContain('path: src/a.ts');
    expect(raw).toContain('path: src/b.ts');

    // Only one files: header should be written.
    const headerCount = raw.split('\n').filter((line) => line === 'files:').length;
    expect(headerCount).toBe(1);
  });

  test('drops paths that resolve outside the project directory', async () => {
    const ok = await appendManifestEntry(
      projectDir, 'task-4', 'Developer', '/etc/passwd',
    );
    expect(ok).toBe(false);

    // Manifest file must not have been created.
    const manifestPath = join(projectDir, '.forjis', 'tasks', 'task-4', 'output-files.yaml');
    await expect(stat(manifestPath)).rejects.toThrow();
  });

  test('drops paths that traverse out of the project via ..', async () => {
    const ok = await appendManifestEntry(
      projectDir, 'task-5', 'Developer', '../escape.txt',
    );
    expect(ok).toBe(false);
  });

  test('persisted manifest is parseable by ManifestServiceImpl', async () => {
    await appendManifestEntry(
      projectDir, 'task-6', 'Developer', join(projectDir, 'doc.md'),
      undefined, '2026-04-19T10:00:00Z',
    );
    await appendManifestEntry(
      projectDir, 'task-6', 'Reviewer', join(projectDir, 'review.md'),
      'review summary', '2026-04-19T10:01:00Z',
    );

    const svc = new ManifestServiceImpl(projectDir);
    const result = await svc.getManifest('task-6');

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({
      role: 'Developer',
      path: 'doc.md',
      label: 'doc.md',
      createdAt: '2026-04-19T10:00:00Z',
    });
    expect(result.files[1]).toMatchObject({
      role: 'Reviewer',
      path: 'review.md',
      label: 'review summary',
      createdAt: '2026-04-19T10:01:00Z',
    });
  });

  test('writes path with forward slashes regardless of input separators', async () => {
    await appendManifestEntry(
      projectDir, 'task-7', 'Developer',
      join(projectDir, 'src', 'nested', 'deep.ts'),
      undefined, '2026-04-19T10:00:00Z',
    );
    const manifestPath = join(projectDir, '.forjis', 'tasks', 'task-7', 'output-files.yaml');
    const raw = await readFile(manifestPath, 'utf-8');

    expect(raw).toContain('path: src/nested/deep.ts');
    // Negative assertion: no Windows-style separator anywhere in the path line.
    const pathLine = raw.split('\n').find((l) => l.includes('path:'));
    expect(pathLine).toBeDefined();
    expect(pathLine!).not.toContain('\\');
  });
});
