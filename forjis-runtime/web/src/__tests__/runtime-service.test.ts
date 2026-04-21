/**
 * Backend-layer unit tests for RuntimeServiceImpl (Phase F of
 * redesign-013-api-contract-extensions).
 *
 * Validates that:
 *   - getRuntime returns version, workers, and gitBranch from injected deps.
 *   - cost is omitted when tracker.hasRecordedCost() is false.
 *   - cost is { total: 0.42, currency: 'USD' } after recordCost(0.42).
 *   - workers reflect live mutations of the shared WorkerStateRef.
 *   - gitBranch may be null without affecting the rest of the response.
 */

import { RuntimeServiceImpl, TokenTracker } from '@forjis/facilitator';
import type { WorkerStateRef } from '@forjis/facilitator';

describe('RuntimeServiceImpl.getRuntime', () => {
  it('returns version, workers, and gitBranch from injected deps', async () => {
    const workerState: WorkerStateRef = { busy: 1, max: 3 };
    const tracker = new TokenTracker();
    const svc = new RuntimeServiceImpl('1.2.3', workerState, tracker, 'forjis/stage');

    const result = await svc.getRuntime();
    expect(result.version).toBe('1.2.3');
    expect(result.workers).toEqual({ busy: 1, max: 3 });
    expect(result.gitBranch).toBe('forjis/stage');
  });

  it('omits cost when tracker has not recorded any positive cost', async () => {
    const workerState: WorkerStateRef = { busy: 0, max: 1 };
    const tracker = new TokenTracker();
    const svc = new RuntimeServiceImpl('1.0.0', workerState, tracker, null);

    const result = await svc.getRuntime();
    expect(result.cost).toBeUndefined();
  });

  it('emits cost { total, currency: "USD" } after recordCost(0.42)', async () => {
    const workerState: WorkerStateRef = { busy: 0, max: 1 };
    const tracker = new TokenTracker();
    tracker.recordCost(0.42);
    const svc = new RuntimeServiceImpl('1.0.0', workerState, tracker, null);

    const result = await svc.getRuntime();
    expect(result.cost).toBeDefined();
    expect(result.cost!.total).toBeCloseTo(0.42, 6);
    expect(result.cost!.currency).toBe('USD');
  });

  it('reflects live mutations of the shared WorkerStateRef', async () => {
    const workerState: WorkerStateRef = { busy: 0, max: 5 };
    const tracker = new TokenTracker();
    const svc = new RuntimeServiceImpl('1.0.0', workerState, tracker, null);

    let result = await svc.getRuntime();
    expect(result.workers).toEqual({ busy: 0, max: 5 });

    workerState.busy = 3;
    result = await svc.getRuntime();
    expect(result.workers).toEqual({ busy: 3, max: 5 });
  });

  it('returns gitBranch null without affecting the rest of the response', async () => {
    const workerState: WorkerStateRef = { busy: 0, max: 1 };
    const tracker = new TokenTracker();
    const svc = new RuntimeServiceImpl('1.0.0', workerState, tracker, null);

    const result = await svc.getRuntime();
    expect(result.gitBranch).toBeNull();
    expect(result.version).toBe('1.0.0');
  });
});
