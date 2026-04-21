/**
 * Unit tests for state.ts — ensureDir, atomicWriteFile, readYamlFile, writeYamlFile.
 *
 * Requirements validated:
 *   Queue directory structure — ensureDir creates nested directories
 *   State file atomicity — atomicWriteFile writes via temp-then-rename
 *   Lock file generation helpers — readYamlFile / writeYamlFile round-trip
 */

import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import { ensureDir, atomicWriteFile, readYamlFile, writeYamlFile } from '../state.js';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-state-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// ensureDir
// --------------------------------------------------------------------------

describe('ensureDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Queue directory structure — creates nested directories */
  it('creates deeply nested directories', async () => {
    const target = join(tmpDir, 'a', 'b', 'c', 'deep');
    await ensureDir(target);
    await expect(access(target)).resolves.toBeUndefined();
  });

  it('does not throw when directory already exists', async () => {
    await ensureDir(tmpDir);
    await expect(ensureDir(tmpDir)).resolves.toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// atomicWriteFile
// --------------------------------------------------------------------------

describe('atomicWriteFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: State file atomicity — writes content correctly */
  it('writes the expected content to the file', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'hello world');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('leaves no .tmp files after successful write', async () => {
    const filePath = join(tmpDir, 'output.txt');
    await atomicWriteFile(filePath, 'data');

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(tmpDir);
    const tmpFiles = entries.filter(e => e.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('overwrites existing file content', async () => {
    const filePath = join(tmpDir, 'update.txt');
    await atomicWriteFile(filePath, 'original');
    await atomicWriteFile(filePath, 'updated');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('updated');
  });
});

// --------------------------------------------------------------------------
// readYamlFile
// --------------------------------------------------------------------------

describe('readYamlFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Lock file generation — returns null for missing file */
  it('returns null when file does not exist', async () => {
    const result = await readYamlFile(join(tmpDir, 'nonexistent.yaml'));
    expect(result).toBeNull();
  });

  /** Validates: Lock file generation — parses valid YAML */
  it('parses a valid YAML file', async () => {
    const filePath = join(tmpDir, 'data.yaml');
    await atomicWriteFile(filePath, 'key: value\ncount: 42');
    const result = await readYamlFile<{ key: string; count: number }>(filePath);
    expect(result).not.toBeNull();
    expect(result!.key).toBe('value');
    expect(result!.count).toBe(42);
  });
});

// --------------------------------------------------------------------------
// writeYamlFile / readYamlFile round-trip
// --------------------------------------------------------------------------

describe('writeYamlFile + readYamlFile round-trip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Lock file generation — round-trip preserves data */
  it('round-trips an object through YAML serialization', async () => {
    const filePath = join(tmpDir, 'round-trip.yaml');
    const data = { key: 'value', nested: { count: 42, flag: true } };
    await writeYamlFile(filePath, data);
    const result = await readYamlFile<typeof data>(filePath);
    expect(result).toEqual(data);
  });
});
