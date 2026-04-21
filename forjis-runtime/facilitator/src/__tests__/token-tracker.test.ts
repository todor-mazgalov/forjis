/**
 * Unit tests for token-tracker.ts — TokenTracker class.
 *
 * Requirements validated:
 *   FR-001 Token accumulation — recordUsage accumulates correctly
 *   FR-003 State persistence — persist/load round-trip, stale window discard
 *   FR-004 TokenTracker class — all public methods behave correctly
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { TokenTracker } from '../token-tracker.js';
import { ensureDir } from '../state.js';
import type { TokenUsageState } from '../types.js';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-token-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Constructor defaults
// --------------------------------------------------------------------------

describe('TokenTracker constructor', () => {
  it('starts with zero tokens', () => {
    const tracker = new TokenTracker();
    expect(tracker.getTotalTokens()).toBe(0);
  });

  it('starts with a window timestamp close to now', () => {
    const before = Date.now();
    const tracker = new TokenTracker();
    const after = Date.now();
    expect(tracker.getWindowStartedAt().getTime()).toBeGreaterThanOrEqual(before);
    expect(tracker.getWindowStartedAt().getTime()).toBeLessThanOrEqual(after);
  });
});

// --------------------------------------------------------------------------
// recordUsage
// --------------------------------------------------------------------------

describe('recordUsage', () => {
  it('accumulates input and output tokens', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50);
    expect(tracker.getTotalTokens()).toBe(150);
  });

  it('accumulates across multiple calls', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50);
    tracker.recordUsage(200, 75);
    expect(tracker.getTotalTokens()).toBe(425);
  });
});

// --------------------------------------------------------------------------
// getUsageRatio
// --------------------------------------------------------------------------

describe('getUsageRatio', () => {
  it('returns 0 for a zero budget', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50);
    expect(tracker.getUsageRatio(0)).toBe(0);
  });

  it('returns correct ratio', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(450, 450);
    expect(tracker.getUsageRatio(1000)).toBeCloseTo(0.9);
  });

  it('returns ratio > 1 when budget is exceeded', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(600, 600);
    expect(tracker.getUsageRatio(1000)).toBeCloseTo(1.2);
  });
});

// --------------------------------------------------------------------------
// isThresholdExceeded
// --------------------------------------------------------------------------

describe('isThresholdExceeded', () => {
  it('returns false when below threshold', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(400, 400);
    expect(tracker.isThresholdExceeded(1000, 0.9)).toBe(false);
  });

  it('returns true at exactly 90% threshold', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(450, 450);
    expect(tracker.isThresholdExceeded(1000, 0.9)).toBe(true);
  });

  it('returns true above threshold', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(500, 500);
    expect(tracker.isThresholdExceeded(1000, 0.9)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// reset
// --------------------------------------------------------------------------

describe('reset', () => {
  it('clears all counters and sets a new window start', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(500, 500);
    const oldWindow = tracker.getWindowStartedAt();

    tracker.reset();

    expect(tracker.getTotalTokens()).toBe(0);
    expect(tracker.getWindowStartedAt().getTime()).toBeGreaterThanOrEqual(oldWindow.getTime());
  });
});

// --------------------------------------------------------------------------
// persist / load round-trip
// --------------------------------------------------------------------------

describe('persist and load', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await ensureDir(join(tmpDir, '.forjis'));
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('round-trips state through YAML', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 200);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    await loaded.load(tmpDir, 3_600_000);

    expect(loaded.getTotalTokens()).toBe(300);
  });

  it('writes valid YAML to disk', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(42, 58);
    await tracker.persist(tmpDir);

    const raw = await readFile(join(tmpDir, '.forjis', 'token-usage.yaml'), 'utf-8');
    const state = parseYaml(raw) as TokenUsageState;
    expect(state.inputTokens).toBe(42);
    expect(state.outputTokens).toBe(58);
    expect(state.totalTokens).toBe(100);
    expect(state.windowStartedAt).toBeDefined();
    expect(state.lastUpdatedAt).toBeDefined();
  });

  it('resets when no state file exists', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(999, 999);
    await tracker.load(tmpDir, 3_600_000);

    expect(tracker.getTotalTokens()).toBe(0);
  });

  it('discards stale window on load', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(500, 500);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    /* Load with a tiny window that has already expired */
    await loaded.load(tmpDir, 1);

    expect(loaded.getTotalTokens()).toBe(0);
  });

  it('restores state without expiry when resetWindowMs is undefined', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(300, 200);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    await loaded.load(tmpDir);

    expect(loaded.getTotalTokens()).toBe(500);
    expect(loaded.getInputTokens()).toBe(300);
    expect(loaded.getOutputTokens()).toBe(200);
  });

  it('resets when no state file exists and resetWindowMs is undefined', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(999, 999);
    await tracker.load(tmpDir);

    expect(tracker.getTotalTokens()).toBe(0);
  });

  it('round-trips totalCostUsd and costRecorded through persist/load', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 200);
    tracker.recordCost(1.23);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    await loaded.load(tmpDir, 3_600_000);

    expect(loaded.hasRecordedCost()).toBe(true);
    expect(loaded.getTotalCost()).toBeCloseTo(1.23, 6);
  });

  it('window expiry resets cost on load', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 200);
    tracker.recordCost(0.99);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    /* Load with a tiny window that has already expired */
    await loaded.load(tmpDir, 1);

    expect(loaded.hasRecordedCost()).toBe(false);
    expect(loaded.getTotalCost()).toBe(0);
  });

  it('restores cost state when no expiry window is given', async () => {
    const tracker = new TokenTracker();
    tracker.recordCost(2.50);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    await loaded.load(tmpDir);

    expect(loaded.hasRecordedCost()).toBe(true);
    expect(loaded.getTotalCost()).toBeCloseTo(2.50, 6);
  });

  it('restores costRecorded=false when no cost was recorded', async () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(50, 50);
    await tracker.persist(tmpDir);

    const loaded = new TokenTracker();
    await loaded.load(tmpDir, 3_600_000);

    expect(loaded.hasRecordedCost()).toBe(false);
    expect(loaded.getTotalCost()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// getInputTokens / getOutputTokens
// --------------------------------------------------------------------------

describe('getInputTokens and getOutputTokens', () => {
  it('returns zero for a fresh tracker', () => {
    const tracker = new TokenTracker();
    expect(tracker.getInputTokens()).toBe(0);
    expect(tracker.getOutputTokens()).toBe(0);
  });

  it('returns correct values after recording usage', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(150, 75);
    tracker.recordUsage(50, 25);
    expect(tracker.getInputTokens()).toBe(200);
    expect(tracker.getOutputTokens()).toBe(100);
  });
});
