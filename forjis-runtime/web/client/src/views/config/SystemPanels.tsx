/**
 * SystemPanels — replaces the card grid when the sidebar's Health check or
 * Tokens config row is active.
 *
 * Health branch surfaces the two `healthCheck` fields that actually exist on
 * `ConfigResponse` today (interval, max_retries) plus static purpose copy
 * (design.md § D-10). Tokens branch renders a single "Project budget" card —
 * meter plus inline `max_tokens`, `reset_window`, `window_started_at` rows
 * (or a "no budget configured" fallback when `budget === null`) — alongside
 * a static Purpose card (redesign-019).
 */

import type { Component } from 'solid-js';
import { Match, Show, Switch } from 'solid-js';
import type { ConfigResponse, TokenUsageResponse } from '@forjis/shared';
import styles from './SystemPanels.module.css';

/** Fallback value used whenever the `/api/config` call has resolved to `null`. */
const UNAVAILABLE = 'unavailable';

/** Em-dash used when a token-budget value is missing. */
const EM_DASH = '\u2014';

/** Props for {@link SystemPanels}. */
export interface SystemPanelsProps {
  /** Which panel to render. */
  panel: 'health' | 'tokens';
  /** Latest `/api/config` snapshot, or `null` when unavailable. */
  config: ConfigResponse | null;
  /** Latest `/api/token-usage` snapshot, or `null` when unavailable. */
  tokenUsage: TokenUsageResponse | null;
}

/**
 * Human-readable duration in `ms`. Examples: `60_000 → '1m'`,
 * `3_600_000 → '1h'`, `500 → '500ms'`. Picks the coarsest unit that yields an
 * integer to keep the config panel readable at a glance.
 */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return EM_DASH;
  if (ms === 0) return '0ms';
  const minutes = ms / 60_000;
  const hours = ms / 3_600_000;
  if (hours >= 1 && Number.isInteger(hours)) return `${hours}h`;
  if (minutes >= 1 && Number.isInteger(minutes)) return `${minutes}m`;
  if (ms >= 1_000 && Number.isInteger(ms / 1_000)) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** Format a number with grouping separators (e.g. `1,234,567`). */
function formatNumber(value: number): string {
  return value.toLocaleString();
}

/** Ratio `current / max` clamped to `[0, 1]`. Returns 0 when `max <= 0`. */
function meterFraction(current: number, max: number): number {
  if (max <= 0) return 0;
  const ratio = current / max;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/** Render one `label → value` row inside a `.kvTable`. */
const KvRow: Component<{ label: string; value: string }> = (props) => (
  <>
    <span class={styles.kvKey}>{props.label}</span>
    <span class={styles.kvValue}>{props.value}</span>
  </>
);

/** Health-check panel — two cards stacked vertically. */
const HealthBranch: Component<{ config: ConfigResponse | null }> = (props) => {
  const interval = (): string =>
    props.config !== null ? `${props.config.healthCheck.interval}s` : UNAVAILABLE;
  const maxRetries = (): string =>
    props.config !== null ? String(props.config.healthCheck.max_retries) : UNAVAILABLE;
  return (
    <>
      <section class={styles.panel}>
        <div class={styles.panelTitle}>Health check · orchestrator</div>
        <div class={styles.kvTable}>
          <KvRow label="interval" value={interval()} />
          <KvRow label="max_retries" value={maxRetries()} />
        </div>
      </section>
      <section class={styles.panel}>
        <div class={styles.panelTitle}>Purpose</div>
        <p class={styles.panelCopy}>
          The orchestrator periodically sweeps running roles and checks whether
          each has made progress. If a role has been idle past the configured
          interval, it is restarted up to <code>max_retries</code> times. This
          prevents stuck workers from holding the pipeline indefinitely.
        </p>
      </section>
    </>
  );
};

/** Render the live budget meter and its `max_tokens` / `reset_window` /
 *  `window_started_at` rows, or the "no budget" fallback line. */
const BudgetMeter: Component<{ usage: TokenUsageResponse | null }> = (props) => {
  const usage = (): TokenUsageResponse | null => props.usage;
  const totalTokens = (): string =>
    usage() !== null ? formatNumber(usage()!.totalTokens) : EM_DASH;
  return (
    <Show
      when={usage() !== null && usage()!.budget !== null}
      fallback={
        <>
          <div class={styles.budgetLine}>
            <span>{totalTokens()} tokens used</span>
          </div>
          <div class={styles.meter}>
            <div class={styles.meterFill} style={{ width: '0%' }} />
          </div>
          <p class={styles.panelCopy}>no budget configured</p>
        </>
      }
    >
      <div class={styles.budgetLine}>
        <span>
          {formatNumber(usage()!.totalTokens)} / {formatNumber(usage()!.budget!.maxTokens)} tokens
        </span>
        <span>
          {Math.round(meterFraction(usage()!.totalTokens, usage()!.budget!.maxTokens) * 100)}%
        </span>
      </div>
      <div class={styles.meter}>
        <div
          class={styles.meterFill}
          style={{ width: `${meterFraction(usage()!.totalTokens, usage()!.budget!.maxTokens) * 100}%` }}
        />
      </div>
      <div class={styles.kvTable}>
        <KvRow label="max_tokens" value={formatNumber(usage()!.budget!.maxTokens)} />
        <KvRow label="reset_window" value={formatDurationMs(usage()!.budget!.resetWindowMs)} />
        <KvRow label="window_started_at" value={usage()!.windowStartedAt} />
      </div>
    </Show>
  );
};

/** Tokens panel — Project budget card (meter + inline window fields) and a
 *  Purpose card. See file header. */
const TokensBranch: Component<{ usage: TokenUsageResponse | null }> = (props) => (
  <>
    <section class={styles.panel}>
      <div class={styles.panelTitle}>Project budget</div>
      <BudgetMeter usage={props.usage} />
    </section>
    <section class={styles.panel}>
      <div class={styles.panelTitle}>Purpose</div>
      <p class={styles.panelCopy}>
        The configured limit paces orchestrator task-starting, not per-role
        budgets. When cumulative usage approaches <code>max_tokens</code>,
        the orchestrator pauses scheduling new tasks until the window
        rolls over.
      </p>
    </section>
  </>
);

/** Main column body when a system panel is active. */
export const SystemPanels: Component<SystemPanelsProps> = (props) => (
  <div class={styles.body}>
    <Switch>
      <Match when={props.panel === 'health'}>
        <HealthBranch config={props.config} />
      </Match>
      <Match when={props.panel === 'tokens'}>
        <TokensBranch usage={props.tokenUsage} />
      </Match>
    </Switch>
  </div>
);
