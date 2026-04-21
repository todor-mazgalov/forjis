/**
 * Shared type definitions for the @forjis/facilitator package.
 *
 * Defines the data structures used across all facilitator modules: build file
 * configuration, plugin definitions, runtime configuration, task states,
 * outcome assessment results, lock file entries, and engine event types.
 */

// -- Configuration types re-exported from @forjis/resolver --
// These types were previously defined here but have been migrated to @forjis/resolver.
// They are re-exported for backward compatibility with internal consumers.
export type {
  BuildConfig,
  PluginRef,
  TeamDef,
  OrgDef,
  RoleDef,
  RoleHooks,
  TasksConfig,
  OutcomeConfig,
  OutcomeRule,
  ConstraintGroup,
  ConstraintIncludeRef,
  BuildConstraintsConfig,
  PersonasConfig,
  ResolvedConstraints,
  PluginDef,
  PluginRequires,
  PluginOrgDef,
  PluginTeamDef,
  PluginRoleDef,
  PluginPipeline,
  PluginOutcomeConfig,
  MetricDef,
  HealthCheckConfig,
  TokenBudgetConfig,
  RuntimeConfig,
  RuntimeOrg,
  RuntimeTeam,
  RuntimeRole,
  OutcomeConfigFile,
  LockFile,
  LockRepoEntry,
  LockPluginEntry,
} from '@forjis/resolver';

/** Persisted state of cumulative token usage within a budget window. */
export interface TokenUsageState {
  /** Cumulative input tokens consumed in the current window. */
  inputTokens: number;
  /** Cumulative output tokens consumed in the current window. */
  outputTokens: number;
  /** Sum of inputTokens and outputTokens. */
  totalTokens: number;
  /** ISO 8601 timestamp when the current budget window started. */
  windowStartedAt: string;
  /** ISO 8601 timestamp of the last usage update. */
  lastUpdatedAt: string;
  /** Cumulative engine-reported cost in USD for the current window. */
  totalCostUsd: number;
  /** True when at least one positive cost amount has been recorded this window. */
  costRecorded: boolean;
}

// -- Task Types (re-exported from @forjis/shared) ---------------------------

export type { TaskStatus } from '@forjis/shared';

import type { TaskStatus } from '@forjis/shared';

/** Named priority levels for tasks. */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/** Persistent state for a single task in the queue. */
export interface TaskState {
  id: string;
  status: TaskStatus;
  priority: TaskPriority | number;
  created: string;
  queued?: string;
  started?: string;
  completed?: string;
  source: 'dir' | 'cli';
  dependencies: string[];
  description: string;
  retryCount: number;
  currentStage?: string;
  /** Ordered branch chain from pipeline-state.yaml, e.g. ["main", "forjis/task-1"]. */
  branches?: string[];
}

/** A single clarification question for ambiguity resolution. */
export interface ClarificationQuestion {
  id: string;
  question: string;
  answer: string;
}

/** File written next to a task when clarification is needed. */
export interface ClarificationFile {
  task: string;
  status: 'awaiting_answers';
  questions: ClarificationQuestion[];
}

// -- Outcome Types ----------------------------------------------------------

/** Result of an outcome assessment for a completed task. */
export interface AssessmentResult {
  task: string;
  assessed: string;
  scores: Record<string, number>;
  verdict: Verdict;
  warnings: string[];
  failures: string[];
  notes: string[];
  /** Error message if assessment scoring failed. */
  error?: string;
}

/** Possible verdicts from outcome assessment. */
export type Verdict = 'PASS' | 'FAIL' | 'WARNING' | 'ERROR';

// -- Task Event DTO (re-exported from @forjis/shared) -----------------------

export type { TaskEvent } from '@forjis/shared';

import type { TaskEvent } from '@forjis/shared';

/**
 * Holds all mutable state that is local to a single ClaudeEngine.invoke() call.
 *
 * Creating a fresh object at the start of each invocation means concurrent
 * invoke() calls on the same ClaudeEngine instance cannot corrupt each
 * other's token counters, role tracking, or terminal output.
 */
export interface InvocationContext {
  /** Accumulated input tokens for this invocation. */
  invocationInputTokens: number;
  /** Accumulated output tokens for this invocation. */
  invocationOutputTokens: number;
  /** Accumulated cost in USD reported by the engine for this invocation. */
  invocationCostUsd: number;
  /** Per-role token accumulation for this invocation. */
  roleTokens: Map<string, { input: number; output: number }>;
  /** The most-recently seen forjis sub-agent role. */
  currentRole: string | null;
  /** Partial-line carry-over buffer for stream-json parsing. */
  lineBuffer: string;
  /** Rolling window of formatted event strings for terminal display. */
  eventLog: string[];
  /** Maps tool_use id to tool name so tool_result events can carry toolName. */
  toolIdToName: Map<string, string>;
}

/**
 * Options controlling how the engine's `prompt()` method behaves.
 *
 * Used for both simple LLM calls (pre-processing, version checks) and
 * full task invocations via `spawnClaude()`. Fields are populated selectively
 * depending on the call site.
 */
export class PromptOptions {
  /** Task or invocation identifier; used as a filename component for the PID file. */
  id?: string;
  /** Working directory for the spawned subprocess. Defaults to `process.cwd()`. */
  workingDir?: string;
  /** Tool names the engine is permitted to use during execution. */
  allowedTools: string[] = [];
  /** When `true`, capture and return the engine's stdout text instead of discarding it. */
  returnOutput = false;
  /** Absolute path to the target project. Used to locate `.forjis/` state directories. */
  projectDir?: string;
  /** Maximum number of agentic turns. When set, passes `--max-turns` to the CLI. */
  maxTurns?: number;
  /** Called for each parsed stream event during execution. */
  onEvent?: (event: TaskEvent) => void;
  /** Per-invocation context for token tracking and output buffering. Only set during invoke(). */
  ctx?: InvocationContext;
  /**
   * Maximum milliseconds of silence (no parsed stream events) before the
   * engine kills the child subprocess and rejects with EngineTimeoutError.
   * When undefined, the engine applies its default (30 min).
   */
  silenceTimeoutMs?: number;
  /**
   * When true, the engine adapter must NOT close the subprocess's stdin
   * after the initial prompt is written. Leaves the channel open so the
   * engine's {@link import('./engine.js').ForjisEngine.onUserMessage}
   * method can append subsequent user turns as newline-delimited
   * payloads. Used by the inspector-clarify mode. When false or
   * undefined, the engine closes stdin immediately after the initial
   * prompt write (legacy one-shot behaviour).
   */
  keepStdinOpen?: boolean;
}
