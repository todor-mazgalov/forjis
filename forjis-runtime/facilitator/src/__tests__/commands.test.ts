/**
 * Unit tests for command business logic — initCommand.
 *
 * Infrastructure commands (validate, status, assess, registry) depend heavily
 * on repositories and plugins which are integration concerns. The init command
 * has testable pure business logic: file existence guard and file creation.
 *
 * Requirements validated:
 *   Init command — creates build.forjis scaffold
 *   Init command — refuses when file already exists
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initCommand } from '../commands/init.js';
import { CliError } from '../errors.js';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-cmd-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// initCommand
// --------------------------------------------------------------------------

describe('initCommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Init command — creates build.forjis with version: 1 */
  it('creates build.forjis with version: 1 in the scaffold', async () => {
    await initCommand(tmpDir);
    const content = await readFile(join(tmpDir, 'build.forjis'), 'utf-8');
    expect(content).toContain('version: 1');
  });

  it('creates build.forjis file on disk', async () => {
    await initCommand(tmpDir);
    const { access } = await import('node:fs/promises');
    await expect(access(join(tmpDir, 'build.forjis'))).resolves.toBeUndefined();
  });

  /** Validates: Init command — refuses to overwrite existing build.forjis */
  it('throws CliError when build.forjis already exists', async () => {
    await writeFile(join(tmpDir, 'build.forjis'), 'existing content');
    await expect(initCommand(tmpDir)).rejects.toThrow(CliError);
    try {
      await initCommand(tmpDir);
    } catch (err) {
      expect((err as CliError).message).toContain('already exists');
    }
  });

  it('leaves existing build.forjis unchanged when it refuses', async () => {
    const original = 'my original content';
    await writeFile(join(tmpDir, 'build.forjis'), original);
    try {
      await initCommand(tmpDir);
    } catch {
      // expected
    }
    const content = await readFile(join(tmpDir, 'build.forjis'), 'utf-8');
    expect(content).toBe(original);
  });
});
