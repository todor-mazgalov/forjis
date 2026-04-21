/**
 * Engine abstraction layer for @forjis/facilitator.
 *
 * Defines the ForjisEngine interface that any AI tool can implement,
 * along with a lazy-loading registry for engine discovery and instantiation.
 * The Claude engine is pre-registered so it loads only when needed.
 */

import type { PromptOptions, TaskEvent } from './types.js';
import { EngineNotFoundError } from './errors.js';

// -- Engine Types -----------------------------------------------------------

/** Identifies a specific engine implementation. */
export type EngineName = string;

/** Result of engine invocation. */
export interface EngineResult {
  /** Subprocess exit code. */
  exitCode: number;
  /** The task that was invoked. */
  taskId: string;
  /** Final pipeline stage reached, or null. */
  stage: string | null;
  /** Token usage for this invocation. Undefined for dry-runs or engines that don't track usage. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Cumulative cost in USD reported by the engine for this invocation.
     *  Absent for engines that don't report cost. */
    cost?: number;
    /** Approximate per-role token breakdown. Keys are role identifiers. */
    perRole?: Record<string, { inputTokens: number; outputTokens: number }>;
  };
}

/** Per-task context for engine invocation. */
export interface EngineInvokeOptions {
  /** Absolute path to the target project directory. */
  projectDir: string;
  /** The task identifier. */
  taskId: string;
  /** Human-readable task description. */
  taskDescription: string;
  /** Absolute path to .forjis/config/ directory with resolved config files. */
  configDir: string;
  /** Orchestrator mode to invoke (e.g., 'persona', 'strategist', 'assess'). */
  mode?: string;
  /** Mode-specific arguments passed to the orchestrator. */
  modeArgs?: Record<string, unknown>;
  /** Whether to skip execution and log intentions. */
  dryRun: boolean;
  /** Optional callback for stream events. */
  onEvent?: (event: TaskEvent) => void;
}

/**
 * Engine abstraction interface.
 *
 * Every AI tool integration (Claude, Codex, Cursor, etc.) implements this
 * interface. The three lifecycle methods map to distinct phases of a pipeline
 * run: prerequisite checking, task execution, and cleanup.
 */
export interface ForjisEngine {
  /** Engine identifier (e.g., 'claude'). */
  readonly name: string;

  /**
   * Verify that the engine CLI is installed and accessible.
   *
   * @throws {EngineNotFoundError} If the CLI binary is missing or non-functional.
   */
  checkPrerequisites(): Promise<string>;

  /**
   * Invoke the engine to run the pipeline for a single task.
   *
   * @param options - All per-task context needed for invocation.
   * @returns An EngineResult with exit code and task metadata.
   * @throws {EngineInvocationError} On non-zero exit or spawn failure.
   */
  invoke(options: EngineInvokeOptions): Promise<EngineResult>;

  /**
   * Cleanup after invocation (remove generated files, temp dirs).
   *
   * @param projectDir - The target project directory.
   */
  cleanup(projectDir: string): Promise<void>;

  /**
   * Send a prompt to the engine and return the text response.
   *
   * Used for simple LLM calls (outcome scoring, pre-processing) that
   * don't need the full orchestrator pipeline.
   *
   * @param text - The prompt text to send.
   * @param options - Prompt config options.
   * @returns The engine's text response.
   */
  prompt(text: string, options: PromptOptions): Promise<string>;

  /**
   * Append `text` to the running subprocess for `taskId` as a fresh
   * user turn.
   *
   * Engines that support mid-run interactive input (for example the Claude
   * Code CLI when spawned with `keepStdinOpen`) implement this method by
   * writing the payload — plus a trailing newline — to the live
   * subprocess's stdin. The subprocess's line-based parser treats the
   * write as a new user turn.
   *
   * Engines that do not support mid-run injection MAY omit the method;
   * callers MUST check presence before invocation. The implementation
   * MUST return a rejected promise when no subprocess is running for the
   * supplied task id.
   *
   * @param taskId - Identifier used at invoke time. Matches the id passed
   *   to {@link invoke} via {@link EngineInvokeOptions.taskId}.
   * @param text - Payload written to the subprocess stdin. A trailing
   *   newline is appended by the engine to ensure the subprocess's
   *   line-based parser accepts the turn.
   * @returns A promise that resolves once the write is buffered on the
   *   subprocess stdin, or rejects when no matching subprocess exists.
   */
  onUserMessage?(taskId: string, text: string): Promise<void>;
}

// -- Engine Registry --------------------------------------------------------

/** Internal registry mapping engine names to lazy-loading factories. */
const engineRegistry = new Map<string, () => Promise<ForjisEngine>>();

/**
 * Register an engine factory under a name.
 *
 * The factory is a function that returns a Promise resolving to a ForjisEngine
 * instance. Factories are invoked lazily only when loadEngine() is called.
 * Overwrites are allowed (useful for testing).
 *
 * @param name - The engine name to register (e.g., 'claude').
 * @param factory - A function that creates and returns the engine instance.
 */
export function registerEngine(name: string, factory: () => Promise<ForjisEngine>): void {
  engineRegistry.set(name, factory);
}

/**
 * Load an engine by name from the registry.
 *
 * Looks up the factory registered under the given name, invokes it,
 * and returns the resulting ForjisEngine instance.
 *
 * @param name - The engine name to load.
 * @returns The loaded ForjisEngine instance.
 * @throws {EngineNotFoundError} If no factory is registered for the name.
 */
export async function loadEngine(name: string): Promise<ForjisEngine> {
  const factory = engineRegistry.get(name);

  if (!factory) {
    const available = Array.from(engineRegistry.keys());
    throw new EngineNotFoundError(name, available);
  }

  return factory();
}

/**
 * Returns the list of currently registered engine names.
 *
 * Useful for error messages and diagnostics.
 *
 * @returns An array of registered engine name strings.
 */
export function getRegisteredEngines(): string[] {
  return Array.from(engineRegistry.keys());
}

// -- Default Registration ---------------------------------------------------

registerEngine('claude', async () => {
  const { ClaudeEngine } = await import('./engines/claude/claude-engine.js');
  return new ClaudeEngine();
});
