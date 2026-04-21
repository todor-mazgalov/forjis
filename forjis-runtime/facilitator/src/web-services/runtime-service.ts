/**
 * Runtime service implementation for the web dashboard backend.
 *
 * Implements the RuntimeService interface by composing:
 *   - the orchestrator package version captured at startup
 *   - a shared mutable `WorkerStateRef` that the run loop updates as tasks
 *     dispatch and complete
 *   - the live TokenTracker for cumulative cost (omitted when no cost has
 *     been reported)
 *   - the project's git branch resolved once at startup (null when not a
 *     git repo or git is unavailable).
 */

import type { RuntimeService, RuntimeResponse } from '@forjis/shared';
import type { TokenTracker } from '../token-tracker.js';

/** Mutable holder for worker-slot state, updated by the run loop and read
 *  by the runtime service. Single shared reference across the process. */
export interface WorkerStateRef {
  /** Tasks currently in the running state. */
  busy: number;
  /** Configured concurrent worker slot ceiling. */
  max: number;
}

/**
 * Implements RuntimeService by composing process-state inputs.
 *
 * Each call returns a fresh snapshot — no caching layer; the dashboard
 * decides cadence.
 */
export class RuntimeServiceImpl implements RuntimeService {
  /**
   * Creates a RuntimeServiceImpl.
   *
   * @param version - The @forjis/orchestrator package version, captured at startup.
   * @param workerState - Shared worker-slot state holder mutated by the run loop.
   * @param tracker - Live TokenTracker for cumulative cost lookup.
   * @param gitBranch - The project's current git branch, or null when unavailable.
   */
  constructor(
    private readonly version: string,
    private readonly workerState: WorkerStateRef,
    private readonly tracker: TokenTracker,
    private readonly gitBranch: string | null,
  ) {}

  /**
   * Returns the current runtime/process state snapshot.
   *
   * Cost is omitted entirely when the tracker has not seen any positive
   * cost — never returned as 0 when unknown (per TASK.md).
   *
   * @returns The runtime response with version, workers, optional cost, and gitBranch.
   */
  async getRuntime(): Promise<RuntimeResponse> {
    const response: RuntimeResponse = {
      version: this.version,
      workers: { busy: this.workerState.busy, max: this.workerState.max },
      gitBranch: this.gitBranch,
    };
    if (this.tracker.hasRecordedCost()) {
      response.cost = { total: this.tracker.getTotalCost(), currency: 'USD' };
    }
    return response;
  }
}
