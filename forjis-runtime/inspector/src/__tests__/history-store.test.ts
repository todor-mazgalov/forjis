/**
 * Unit tests for the history-store singleton and its localStorage facade.
 *
 * Covers FR-011-025..029 (public API, persistence, dedupe, eviction,
 * session-token gate) and NFR-011-006 (no auth-like keys, no WebSocket URLs
 * written to storage). Tests mirror the `batch-state.test.ts` conventions
 * and reset module state in `beforeEach`.
 */

import { jest } from '@jest/globals';
import type { Batch } from '@forjis/shared';
import {
  HISTORY_STORAGE_KEY,
  HISTORY_STORE_MAX_BYTES,
  clearHistory,
} from '../history/storage.js';
import {
  __resetHistoryStoreForTests,
  getHistory,
  initHistoryStore,
  pushBatch,
  subscribe,
  updateStatus,
  updateSummary,
} from '../history/history-store.js';

/** Build a deterministic batch for assertions. */
function makeBatch(id: string, screens: string[] = ['/a']): Batch {
  return {
    id,
    platform: 'web',
    screens,
    pins: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    parentBatchId: null,
    status: 'finalized',
  };
}

/**
 * Deep-scan an arbitrary JSON value for any key or string value matching
 * the supplied predicates.
 *
 * @param value - Root of the object graph.
 * @param keyMatches - Key predicate.
 * @param stringMatches - Value predicate applied only to strings.
 * @returns `true` when any key or string satisfies its predicate.
 */
function deepScan(
  value: unknown,
  keyMatches: (k: string) => boolean,
  stringMatches: (s: string) => boolean,
): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return stringMatches(value);
  }
  if (Array.isArray(value)) {
    return value.some((v) => deepScan(v, keyMatches, stringMatches));
  }
  if (typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (keyMatches(key)) {
      return true;
    }
    if (deepScan(record[key], keyMatches, stringMatches)) {
      return true;
    }
  }
  return false;
}

describe('history-store', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetHistoryStoreForTests();
  });

  it('FR-011-025 — initial state is empty after init with no payload', () => {
    initHistoryStore('tok-1');
    expect(getHistory()).toEqual([]);
  });

  it('FR-011-025 — pushBatch appends an entry with null summary and ISO finalizedAt', () => {
    initHistoryStore('tok-1');
    const b = makeBatch('b-1');
    pushBatch(b, '/tmp/t');
    const hist = getHistory();
    expect(hist.length).toBe(1);
    expect(hist[0].batch).toEqual(b);
    expect(hist[0].taskPath).toBe('/tmp/t');
    expect(hist[0].summary).toBeNull();
    expect(hist[0].finalizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('FR-011-025 — updateSummary sets the stored summary', () => {
    initHistoryStore('tok-1');
    const b = makeBatch('b-1');
    pushBatch(b, '/tmp/t');
    updateSummary('b-1', 'diff!');
    expect(getHistory()[0].summary).toBe('diff!');
  });

  it('FR-011-025 — updateStatus sets the stored batch status', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/t');
    updateStatus('b-1', 'done');
    expect(getHistory()[0].batch.status).toBe('done');
  });

  it('FR-011-025 — updateSummary / updateStatus are no-ops on unknown id', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/t');
    updateSummary('b-UNKNOWN', 'x');
    updateStatus('b-UNKNOWN', 'done');
    expect(getHistory()).toHaveLength(1);
    expect(getHistory()[0].summary).toBeNull();
    expect(getHistory()[0].batch.status).toBe('finalized');
  });

  it('FR-011-026 — persisted payload has exactly token + entries keys and matching token', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/t');
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['entries', 'token']);
    expect(parsed['token']).toBe('tok-1');
  });

  it('FR-011-026 — rehydration succeeds for matching token', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/a');
    pushBatch(makeBatch('b-2'), '/tmp/b');
    // Simulate unmount by clearing module state (but keep localStorage).
    __resetHistoryStoreForTests();
    // __reset clears the storage key too — we need to seed again manually.
    // In production the same browser session preserves the key; tests
    // simulate by re-writing the payload before re-init.
    const payload = {
      token: 'tok-1',
      entries: [
        {
          batch: makeBatch('b-1'),
          taskPath: '/tmp/a',
          summary: null,
          finalizedAt: '2026-04-22T10:00:00.000Z',
        },
        {
          batch: makeBatch('b-2'),
          taskPath: '/tmp/b',
          summary: null,
          finalizedAt: '2026-04-22T11:00:00.000Z',
        },
      ],
    };
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(payload));
    initHistoryStore('tok-1');
    expect(getHistory()).toHaveLength(2);
  });

  it('FR-011-026 — token mismatch discards stored history and clears the key', () => {
    const payload = {
      token: 'tok-OLD',
      entries: [
        {
          batch: makeBatch('b-1'),
          taskPath: '/tmp/a',
          summary: null,
          finalizedAt: '2026-04-22T10:00:00.000Z',
        },
      ],
    };
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(payload));
    initHistoryStore('tok-NEW');
    expect(getHistory()).toEqual([]);
    expect(localStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull();
  });

  it('FR-011-026 — corrupt JSON is discarded without throwing', () => {
    localStorage.setItem(HISTORY_STORAGE_KEY, 'not-json');
    expect(() => initHistoryStore('tok-1')).not.toThrow();
    expect(getHistory()).toEqual([]);
  });

  it('FR-011-026 — quota failure on setItem does not propagate', () => {
    initHistoryStore('tok-1');
    const spy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      expect(() => pushBatch(makeBatch('b-1'), '/tmp/t')).not.toThrow();
      expect(getHistory()).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('FR-011-027 — re-pushing same batch id replaces in place and preserves summary', () => {
    initHistoryStore('tok-1');
    const a = makeBatch('b-1');
    pushBatch(a, '/tmp/a');
    updateSummary('b-1', 's');
    const b = makeBatch('b-1', ['/different']);
    pushBatch(b, '/tmp/b');
    const hist = getHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0].taskPath).toBe('/tmp/b');
    expect(hist[0].summary).toBe('s');
    expect(hist[0].batch.screens).toEqual(['/different']);
  });

  it('FR-011-028 — eviction drops oldest entries when payload exceeds the cap', () => {
    initHistoryStore('tok-1');
    // Build two large entries that together would exceed the cap.
    // 2.5 MiB of ASCII per entry ensures the 4 MiB budget trips.
    const huge = 'a'.repeat(Math.ceil(HISTORY_STORE_MAX_BYTES * 0.65));
    const oldEntry: Batch = {
      ...makeBatch('b-old'),
      pins: [
        {
          id: 'p-old',
          platform: 'web',
          screen: null,
          target: {
            kind: 'element',
            source: null,
            selector: 'div',
            componentName: null,
            bbox: { x: 0, y: 0, w: 1, h: 1 },
          },
          capture: {
            elementScreenshot: 'data:image/png;base64,' + huge,
            viewportScreenshot: 'data:image/png;base64,',
            computedStyles: '{}',
            annotations: [],
          },
          comment: '',
          createdAt: '2026-04-01T00:00:00.000Z',
          parentPinId: null,
          commentGroupId: null,
        },
      ],
    };
    const newEntry: Batch = {
      ...oldEntry,
      id: 'b-new',
      pins: [
        {
          ...oldEntry.pins[0],
          id: 'p-new',
          capture: {
            ...oldEntry.pins[0].capture,
            elementScreenshot: 'data:image/png;base64,' + huge,
          },
        },
      ],
    };
    pushBatch(oldEntry, '/tmp/old', '2026-04-22T10:00:00.000Z');
    pushBatch(newEntry, '/tmp/new', '2026-04-22T11:00:00.000Z');
    const hist = getHistory();
    // The oldest should have been evicted; newest preserved.
    expect(hist.length).toBeLessThan(2);
    expect(hist.every((e) => e.batch.id !== 'b-old')).toBe(true);
    expect(hist.some((e) => e.batch.id === 'b-new')).toBe(true);
  });

  it('FR-011-028 — subscribers notified with post-eviction list', () => {
    initHistoryStore('tok-1');
    const huge = 'b'.repeat(Math.ceil(HISTORY_STORE_MAX_BYTES * 0.65));
    const makeBig = (id: string): Batch => ({
      ...makeBatch(id),
      pins: [
        {
          id: 'p-' + id,
          platform: 'web',
          screen: null,
          target: {
            kind: 'element',
            source: null,
            selector: 'div',
            componentName: null,
            bbox: { x: 0, y: 0, w: 1, h: 1 },
          },
          capture: {
            elementScreenshot: 'data:image/png;base64,' + huge,
            viewportScreenshot: 'data:image/png;base64,',
            computedStyles: '{}',
            annotations: [],
          },
          comment: '',
          createdAt: '2026-04-01T00:00:00.000Z',
          parentPinId: null,
          commentGroupId: null,
        },
      ],
    });
    pushBatch(makeBig('b-old'), '/tmp/old', '2026-04-22T10:00:00.000Z');
    const observed: number[] = [];
    subscribe((list) => {
      observed.push(list.length);
    });
    pushBatch(makeBig('b-new'), '/tmp/new', '2026-04-22T11:00:00.000Z');
    expect(observed.length).toBeGreaterThan(0);
    expect(observed[observed.length - 1]).toBeLessThan(2);
  });

  it('FR-011-029 — history survives mount/unmount cycle within a session', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/a');
    // Simulate remount: clear in-memory state but keep localStorage.
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    __resetHistoryStoreForTests();
    localStorage.setItem(HISTORY_STORAGE_KEY, raw as string);
    initHistoryStore('tok-1');
    expect(getHistory()).toHaveLength(1);
    expect(getHistory()[0].batch.id).toBe('b-1');
  });

  it('FR-011-029 — new session wipes prior-session history', () => {
    initHistoryStore('tok-OLD');
    pushBatch(makeBatch('b-1'), '/tmp/a');
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    __resetHistoryStoreForTests();
    localStorage.setItem(HISTORY_STORAGE_KEY, raw as string);
    initHistoryStore('tok-NEW');
    expect(getHistory()).toEqual([]);
  });

  it('NFR-011-006 — persisted payload contains no auth-like keys and no wss:// URLs', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/a');
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = JSON.parse(raw as string);
    const authKeyPattern =
      /^(authtoken|access_token|secret|password|cookie|authorization)$/i;
    const wsUrlPattern = /^wss?:\/\//i;
    const hasAuth = deepScan(
      parsed,
      (k) => authKeyPattern.test(k),
      () => false,
    );
    const hasWs = deepScan(
      parsed,
      () => false,
      (s) => wsUrlPattern.test(s),
    );
    expect(hasAuth).toBe(false);
    expect(hasWs).toBe(false);
  });

  it('clearHistory() removes the persisted key', () => {
    initHistoryStore('tok-1');
    pushBatch(makeBatch('b-1'), '/tmp/a');
    clearHistory();
    expect(localStorage.getItem(HISTORY_STORAGE_KEY)).toBeNull();
  });
});
