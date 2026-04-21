/**
 * Token usage service implementation for the web dashboard backend.
 *
 * Implements the TokenUsageService interface by reading from the live
 * TokenTracker instance and the optional TokenBudgetConfig. All data is
 * in-memory (no I/O), so responses are effectively instant.
 */

import type { TokenTracker } from '../token-tracker.js';
import type { TokenBudgetConfig } from '../types.js';
import type { TokenUsageService, TokenUsageResponse } from '@forjis/shared';

/**
 * Implements TokenUsageService by reading from a live TokenTracker instance.
 *
 * Receives the tracker and budget config by reference at construction time.
 * The response is built fresh on each call from the tracker's in-memory state.
 */
export class TokenUsageServiceImpl implements TokenUsageService {
  /**
   * Creates a TokenUsageServiceImpl.
   *
   * @param tracker - The live TokenTracker instance to read usage data from.
   * @param budget - The token budget configuration, or null when no budget is set.
   */
  constructor(
    private readonly tracker: TokenTracker,
    private readonly budget: TokenBudgetConfig | null,
  ) {}

  /**
   * Returns the current token usage snapshot.
   *
   * Reads live counters from the tracker and includes budget config
   * when available. The lastUpdatedAt timestamp reflects the current
   * server time at the moment of the call.
   *
   * @returns The token usage response with counts, timestamps, and budget info.
   */
  getTokenUsage(): TokenUsageResponse {
    const inputTokens = this.tracker.getInputTokens();
    const outputTokens = this.tracker.getOutputTokens();
    const perTaskData = this.tracker.getPerTaskUsage();
    const hasPerTask = Object.keys(perTaskData).length > 0;

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      windowStartedAt: this.tracker.getWindowStartedAt().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      budget: this.budget
        ? { maxTokens: this.budget.maxTokens, resetWindowMs: this.budget.resetWindowMs }
        : null,
      perTask: hasPerTask ? perTaskData : undefined,
    };
  }
}
