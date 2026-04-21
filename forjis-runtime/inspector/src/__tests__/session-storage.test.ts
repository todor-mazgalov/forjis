/**
 * Unit tests for `queue/session-storage.ts` — the typed facade over
 * `sessionStorage` used by BatchState to persist the active batch.
 *
 * Covers FR-010-009 (persistence contract), FR-010-010 (rehydrate / discard
 * rules), FR-010-012 (cross-session token gate), FR-010-013 (payload
 * minimality), NFR-010-001 (never-throw discipline), and NFR-010-002
 * (no-secrets invariant).
 */

import { jest } from '@jest/globals';
import type { Batch } from '@forjis/shared';
import {
  STORAGE_KEY,
  clearBatch,
  readBatch,
  writeBatch,
} from '../queue/session-storage.js';

/**
 * Build a small, fully-populated `Batch` for persistence round-trip tests.
 *
 * @returns A deterministic `Batch` with empty `pins` for minimal payload size.
 */
function makeBatch(): Batch {
  return {
    id: 'batch-1',
    platform: 'web',
    screens: ['/a'],
    pins: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status: 'queued',
  };
}

describe('session-storage facade', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('readBatch returns null when no key is present', () => {
    expect(readBatch('tok-1')).toBeNull();
  });

  it('writeBatch + readBatch round-trip on matching token (FR-010-009, FR-010-010)', () => {
    const batch = makeBatch();
    writeBatch('tok-1', batch);
    const raw = sessionStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ token: 'tok-1', batch });
    expect(readBatch('tok-1')).toEqual(batch);
  });

  it('readBatch returns null and removes the key on mismatched token (FR-010-012)', () => {
    writeBatch('tok-OLD', makeBatch());
    expect(readBatch('tok-NEW')).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('readBatch returns null and removes the key on corrupt JSON (FR-010-010 scenario 3)', () => {
    sessionStorage.setItem(STORAGE_KEY, 'not-json');
    expect(readBatch('tok-1')).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('readBatch returns null on valid JSON with wrong shape', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
    expect(readBatch('tok-1')).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('writeBatch swallows QuotaExceededError (NFR-010-001)', () => {
    const original = sessionStorage.setItem.bind(sessionStorage);
    const spy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => writeBatch('tok-1', makeBatch())).not.toThrow();
    spy.mockRestore();
    // Subsequent writes still work after the mock is restored.
    writeBatch('tok-1', makeBatch());
    expect(readBatch('tok-1')).not.toBeNull();
    void original;
  });

  it('clearBatch removes the key', () => {
    writeBatch('tok-1', makeBatch());
    clearBatch();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('payload contains exactly token and batch keys (FR-010-013)', () => {
    writeBatch('tok-1', makeBatch());
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual(['batch', 'token']);
  });

  it('persisted payload has no auth / secret / url fields (NFR-010-002)', () => {
    writeBatch('tok-1', makeBatch());
    const raw = sessionStorage.getItem(STORAGE_KEY) as string;
    const FORBIDDEN_KEYS = /(authToken|access_token|secret|password|cookie|authorization)/i;
    const FORBIDDEN_VALUES = /wss?:\/\//i;
    // Deep-scan for forbidden keys.
    const deepScan = (value: unknown): void => {
      if (value === null || value === undefined) {
        return;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          deepScan(child);
        }
        return;
      }
      if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          expect(FORBIDDEN_KEYS.test(k)).toBe(false);
          deepScan(v);
        }
        return;
      }
      if (typeof value === 'string') {
        expect(FORBIDDEN_VALUES.test(value)).toBe(false);
      }
    };
    deepScan(JSON.parse(raw));
  });

  it('readBatch swallows sessionStorage.getItem throw (NFR-010-001)', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('disabled');
    });
    expect(readBatch('tok-1')).toBeNull();
    spy.mockRestore();
  });
});
