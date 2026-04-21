/**
 * Token usage tracking and rate limiting for the facilitator main loop.
 *
 * Provides the TokenTracker class that accumulates token counts across
 * engine invocations, checks budget thresholds, and persists cumulative
 * state to a YAML file for crash recovery. Window-based reset discards
 * stale data when the configured reset period has elapsed.
 */

import { join } from 'node:path';

import { atomicWriteFile, ensureDir, readYamlFile } from './state.js';
import type { TokenUsageState } from './types.js';
import { stringify as stringifyYaml } from 'yaml';

/** Filename for the persisted token usage state within .forjis/. */
const TOKEN_USAGE_FILENAME = 'token-usage.yaml';

/**
 * Tracks cumulative token usage across engine invocations within a budget window.
 *
 * Pure in-memory state with explicit persist/load methods for I/O.
 * Used by runMainLoop to gate task dispatch when the budget threshold is exceeded.
 */
/**
 * Per-task token entry with optional per-role breakdown.
 *
 * Accumulated by {@link TokenTracker.recordUsage} for each task invocation.
 */
export interface TaskTokenEntry {
  /** Cumulative input tokens consumed by this task. */
  inputTokens: number;
  /** Cumulative output tokens consumed by this task. */
  outputTokens: number;
  /** Per-role token breakdown keyed by role name. */
  perRole: Map<string, { inputTokens: number; outputTokens: number }>;
}

export class TokenTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private windowStartedAt: Date = new Date();
  private perTask: Map<string, TaskTokenEntry> = new Map();
  private totalCostUsd = 0;
  private costRecorded = false;

  /**
   * Records token usage from a single engine invocation.
   *
   * Adds the given counts to the cumulative totals. When taskId is provided,
   * also accumulates into per-task storage. When perRole is provided, populates
   * the per-role breakdown within the task entry.
   *
   * @param inputTokens - Number of input tokens consumed.
   * @param outputTokens - Number of output tokens consumed.
   * @param taskId - Optional task identifier for per-task tracking.
   * @param roleName - Optional single role name for per-role tracking within a task.
   * @param perRole - Optional per-role breakdown from the engine result.
   */
  recordUsage(
    inputTokens: number,
    outputTokens: number,
    taskId?: string,
    roleName?: string,
    perRole?: Record<string, { inputTokens: number; outputTokens: number }>,
  ): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;

    if (!taskId) return;

    let entry = this.perTask.get(taskId);
    if (!entry) {
      entry = { inputTokens: 0, outputTokens: 0, perRole: new Map() };
      this.perTask.set(taskId, entry);
    }
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;

    if (roleName) {
      let roleEntry = entry.perRole.get(roleName);
      if (!roleEntry) {
        roleEntry = { inputTokens: 0, outputTokens: 0 };
        entry.perRole.set(roleName, roleEntry);
      }
      roleEntry.inputTokens += inputTokens;
      roleEntry.outputTokens += outputTokens;
    }

    if (perRole) {
      for (const [role, usage] of Object.entries(perRole)) {
        let roleEntry = entry.perRole.get(role);
        if (!roleEntry) {
          roleEntry = { inputTokens: 0, outputTokens: 0 };
          entry.perRole.set(role, roleEntry);
        }
        roleEntry.inputTokens += usage.inputTokens;
        roleEntry.outputTokens += usage.outputTokens;
      }
    }
  }

  /**
   * Returns the cumulative input token count.
   *
   * @returns The total number of input tokens recorded.
   */
  getInputTokens(): number {
    return this.inputTokens;
  }

  /**
   * Returns the cumulative output token count.
   *
   * @returns The total number of output tokens recorded.
   */
  getOutputTokens(): number {
    return this.outputTokens;
  }

  /**
   * Returns the total token count (input + output).
   *
   * @returns The cumulative total of all recorded tokens.
   */
  getTotalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  /**
   * Returns the ratio of total tokens consumed to the given budget.
   *
   * @param budget - The maximum token budget for the window.
   * @returns A number between 0 and potentially greater than 1 if budget is exceeded.
   */
  getUsageRatio(budget: number): number {
    if (budget <= 0) return 0;
    return this.getTotalTokens() / budget;
  }

  /**
   * Checks whether the usage ratio exceeds the given threshold.
   *
   * @param budget - The maximum token budget for the window.
   * @param threshold - The fraction (e.g. 0.9 for 90%) at which to trigger.
   * @returns True if the usage ratio meets or exceeds the threshold.
   */
  isThresholdExceeded(budget: number, threshold: number): boolean {
    return this.getUsageRatio(budget) >= threshold;
  }

  /**
   * Returns per-task token usage as a plain record for API serialization.
   *
   * Converts internal Maps to plain objects suitable for JSON responses.
   *
   * @returns Per-task usage keyed by task ID, with per-role breakdowns.
   */
  getPerTaskUsage(): Record<string, { inputTokens: number; outputTokens: number; totalTokens: number; perRole?: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }> }> {
    const result: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number; perRole?: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }> }> = {};
    for (const [taskId, entry] of this.perTask) {
      const perRole: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }> = {};
      for (const [role, roleEntry] of entry.perRole) {
        perRole[role] = {
          inputTokens: roleEntry.inputTokens,
          outputTokens: roleEntry.outputTokens,
          totalTokens: roleEntry.inputTokens + roleEntry.outputTokens,
        };
      }
      result[taskId] = {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.inputTokens + entry.outputTokens,
        perRole: Object.keys(perRole).length > 0 ? perRole : undefined,
      };
    }
    return result;
  }

  /**
   * Records engine-reported cost in USD for the current process lifetime.
   *
   * Only positive amounts flip the `costRecorded` flag; zero amounts are
   * accepted but treated as "no cost reported" so that the runtime endpoint
   * can omit the cost field entirely (per TASK.md: "do not invent zero").
   *
   * @param usdAmount - Cost in USD reported by the engine for one invocation.
   */
  recordCost(usdAmount: number): void {
    if (usdAmount > 0) {
      this.totalCostUsd += usdAmount;
      this.costRecorded = true;
    }
  }

  /**
   * Returns the cumulative cost in USD recorded so far.
   *
   * @returns The cumulative cost in USD; 0 when no cost has been recorded.
   */
  getTotalCost(): number {
    return this.totalCostUsd;
  }

  /**
   * Returns whether any positive cost has been recorded in this process.
   *
   * @returns True when at least one `recordCost(amount > 0)` call has occurred.
   */
  hasRecordedCost(): boolean {
    return this.costRecorded;
  }

  /**
   * Resets all counters and starts a new budget window.
   */
  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.windowStartedAt = new Date();
    this.perTask = new Map();
    this.totalCostUsd = 0;
    this.costRecorded = false;
  }

  /**
   * Returns the timestamp when the current budget window started.
   *
   * @returns The window start Date.
   */
  getWindowStartedAt(): Date {
    return this.windowStartedAt;
  }

  /**
   * Persists the current token usage state to disk.
   *
   * Writes to `.forjis/token-usage.yaml` using atomic file writes
   * for crash safety.
   *
   * @param projectDir - The target project directory.
   */
  async persist(projectDir: string): Promise<void> {
    const forjisDir = join(projectDir, '.forjis');
    await ensureDir(forjisDir);

    const state: TokenUsageState = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.getTotalTokens(),
      windowStartedAt: this.windowStartedAt.toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      totalCostUsd: this.totalCostUsd,
      costRecorded: this.costRecorded,
    };

    const yaml = stringifyYaml(state, { indent: 2 });
    await atomicWriteFile(join(forjisDir, TOKEN_USAGE_FILENAME), yaml);
  }

  /**
   * Loads persisted token usage state from disk.
   *
   * If the state file exists and the window is still active (not expired),
   * restores the in-memory counters. If the window has expired or the file
   * is missing, resets to a fresh state. When resetWindowMs is undefined,
   * skips the expiry check and always restores persisted state.
   *
   * @param projectDir - The target project directory.
   * @param resetWindowMs - The budget window duration in milliseconds. When
   *   undefined, no expiry check is performed and persisted state is always restored.
   */
  async load(projectDir: string, resetWindowMs?: number): Promise<void> {
    const filePath = join(projectDir, '.forjis', TOKEN_USAGE_FILENAME);
    const state = await readYamlFile<TokenUsageState>(filePath);

    if (!state) {
      this.reset();
      return;
    }

    const windowStart = new Date(state.windowStartedAt);

    if (resetWindowMs !== undefined) {
      const windowExpiry = windowStart.getTime() + resetWindowMs;
      if (Date.now() >= windowExpiry) {
        this.reset();
        return;
      }
    }

    this.inputTokens = state.inputTokens;
    this.outputTokens = state.outputTokens;
    this.windowStartedAt = windowStart;
    this.totalCostUsd = state.totalCostUsd ?? 0;
    this.costRecorded = state.costRecorded ?? false;
  }
}
