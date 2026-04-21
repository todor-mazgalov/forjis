/**
 * Unit tests for checksum-cache.ts — read, write, compute hash, and isChanged.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeHash,
  isChanged,
  readChecksumCache,
  writeChecksumCache,
} from '../checksum-cache.js';
import type { ChecksumCache } from '../types.js';

describe('computeHash', () => {
  it('produces a deterministic SHA-256 hex digest', () => {
    const hash1 = computeHash('hello world');
    const hash2 = computeHash('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('produces different hashes for different inputs', () => {
    expect(computeHash('a')).not.toBe(computeHash('b'));
  });
});

describe('isChanged', () => {
  it('returns true when cache is null', () => {
    expect(isChanged('key', 'abc', null)).toBe(true);
  });

  it('returns true when entry is missing from cache', () => {
    const cache: ChecksumCache = { owner: 'resolver', version: '1', entries: {} };
    expect(isChanged('missing', 'abc', cache)).toBe(true);
  });

  it('returns true when hash differs', () => {
    const cache: ChecksumCache = {
      owner: 'resolver',
      version: '1',
      entries: { key: { sourceHash: 'old', targetPaths: [], generatedAt: '' } },
    };
    expect(isChanged('key', 'new', cache)).toBe(true);
  });

  it('returns false when hash matches', () => {
    const cache: ChecksumCache = {
      owner: 'resolver',
      version: '1',
      entries: { key: { sourceHash: 'same', targetPaths: [], generatedAt: '' } },
    };
    expect(isChanged('key', 'same', cache)).toBe(false);
  });
});

describe('readChecksumCache / writeChecksumCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'resolver-cache-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when cache file does not exist', async () => {
    const result = await readChecksumCache(tmpDir);
    expect(result).toBeNull();
  });

  it('round-trips write then read', async () => {
    const cache: ChecksumCache = {
      owner: 'resolver',
      version: '1',
      entries: {
        'config:orgs': {
          sourceHash: 'abc123',
          targetPaths: ['orgs.yaml'],
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };

    await writeChecksumCache(tmpDir, cache);
    const result = await readChecksumCache(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.owner).toBe('resolver');
    expect(result!.entries['config:orgs'].sourceHash).toBe('abc123');
  });

  it('creates parent directories automatically', async () => {
    const cache: ChecksumCache = { owner: 'resolver', version: '1', entries: {} };
    await writeChecksumCache(tmpDir, cache);

    const filePath = join(tmpDir, '.forjis', 'resolver-cache', 'checksums.json');
    const content = await readFile(filePath, 'utf-8');
    expect(JSON.parse(content).owner).toBe('resolver');
  });
});
