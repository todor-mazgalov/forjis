/**
 * Unit tests for TokenUsageServiceImpl.
 *
 * Requirements validated:
 *   FR-003 — getInputTokens / getOutputTokens exposed
 *   FR-005 — TokenUsageService reads live TokenTracker state
 *   FR-004 — Response shape with/without budget
 */

import { TokenTracker } from '../token-tracker.js';
import { TokenUsageServiceImpl } from '../web-services/token-usage-service.js';
import type { TokenBudgetConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Returns correct inputTokens, outputTokens, totalTokens
// ---------------------------------------------------------------------------

describe('TokenUsageServiceImpl', () => {
  it('returns correct inputTokens, outputTokens, totalTokens from a live tracker', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(1000, 500);
    tracker.recordUsage(200, 100);

    const service = new TokenUsageServiceImpl(tracker, null);
    const usage = service.getTokenUsage();

    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(600);
    expect(usage.totalTokens).toBe(1800);
  });

  // -------------------------------------------------------------------------
  // budget: null when constructed with null budget
  // -------------------------------------------------------------------------

  it('returns budget: null when constructed with null budget', () => {
    const tracker = new TokenTracker();
    const service = new TokenUsageServiceImpl(tracker, null);
    const usage = service.getTokenUsage();

    expect(usage.budget).toBeNull();
  });

  // -------------------------------------------------------------------------
  // budget: { maxTokens, resetWindowMs } when budget is configured
  // -------------------------------------------------------------------------

  it('returns budget with maxTokens and resetWindowMs when budget is configured', () => {
    const tracker = new TokenTracker();
    const budget: TokenBudgetConfig = { maxTokens: 100_000, resetWindowMs: 3_600_000 };
    const service = new TokenUsageServiceImpl(tracker, budget);
    const usage = service.getTokenUsage();

    expect(usage.budget).not.toBeNull();
    expect(usage.budget!.maxTokens).toBe(100_000);
    expect(usage.budget!.resetWindowMs).toBe(3_600_000);
  });

  // -------------------------------------------------------------------------
  // windowStartedAt is an ISO 8601 string
  // -------------------------------------------------------------------------

  it('windowStartedAt is an ISO 8601 string matching tracker.getWindowStartedAt()', () => {
    const tracker = new TokenTracker();
    const service = new TokenUsageServiceImpl(tracker, null);
    const usage = service.getTokenUsage();

    const expected = tracker.getWindowStartedAt().toISOString();
    expect(usage.windowStartedAt).toBe(expected);

    // Verify it parses as valid ISO 8601
    const parsed = new Date(usage.windowStartedAt);
    expect(parsed.toISOString()).toBe(usage.windowStartedAt);
  });

  // -------------------------------------------------------------------------
  // lastUpdatedAt is a recent ISO 8601 timestamp
  // -------------------------------------------------------------------------

  it('lastUpdatedAt is a recent ISO 8601 timestamp', () => {
    const tracker = new TokenTracker();
    const service = new TokenUsageServiceImpl(tracker, null);

    const before = Date.now();
    const usage = service.getTokenUsage();
    const after = Date.now();

    const lastUpdated = new Date(usage.lastUpdatedAt).getTime();
    expect(lastUpdated).toBeGreaterThanOrEqual(before);
    expect(lastUpdated).toBeLessThanOrEqual(after);

    // Verify ISO 8601 format
    const parsed = new Date(usage.lastUpdatedAt);
    expect(parsed.toISOString()).toBe(usage.lastUpdatedAt);
  });

  // -------------------------------------------------------------------------
  // totalTokens equals inputTokens + outputTokens
  // -------------------------------------------------------------------------

  it('totalTokens equals inputTokens + outputTokens', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(333, 222);
    const service = new TokenUsageServiceImpl(tracker, null);
    const usage = service.getTokenUsage();

    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
  });

  // -------------------------------------------------------------------------
  // Reads live state (updates reflected in subsequent calls)
  // -------------------------------------------------------------------------

  it('reflects tracker updates in subsequent calls', () => {
    const tracker = new TokenTracker();
    const service = new TokenUsageServiceImpl(tracker, null);

    const usage1 = service.getTokenUsage();
    expect(usage1.totalTokens).toBe(0);

    tracker.recordUsage(500, 250);
    const usage2 = service.getTokenUsage();
    expect(usage2.totalTokens).toBe(750);
    expect(usage2.inputTokens).toBe(500);
    expect(usage2.outputTokens).toBe(250);
  });
});
