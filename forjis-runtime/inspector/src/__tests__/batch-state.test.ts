/**
 * Unit tests for `queue/batch-state.ts` — the BatchState singleton.
 *
 * Covers FR-010-001 through FR-010-013 and the NFR-010-001 / NFR-010-002
 * acceptance bullets. `beforeEach` resets the module singleton AND clears
 * `sessionStorage` to prevent cross-test leakage (NFR-010-003 scenario 2).
 */

import { jest } from '@jest/globals';
import type { Pin } from '@forjis/shared';
import {
  __resetBatchStateForTests,
  addPin,
  clear,
  getBatch,
  initBatchState,
  removePin,
  setStatus,
  subscribe,
  updatePin,
} from '../queue/batch-state.js';
import { STORAGE_KEY } from '../queue/session-storage.js';

/**
 * Build a deterministic `Pin` for BatchState assertions.
 *
 * @param id - Unique identifier.
 * @param screen - Screen pathname or `null`.
 * @param overrides - Optional field overrides.
 * @returns A full `Pin` with wire-valid defaults.
 */
function makePin(
  id: string,
  screen: string | null,
  overrides: Partial<Pin> = {},
): Pin {
  const base: Pin = {
    id,
    platform: 'web',
    screen,
    target: {
      kind: 'element',
      source: null,
      selector: '#x',
      componentName: null,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,AAA',
      viewportScreenshot: 'data:image/png;base64,AAA',
      computedStyles: '{}',
      annotations: [],
    },
    comment: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentPinId: null,
    commentGroupId: null,
  };
  return { ...base, ...overrides };
}

describe('BatchState singleton', () => {
  beforeEach(() => {
    __resetBatchStateForTests();
    sessionStorage.clear();
  });

  afterEach(() => {
    __resetBatchStateForTests();
    sessionStorage.clear();
  });

  // ---------------------------------------------------------------------------
  // FR-010-001 — initial null + test reset
  // ---------------------------------------------------------------------------
  it('initial getBatch() returns null (FR-010-001)', () => {
    expect(getBatch()).toBeNull();
  });

  it('__resetBatchStateForTests clears singleton AND sessionStorage key (FR-010-001 scenario 2)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/home'));
    expect(getBatch()).not.toBeNull();
    __resetBatchStateForTests();
    expect(getBatch()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // FR-010-002 — lazy creation
  // ---------------------------------------------------------------------------
  it('first addPin lazily creates a batch with canonical defaults (FR-010-002)', () => {
    initBatchState('tok-1');
    const pin = makePin('p-1', '/home');
    addPin(pin);
    const batch = getBatch();
    expect(batch).not.toBeNull();
    expect(batch!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(batch!.platform).toBe('web');
    expect(batch!.pins).toHaveLength(1);
    expect(batch!.pins[0]).toEqual(pin);
    expect(batch!.screens).toEqual(['/home']);
    expect(batch!.status).toBe('queued');
    expect(batch!.parentBatchId).toBeNull();
    expect(new Date(batch!.createdAt).toISOString()).toBe(batch!.createdAt);
  });

  it('two separate batches (created via reset) have distinct ids (FR-010-002 scenario 2)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    const firstId = getBatch()!.id;
    __resetBatchStateForTests();
    sessionStorage.clear();
    initBatchState('tok-2');
    addPin(makePin('p-2', '/a'));
    const secondId = getBatch()!.id;
    expect(firstId).not.toBe(secondId);
  });

  // ---------------------------------------------------------------------------
  // FR-010-003 — addPin dedup screens
  // ---------------------------------------------------------------------------
  it('addPin appends pins and dedupes screens preserving first-occurrence order (FR-010-003)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    addPin(makePin('p-2', '/b'));
    addPin(makePin('p-3', '/a'));
    const batch = getBatch()!;
    expect(batch.pins.map((p) => p.id)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(batch.screens).toEqual(['/a', '/b']);
  });

  it('addPin with null screen leaves screens unchanged (FR-010-003 scenario 2)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    addPin(makePin('p-2', null));
    const batch = getBatch()!;
    expect(batch.pins).toHaveLength(2);
    expect(batch.screens).toEqual(['/a']);
  });

  // ---------------------------------------------------------------------------
  // FR-010-004 — updatePin
  // ---------------------------------------------------------------------------
  it('updatePin replaces only the matched pin in place (FR-010-004)', () => {
    initBatchState('tok-1');
    addPin(makePin('pin-a', '/a', { comment: 'a' }));
    addPin(makePin('pin-b', '/a', { comment: 'old' }));
    updatePin('pin-b', { comment: 'new text' });
    const batch = getBatch()!;
    expect(batch.pins).toHaveLength(2);
    expect(batch.pins[0].id).toBe('pin-a');
    expect(batch.pins[0].comment).toBe('a');
    expect(batch.pins[1].id).toBe('pin-b');
    expect(batch.pins[1].comment).toBe('new text');
  });

  it('updatePin with unknown id is a no-op (FR-010-004 scenario 2)', () => {
    initBatchState('tok-1');
    addPin(makePin('pin-a', '/a'));
    const before = JSON.stringify(getBatch()!.pins);
    updatePin('does-not-exist', { comment: 'x' });
    expect(JSON.stringify(getBatch()!.pins)).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // FR-010-005 — removePin
  // ---------------------------------------------------------------------------
  it('removePin preserves order (FR-010-005)', () => {
    initBatchState('tok-1');
    addPin(makePin('pin-a', '/a'));
    addPin(makePin('pin-b', '/a'));
    addPin(makePin('pin-c', '/a'));
    removePin('pin-b');
    expect(getBatch()!.pins.map((p) => p.id)).toEqual(['pin-a', 'pin-c']);
  });

  it('removePin with unknown id is a no-op (FR-010-005 scenario 2)', () => {
    initBatchState('tok-1');
    addPin(makePin('pin-a', '/a'));
    const before = JSON.stringify(getBatch()!);
    removePin('does-not-exist');
    expect(JSON.stringify(getBatch()!)).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // FR-010-006 — setStatus
  // ---------------------------------------------------------------------------
  it('setStatus transitions status (FR-010-006)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    setStatus('clarifying');
    expect(getBatch()!.status).toBe('clarifying');
  });

  it('setStatus on null batch is a no-op (FR-010-006 scenario 2)', () => {
    initBatchState('tok-1');
    setStatus('clarifying');
    expect(getBatch()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // FR-010-007 — clear wipes memory + storage + notifies
  // ---------------------------------------------------------------------------
  it('clear resets singleton and removes persisted entry (FR-010-007)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    clear();
    expect(getBatch()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // FR-010-008 — subscribe / unsubscribe
  // ---------------------------------------------------------------------------
  it('subscribe fires on addPin (FR-010-008)', () => {
    initBatchState('tok-1');
    const fn = jest.fn();
    subscribe(fn);
    addPin(makePin('p-1', '/a'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].pins).toHaveLength(1);
  });

  it('subscribe fires on clear with null (FR-010-008 scenario 2)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    const fn = jest.fn();
    subscribe(fn);
    clear();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBeNull();
  });

  it('unsubscribe stops notifications (FR-010-008 scenario 3)', () => {
    initBatchState('tok-1');
    const fn = jest.fn();
    const unsub = subscribe(fn);
    addPin(makePin('p-1', '/a'));
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    addPin(makePin('p-2', '/a'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // FR-010-009 — persistence on every mutation
  // ---------------------------------------------------------------------------
  it('addPin writes the batch to sessionStorage (FR-010-009)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    const raw = sessionStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual({ token: 'tok-1', batch: getBatch() });
  });

  // ---------------------------------------------------------------------------
  // FR-010-010 — rehydrate / discard
  // ---------------------------------------------------------------------------
  it('rehydration succeeds for matching token (FR-010-010)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    const originalBatch = getBatch();
    // Simulate a reload: wipe the in-memory singleton but keep storage.
    __resetBatchStateForTests();
    // __resetBatchStateForTests clears storage; re-seed it manually for this test.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: 'tok-1', batch: originalBatch }),
    );
    initBatchState('tok-1');
    expect(getBatch()).toEqual(originalBatch);
  });

  it('token mismatch discards stored batch (FR-010-010 scenario 2)', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'tok-OLD',
        batch: {
          id: 'b',
          platform: 'web',
          screens: [],
          pins: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          parentBatchId: null,
          status: 'queued',
        },
      }),
    );
    initBatchState('tok-NEW');
    expect(getBatch()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('corrupt JSON is discarded (FR-010-010 scenario 3)', () => {
    sessionStorage.setItem(STORAGE_KEY, 'not-json');
    expect(() => initBatchState('tok-1')).not.toThrow();
    expect(getBatch()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // FR-010-011 — survives a simulated reload
  // ---------------------------------------------------------------------------
  it('survives a simulated reload within the same session (FR-010-011)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    addPin(makePin('p-2', '/b'));
    const preReload = getBatch();
    // Simulate reload: drop in-memory singleton but preserve sessionStorage.
    const storedRaw = sessionStorage.getItem(STORAGE_KEY);
    __resetBatchStateForTests();
    // __reset cleared storage; restore the snapshot.
    sessionStorage.setItem(STORAGE_KEY, storedRaw as string);
    initBatchState('tok-1');
    const postReload = getBatch();
    expect(postReload!.pins).toHaveLength(2);
    expect(postReload!.id).toBe(preReload!.id);
    expect(postReload!.screens).toEqual(preReload!.screens);
    expect(postReload!.createdAt).toBe(preReload!.createdAt);
    expect(postReload!.status).toBe(preReload!.status);
  });

  // ---------------------------------------------------------------------------
  // FR-010-012 — cross-session isolation
  // ---------------------------------------------------------------------------
  it('new session token discards prior-session batch (FR-010-012)', () => {
    initBatchState('tok-OLD');
    addPin(makePin('p-1', '/a'));
    __resetBatchStateForTests();
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'tok-OLD',
        batch: {
          id: 'b',
          platform: 'web',
          screens: [],
          pins: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          parentBatchId: null,
          status: 'queued',
        },
      }),
    );
    initBatchState('tok-NEW');
    expect(getBatch()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // FR-010-013 — minimal payload shape
  // ---------------------------------------------------------------------------
  it('persisted payload has only token and batch keys (FR-010-013)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a'));
    const keys = Object.keys(
      JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string),
    ).sort();
    expect(keys).toEqual(['batch', 'token']);
  });

  // ---------------------------------------------------------------------------
  // NFR-010-001 — resilience
  // ---------------------------------------------------------------------------
  it('addPin does not propagate setItem throws (NFR-010-001)', () => {
    initBatchState('tok-1');
    const spy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => addPin(makePin('p-1', '/a'))).not.toThrow();
    expect(getBatch()!.pins).toHaveLength(1);
    spy.mockRestore();
  });

  it('initBatchState does not propagate getItem throws (NFR-010-001)', () => {
    const spy = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('disabled');
      });
    expect(() => initBatchState('tok-1')).not.toThrow();
    expect(getBatch()).toBeNull();
    spy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // NFR-010-002 — no secrets in persisted payload
  // ---------------------------------------------------------------------------
  it('persisted payload deep-scan finds no auth / secret keys or ws urls (NFR-010-002)', () => {
    initBatchState('tok-1');
    addPin(makePin('p-1', '/a', { comment: 'safe' }));
    const raw = sessionStorage.getItem(STORAGE_KEY) as string;
    const FORBIDDEN_KEYS = /(authToken|access_token|secret|password|cookie|authorization)/i;
    const FORBIDDEN_VALUES = /wss?:\/\//i;
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
});
