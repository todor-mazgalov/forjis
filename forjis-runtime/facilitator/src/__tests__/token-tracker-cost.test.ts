/**
 * Unit tests for TokenTracker cost-tracking extension.
 *
 * Validates that:
 *   - hasRecordedCost returns false before any positive recordCost call.
 *   - recordCost(positive) accumulates and flips hasRecordedCost to true.
 *   - recordCost(0) does NOT flip hasRecordedCost (per "do not invent zero").
 *   - reset clears the cost accumulator and the recorded flag.
 */

import { TokenTracker } from '../token-tracker.js';

describe('TokenTracker cost tracking', () => {
  it('reports no cost before any recordCost call', () => {
    const tracker = new TokenTracker();
    expect(tracker.hasRecordedCost()).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);
  });

  it('accumulates positive cost and flips hasRecordedCost', () => {
    const tracker = new TokenTracker();
    tracker.recordCost(0.42);
    expect(tracker.hasRecordedCost()).toBe(true);
    expect(tracker.getTotalCost()).toBeCloseTo(0.42, 6);
  });

  it('accumulates across multiple positive calls', () => {
    const tracker = new TokenTracker();
    tracker.recordCost(0.10);
    tracker.recordCost(0.25);
    tracker.recordCost(0.05);
    expect(tracker.getTotalCost()).toBeCloseTo(0.40, 6);
    expect(tracker.hasRecordedCost()).toBe(true);
  });

  it('does NOT flip hasRecordedCost on a zero amount', () => {
    const tracker = new TokenTracker();
    tracker.recordCost(0);
    expect(tracker.hasRecordedCost()).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);
  });

  it('does NOT flip hasRecordedCost on a negative amount', () => {
    const tracker = new TokenTracker();
    tracker.recordCost(-1);
    expect(tracker.hasRecordedCost()).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);
  });

  it('reset clears cost accumulator and recorded flag', () => {
    const tracker = new TokenTracker();
    tracker.recordCost(1.23);
    expect(tracker.hasRecordedCost()).toBe(true);

    tracker.reset();

    expect(tracker.hasRecordedCost()).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);
  });
});
