/**
 * Error classes for the @forjis/cli package.
 *
 * Provides a structured error hierarchy rooted at CliError, with specific
 * subclasses for each failure domain: build file parsing, plugin resolution,
 * expression evaluation, task management, and engine invocation.
 */

/** Base error class for all CLI-specific errors. */
export class CliError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'CliError';
  }
}

/** Thrown when the specified build file does not exist on disk. */
export class BuildFileNotFoundError extends CliError {
  constructor(public readonly filePath: string) {
    super(`Build file not found: ${filePath}\nRun "forjis init" to create one.`);
    this.name = 'BuildFileNotFoundError';
  }
}

/** Thrown when the build file fails schema validation. Carries all error messages. */
export class BuildFileValidationError extends CliError {
  constructor(public readonly errors: string[]) {
    super(`Build file validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'BuildFileValidationError';
  }
}

/** Thrown when a referenced plugin is not found in any resolved repository. */
export class PluginNotFoundError extends CliError {
  constructor(public readonly pluginName: string) {
    super(`Plugin "${pluginName}" not found in any repository`);
    this.name = 'PluginNotFoundError';
  }
}

/** Thrown when a plugin file fails schema validation. */
export class PluginValidationError extends CliError {
  constructor(public readonly pluginName: string, public readonly details: string) {
    super(`Invalid plugin "${pluginName}": ${details}`);
    this.name = 'PluginValidationError';
  }
}

/** Thrown when a plugin requires resources that are not available in the registry. */
export class PluginDependencyError extends CliError {
  constructor(
    public readonly pluginName: string,
    public readonly missingResources: string[]
  ) {
    super(
      `Plugin "${pluginName}" requires unavailable resources: ${missingResources.join(', ')}`
    );
    this.name = 'PluginDependencyError';
  }
}

/** Thrown when an outcome rule expression is syntactically invalid or references unknown metrics. */
export class ExpressionError extends CliError {
  constructor(public readonly expression: string, public readonly detail: string) {
    super(`Invalid expression "${expression}": ${detail}`);
    this.name = 'ExpressionError';
  }
}

/** Thrown when a referenced task does not exist in the queue. */
export class TaskNotFoundError extends CliError {
  constructor(public readonly taskId: string) {
    super(`Task "${taskId}" not found`);
    this.name = 'TaskNotFoundError';
  }
}

/** Thrown when an operation requires a completed task but the task is in a different state. */
export class TaskInvalidStateError extends CliError {
  constructor(public readonly taskId: string, public readonly status: string) {
    super(`Task "${taskId}" is in "${status}" state, not in a completed state`);
    this.name = 'TaskInvalidStateError';
  }
}

/** Thrown when no task source is available (neither -t flag nor tasks block). */
export class NoTaskSourceError extends CliError {
  constructor() {
    super('No task source configured: provide -t flag or add a tasks block to the build file');
    this.name = 'NoTaskSourceError';
  }
}

/** Thrown when a requested engine is not registered or its CLI is not available. */
export class EngineNotFoundError extends CliError {
  constructor(
    public readonly engineName: string,
    public readonly availableEngines: string[]
  ) {
    super(
      `Engine "${engineName}" not found. Available engines: ${availableEngines.join(', ') || 'none'}`
    );
    this.name = 'EngineNotFoundError';
  }
}

/** Thrown when the Forjis engine subprocess fails during task execution. */
export class EngineInvocationError extends CliError {
  constructor(public readonly taskId: string, cause: Error) {
    super(`Engine invocation failed for task "${taskId}": ${cause.message}`, cause);
    this.name = 'EngineInvocationError';
  }
}

/**
 * Thrown when the engine subprocess is killed by the silence watchdog
 * because no stream event was parsed within the configured threshold.
 *
 * This typically indicates a nested tool call (for example a `Bash` step
 * running `npm test` without a timeout) has hung, so the parent engine
 * never produces a `result` event. The watchdog kills the subprocess tree,
 * cleans up its PID file, and surfaces this error to the caller so the
 * orchestrator can fail the task rather than hanging forever.
 */
export class EngineTimeoutError extends CliError {
  constructor(
    public readonly kind: 'silence',
    public readonly elapsedMs: number,
  ) {
    super(
      `Engine killed after ${elapsedMs}ms of ${kind} (no stream events received)`,
    );
    this.name = 'EngineTimeoutError';
  }
}

/**
 * Thrown by the `forjis dev --tunnel` flow when neither `cloudflared` nor
 * `ngrok` is available on the system `PATH`.
 *
 * The error message names both binaries and their canonical install URLs
 * so the user can pick one without consulting additional docs. The class
 * never auto-installs anything — discovery is strictly read-only.
 */
export class TunnelToolMissingError extends CliError {
  /**
   * Construct the error with a pre-baked, token-free message naming the
   * required binaries and their install URLs.
   */
  constructor() {
    super(
      'forjis dev --tunnel requires either "cloudflared" or "ngrok" on PATH. ' +
        'Install cloudflared: https://developers.cloudflare.com/cloudflared/ ' +
        'or ngrok: https://ngrok.com/download — no auto-install is performed.',
    );
    this.name = 'TunnelToolMissingError';
  }
}

/**
 * Thrown when an operation requires an engine capability the loaded engine
 * does not implement (for example, mid-run user-message injection via
 * `onUserMessage` on an engine that only supports one-shot spawns).
 *
 * Also raised by engines that DO implement the capability when the target
 * subprocess for `taskId` is not currently running — either because it
 * already exited or the caller passed a stale id.
 */
export class EngineCapabilityError extends CliError {
  /**
   * Construct an `EngineCapabilityError`.
   *
   * @param engineName - Name of the engine that was asked to perform the
   *   operation (for example `"claude"`).
   * @param capability - Human-readable capability identifier (for example
   *   `"onUserMessage"`).
   * @param detail - Optional additional context attached to the message
   *   (for example the task id whose subprocess was missing).
   */
  constructor(
    public readonly engineName: string,
    public readonly capability: string,
    detail?: string,
  ) {
    const suffix = detail ? ` (${detail})` : '';
    super(
      `Engine "${engineName}" does not support capability "${capability}"${suffix}`,
    );
    this.name = 'EngineCapabilityError';
  }
}
