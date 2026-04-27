/**
 * Heartbeat-based health check monitor for engine subprocesses.
 *
 * Runs a periodic check (setInterval) that reads the active role's JSONL
 * event file mtime and checks PID liveness. Detects stuck roles and invokes
 * a callback for the caller to handle kill/retry/halt logic.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalSlug } from '@forjis/shared';
import type { RoleIdentity } from '@forjis/shared';
import type { HealthCheckConfig } from './types.js';
import { readPidFile } from './process-utils.js';

/**
 * Multiplier applied to the check interval to derive the stuck detection
 * threshold.
 *
 * With the default `interval = 60 s`, this yields a 600 s (10 min) window —
 * comfortably exceeding the longest legitimate `npm test` run plus its
 * surrounding reasoning + scoring window. The previous value of `2` (120 s)
 * coincided exactly with the `npm test` Bash-tool timeout and tripped on
 * every legitimate test run, killing the orchestrator subprocess. Now that
 * stuck roles trigger a non-destructive nudge instead of a kill, a single
 * threshold sized for the longest legitimate operation is correct for
 * every role.
 */
const STUCK_THRESHOLD_MULTIPLIER = 10;

/** Per-role retry state tracked in memory during task execution. */
export interface RoleRetryState {
  /** Number of times this role has been retried. Starts at 0. */
  retryCount: number;
  /** Whether this role has been halted (retryCount >= maxRetries). */
  halted: boolean;
}

/** Callback invoked when the monitor detects a stuck role. */
export interface StuckRoleCallback {
  /**
   * Called when a role is detected as stuck.
   *
   * @param roleName - The name of the stuck role.
   * @param retryCount - The retry count AFTER increment (1 on first retry).
   * @param shouldHalt - True if retryCount >= maxRetries (no more retries).
   */
  (roleName: string, retryCount: number, shouldHalt: boolean): void;
}

/**
 * Checks whether a process with the given PID is alive.
 *
 * Uses `process.kill(pid, 0)` which works cross-platform on Node.js.
 * Signal 0 checks existence without sending a real signal.
 *
 * @param pid - The process ID to check.
 * @returns True if the process is alive, false if it is dead.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the mtime of a file as a Unix timestamp in milliseconds.
 *
 * @param filePath - Absolute path to the file.
 * @returns The mtime in milliseconds, or null if the file does not exist.
 */
async function getFileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stats = await stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Heartbeat-based health check monitor for engine subprocesses.
 *
 * Runs a periodic check (setInterval) that reads the active role's JSONL
 * event file mtime and checks PID liveness. Detects stuck roles and invokes
 * a callback for the caller to handle kill/retry/halt logic.
 */
export class HealthCheckMonitor {
  /** Health check configuration (interval, maxRetries). */
  private readonly config: HealthCheckConfig;

  /** The root directory of the target project. */
  private readonly projectDir: string;

  /** The task identifier. */
  private readonly taskId: string;

  /** Per-role retry counters. */
  private readonly roleRetryMap: Map<string, RoleRetryState> = new Map();

  /** The interval handle. */
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Guard to prevent overlapping tick callbacks. */
  private isChecking = false;

  /**
   * Creates a new HealthCheckMonitor.
   *
   * @param config - Health check configuration (interval, maxRetries).
   * @param projectDir - The root directory of the target project.
   * @param taskId - The task identifier.
   */
  constructor(
    config: HealthCheckConfig,
    projectDir: string,
    taskId: string,
  ) {
    this.config = config;
    this.projectDir = projectDir;
    this.taskId = taskId;
  }

  /**
   * Starts monitoring for a specific engine invocation.
   *
   * Sets up a setInterval that fires every `config.interval` seconds.
   * Each tick reads the PID file for liveness and the JSONL event file
   * mtime for heartbeat freshness. Calls onStuck when a role is detected
   * as stuck.
   *
   * @param getCurrentRole - Returns the current team and role, or null.
   * @param getStartedAt - Returns the ISO timestamp of engine start.
   * @param onStuck - Callback invoked when a stuck role is detected.
   */
  start(
    getCurrentRole: () => RoleIdentity | null,
    getStartedAt: () => string,
    onStuck: StuckRoleCallback,
  ): void {
    this.timer = setInterval(() => {
      this.tick(getCurrentRole, getStartedAt, onStuck);
    }, this.config.interval * 1000);
  }

  /**
   * Stops the health check timer.
   *
   * Clears the internal setInterval. Safe to call multiple times.
   * Does NOT reset retry counters (they persist across retries).
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Returns the retry state for a specific role.
   *
   * @param roleName - The role to look up.
   * @returns The retry state, or default if never retried.
   */
  getRoleRetryState(roleName: string): RoleRetryState {
    return this.roleRetryMap.get(roleName) ?? { retryCount: 0, halted: false };
  }

  /**
   * Returns the full retry state map for all roles that have been retried.
   *
   * @returns A read-only map of role name to retry state.
   */
  getAllRetryStates(): ReadonlyMap<string, RoleRetryState> {
    return this.roleRetryMap;
  }

  /**
   * Resets the heartbeat baseline for the current role.
   *
   * The next tick will use the new startedAt from getStartedAt() as
   * the baseline, giving the new engine invocation a fresh window.
   */
  resetBaseline(): void {
    /* Baseline is read dynamically from getStartedAt() each tick,
       so resetting is a no-op. The caller updates getStartedAt()
       before calling this. Clearing isChecking ensures the next
       tick proceeds normally. */
    this.isChecking = false;
  }

  /**
   * Executes a single health check tick.
   *
   * Reads PID and JSONL file status to determine if the current role
   * is stuck. Handles overlapping tick prevention via isChecking guard.
   *
   * @param getCurrentRole - Returns the current team and role, or null.
   * @param getStartedAt - Returns the ISO timestamp of engine start.
   * @param onStuck - Callback invoked when a stuck role is detected.
   */
  private async tick(
    getCurrentRole: () => RoleIdentity | null,
    getStartedAt: () => string,
    onStuck: StuckRoleCallback,
  ): Promise<void> {
    if (this.isChecking) {
      return;
    }
    this.isChecking = true;

    try {
      await this.performCheck(getCurrentRole, getStartedAt, onStuck);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Performs the actual heartbeat and PID liveness check.
   *
   * Separated from tick() to enable clean try/finally pattern.
   *
   * @param getCurrentRole - Returns the current team and role, or null.
   * @param getStartedAt - Returns the ISO timestamp of engine start.
   * @param onStuck - Callback invoked when a stuck role is detected.
   */
  private async performCheck(
    getCurrentRole: () => RoleIdentity | null,
    getStartedAt: () => string,
    onStuck: StuckRoleCallback,
  ): Promise<void> {
    const current = getCurrentRole();
    if (!current) {
      return;
    }

    const pid = await readPidFile(this.projectDir, this.taskId);
    if (pid === null) {
      return;
    }

    const alive = isPidAlive(pid);

    if (!alive) {
      this.handleStuck(current.role, onStuck);
      return;
    }

    const jsonlPath = join(
      this.projectDir,
      '.forjis',
      'tasks',
      this.taskId,
      `events-${canonicalSlug(current)}.jsonl`,
    );

    const mtimeMs = await getFileMtimeMs(jsonlPath);
    const baselineMs = mtimeMs ?? new Date(getStartedAt()).getTime();
    const elapsedMs = Date.now() - baselineMs;

    if (elapsedMs > this.config.interval * 1000 * STUCK_THRESHOLD_MULTIPLIER) {
      this.handleStuck(current.role, onStuck);
    }
  }

  /**
   * Increments the retry counter for a role and invokes the stuck callback.
   *
   * @param roleName - The name of the stuck role.
   * @param onStuck - Callback to invoke with the updated retry state.
   */
  private handleStuck(roleName: string, onStuck: StuckRoleCallback): void {
    const state = this.roleRetryMap.get(roleName) ?? { retryCount: 0, halted: false };
    state.retryCount++;
    state.halted = state.retryCount >= this.config.maxRetries;
    this.roleRetryMap.set(roleName, state);
    onStuck(roleName, state.retryCount, state.halted);
  }
}
