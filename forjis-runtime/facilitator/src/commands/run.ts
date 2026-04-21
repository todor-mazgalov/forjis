/**
 * Default run command for @forjis/facilitator.
 *
 * Orchestrates the full pipeline: resolve configuration via @forjis/resolver,
 * queue tasks, and execute via engine. Task status is determined solely from
 * the engine exit code. Assessment is handled as a standard pipeline role by
 * the orchestrator, not the CLI.
 */

import { resolve as resolveConfig, parseDuration } from '@forjis/resolver';
import type { ConfigResult } from '@forjis/resolver';

import { readEngineFromConfig } from '../config-utils.js';
import { renderStatus } from '../display.js';
import { loadEngine } from '../engine.js';
import type { ForjisEngine } from '../engine.js';
import { NoTaskSourceError } from '../errors.js';
import { readYamlFile } from '../state.js';
import { TaskQueue } from '../task-queue.js';
import { TokenTracker } from '../token-tracker.js';
import type { AssessmentResult } from '../types.js';
import { HealthCheckMonitor } from '../health-check.js';
import { killProcess, readPidSync, pidFilePath } from '../process-utils.js';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writePipelinePlan, syncPlanFromState, syncBranchesFromState, forcePlanReady, getRunningRole, syncRetryStateToPlan, parsePipelinePlan, PlanRoleNotFoundError } from '../web-services/plan-writer.js';
import { appendEvent } from '../web-services/event-writer.js';
import { appendManifestEntry } from '../web-services/manifest-recorder.js';
import { RoleIdentityError } from '@forjis/shared';
import type { RoleIdentity } from '@forjis/shared';
import type { WorkerStateRef } from '../web-services/runtime-service.js';
import type { Server } from 'node:http';

/** Options for the run command. */
export interface RunOptions {
  buildFilePath: string;
  inlineTask: string | null;
  dryRun: boolean;
  watch: boolean;
  noAssess: boolean;
  /** Whether to start the web dashboard server. */
  web: boolean;
  /** Port for the web server (only used when web is true). Default: 4242. */
  port: number;
  /** Host address for the web server. Default: '127.0.0.1'. */
  host: string;
  /** Pre-shared web token. Null means no auth. */
  webToken: string | null;
  projectDir: string;
}

/**
 * Engine tool names whose `tool_call` events should be recorded in the
 * output-files manifest. Matches the Claude CLI tool naming convention.
 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Extracts the `file_path` field from a tool-call payload.
 *
 * Claude tool-call payloads use `file_path` for `Write`, `Edit`, and
 * `NotebookEdit`. Returns null when the payload is missing the field or
 * the value is not a non-empty string.
 *
 * @param payload - The unknown tool-call payload from a TaskEvent.
 * @returns The file path string, or null when not present.
 */
function extractFilePath(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const fp = (payload as Record<string, unknown>).file_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

/** Shape of .forjis/config/tasks.yaml for queue construction. */
interface TasksConfigFile {
  source: string;
  path: string;
  poll_interval: string;
  max_concurrent: number;
  auto_dependencies: boolean;
}

/** Shape of .forjis/config/token-budget.yaml. */
interface TokenBudgetFile {
  max_tokens: number;
  reset_window: string;
}

/** Shape of .forjis/config/health-check.yaml. */
interface HealthCheckConfigFile {
  interval: number;
  max_retries: number;
}

/**
 * Handles the default `forjis` run command.
 *
 * Resolves all configuration via @forjis/resolver, determines the task source,
 * and enters the main execution loop. Uses the engine abstraction layer
 * for all engine-specific operations. In dry-run mode, resolves everything
 * but skips execution.
 *
 * @param options - The run command options.
 * @throws {NoTaskSourceError} If no task source is available.
 * @throws {EngineNotFoundError} If the configured engine is not registered.
 */
export async function runCommand(options: RunOptions): Promise<void> {
  console.log(`[forjis]: resolving configuration from ${options.buildFilePath}`);
  const configResult = await resolveConfig(options.buildFilePath, {
    projectDir: options.projectDir,
  });
  console.log(
    `[forjis]: configuration resolved -- ` +
    `${configResult.summary.orgCount} org(s), ` +
    `${configResult.summary.pluginCount} plugin(s), ` +
    `${configResult.summary.roleCount} role(s), ` +
    `${configResult.generated.length} files generated, ` +
    `${configResult.skipped.length} cached`
  );

  const tasksConfig = await readYamlFile<TasksConfigFile>(
    join(configResult.configDir, 'tasks.yaml')
  );

  const engineName = await readEngineFromConfig(options.buildFilePath);
  const engine = await loadEngine(engineName);
  await engine.checkPrerequisites();

  const queue = new TaskQueue(options.projectDir, tasksConfig?.path ? {
    source: tasksConfig.source === 'dir' ? 'dir' : undefined,
    path: tasksConfig.path,
    pollIntervalMs: tasksConfig.poll_interval ? parseDurationMs(tasksConfig.poll_interval) : 300_000,
    maxConcurrent: tasksConfig.max_concurrent ?? 3,
    autoDependencies: tasksConfig.auto_dependencies ?? true,
  } : null);

  const tokenBudgetConfig = await readYamlFile<TokenBudgetFile>(
    join(configResult.configDir, 'token-budget.yaml')
  );
  const tracker = new TokenTracker();
  const resetWindowMs = tokenBudgetConfig?.reset_window ? parseDurationMs(tokenBudgetConfig.reset_window) : undefined;
  await tracker.load(options.projectDir, resetWindowMs);
  console.log(`[tokens]: loaded token tracker (${tracker.getTotalTokens()} tokens used, window started ${tracker.getWindowStartedAt().toISOString()})`);

  const healthCheckConfig = await readYamlFile<HealthCheckConfigFile>(
    join(configResult.configDir, 'health-check.yaml')
  );

  const orchestratorVersion = readOrchestratorVersion();
  const gitBranch = await resolveGitBranch(options.projectDir);
  const workerState: WorkerStateRef = {
    busy: 0,
    max: tasksConfig?.max_concurrent ?? 1,
  };

  let webServer: Server | undefined;
  if (options.web) {
    webServer = await startWebServer(
      options, queue, configResult, tracker, tokenBudgetConfig,
      workerState, orchestratorVersion, gitBranch,
    );
  }

  if (options.inlineTask) {
    const inlined = await queue.ingestInline(options.inlineTask);
    console.log(`[queue]: ingested inline task "${inlined.id}" (priority: ${inlined.priority})`);
  } else if (tasksConfig) {
    const scanned = await queue.scanDirectory();
    console.log(`[queue]: scanned directory -- found ${scanned.length} task(s)`);
  } else {
    throw new NoTaskSourceError();
  }

  if (options.dryRun) {
    await renderDryRun(queue, configResult);
    return;
  }

  const maxConcurrent = tasksConfig?.max_concurrent ?? 1;
  const continuous = options.watch || tasksConfig?.source === 'dir';

  const allTasks = await queue.listAll();
  const hasPending = allTasks.some(t => t.status === 'pending');
  if (!continuous && !hasPending) {
    console.log('[forjis]: no pending tasks found. Nothing to run.');
    await engine.cleanup(options.projectDir);
    return;
  }

  console.log(`[forjis]: starting main loop (max concurrent: ${maxConcurrent}, continuous: ${continuous})`);
  workerState.max = maxConcurrent;
  await runMainLoop(engine, queue, configResult, options, maxConcurrent, continuous, tracker, healthCheckConfig, tokenBudgetConfig, workerState, webServer);

  if (webServer) {
    webServer.close();
  }
  await engine.cleanup(options.projectDir);
  console.log('[forjis]: all tasks complete');
}

// -- Internal helpers -------------------------------------------------------

/**
 * Converts a duration string ("5m", "1h") to milliseconds.
 *
 * Delegates to the resolver's parseDuration utility.
 *
 * @param duration - A human-readable duration string.
 * @returns The duration in milliseconds.
 */
function parseDurationMs(duration: string): number {
  return parseDuration(duration);
}

/**
 * Reads the @forjis/orchestrator package version from its package.json.
 *
 * Returns the literal string "unknown" when the package.json cannot be
 * resolved or has no `version` field — never throws.
 *
 * @returns The orchestrator package version, or "unknown" on failure.
 */
function readOrchestratorVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@forjis/orchestrator/package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Resolves the current git branch of `projectDir` once at startup.
 *
 * Spawns `git symbolic-ref --short HEAD` with the project directory as cwd
 * and reads stdout. Returns null when the project is not a git repo, git is
 * unavailable, or any other error occurs — never throws.
 *
 * @param projectDir - Absolute project root path.
 * @returns The current branch name, or null when unavailable.
 */
async function resolveGitBranch(projectDir: string): Promise<string | null> {
  return new Promise((resolveBranch) => {
    let out = '';
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolveBranch(value);
    };

    try {
      const child = spawn('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf-8'); });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code === 0) {
          const branch = out.trim();
          finish(branch.length > 0 ? branch : null);
        } else {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Starts the web dashboard server with injected service implementations.
 *
 * Dynamically imports the web package and constructs service implementations
 * from the facilitator's own modules, then passes them to createWebServer.
 *
 * @param options - The run command options.
 * @param queue - The live task queue instance.
 * @param configResult - The resolver config result with configDir.
 * @param tracker - The live TokenTracker instance for token usage reporting.
 * @returns The started HTTP server instance.
 */
async function startWebServer(
  options: RunOptions,
  queue: import('../task-queue.js').TaskQueue,
  configResult: ConfigResult,
  tracker: TokenTracker,
  tokenBudgetConfig: TokenBudgetFile | null,
  workerState: WorkerStateRef,
  orchestratorVersion: string,
  gitBranch: string | null,
): Promise<Server> {
  const { TaskServiceImpl } = await import('../web-services/task-service.js');
  const { PlanServiceImpl } = await import('../web-services/plan-service.js');
  const { EventServiceImpl } = await import('../web-services/event-service.js');
  const { ResourceServiceImpl } = await import('../web-services/resource-service.js');
  const { TokenUsageServiceImpl } = await import('../web-services/token-usage-service.js');
  const { FileServiceImpl } = await import('../web-services/file-service.js');
  const { PluginFileServiceImpl } = await import('../web-services/plugin-file-service.js');
  const { TaskFileServiceImpl } = await import('../web-services/task-file-service.js');
  const { ManifestServiceImpl } = await import('../web-services/manifest-service.js');
  const { ConfigServiceImpl } = await import('../web-services/config-service.js');
  const { RuntimeServiceImpl } = await import('../web-services/runtime-service.js');
  const { createWebServer } = await import('@forjis/web');

  const taskService = new TaskServiceImpl(queue, options.projectDir);
  const planService = new PlanServiceImpl(options.projectDir);
  const eventService = new EventServiceImpl(options.projectDir);

  const resourceService = new ResourceServiceImpl(configResult.runtimeConfig, configResult.registry);

  const tokenBudget = tokenBudgetConfig?.max_tokens ? {
    maxTokens: tokenBudgetConfig.max_tokens,
    resetWindowMs: tokenBudgetConfig.reset_window ? parseDurationMs(tokenBudgetConfig.reset_window) : 3_600_000,
  } : null;
  const tokenUsageService = new TokenUsageServiceImpl(tracker, tokenBudget);

  const fileService = new FileServiceImpl(options.projectDir);
  const pluginFileService = new PluginFileServiceImpl(configResult.registry.getPluginRoots());
  const taskFileService = new TaskFileServiceImpl(options.projectDir);
  const manifestService = new ManifestServiceImpl(options.projectDir);
  const configService = new ConfigServiceImpl(configResult.configDir);
  const runtimeService = new RuntimeServiceImpl(
    orchestratorVersion, workerState, tracker, gitBranch,
  );

  const require = createRequire(import.meta.url);
  const webPkgPath = dirname(require.resolve('@forjis/web/package.json'));
  const clientDir = join(webPkgPath, 'client', 'dist');

  const server = createWebServer({
    port: options.port,
    host: options.host,
    token: options.webToken ?? undefined,
    taskService,
    planService,
    eventService,
    resourceService,
    tokenUsageService,
    fileService,
    pluginFileService,
    taskFileService,
    manifestService,
    configService,
    runtimeService,
    clientDir,
    // Absolute target-project path — consumed by `/api/config` (surfaces
    // `projectDir` on the response so the TopBar can render the project
    // icon + breadcrumb) and by `/favicon.svg` (deterministic hashed
    // icon color + first-letter glyph). See redesign-014-shell-polish.
    projectDir: options.projectDir,
  });
  server.unref();
  const host = options.host ?? '127.0.0.1';
  console.log(`[web] dashboard at http://${host}:${options.port}`);
  if (options.webToken) {
    console.log('[web] token authentication enabled');
  } else {
    console.log('[web] WARNING: no auth token set -- dashboard is unprotected');
  }
  return server;
}

/** Renders a dry-run preview showing resolved config and pending tasks. */
async function renderDryRun(
  queue: TaskQueue,
  configResult: ConfigResult
): Promise<void> {
  console.log('[dry-run] Resolved configuration:');
  console.log(`  Organizations: ${configResult.summary.orgCount}`);
  console.log(`  Plugins: ${configResult.summary.pluginCount}`);
  console.log(`  Roles: ${configResult.summary.roleCount}`);

  const tasks = await queue.listAll();
  const assessments = new Map<string, AssessmentResult>();
  console.log('\n' + renderStatus(tasks, assessments));
}

/**
 * Main execution loop: dispatch tasks and run engine.
 *
 * Task status is determined solely from the engine exit code:
 * exit 0 transitions to done, non-zero transitions to failed.
 * Assessment runs as a standard pipeline role within the orchestrator.
 *
 * In continuous mode, polls for new tasks at the configured interval.
 * In single-run mode, exits when the queue is drained.
 *
 * @param engine - The loaded ForjisEngine instance for task invocation.
 * @param queue - The task queue to dispatch from.
 * @param configResult - The resolver config result with configDir.
 * @param options - The run command options.
 * @param maxConcurrent - Maximum number of concurrent tasks.
 * @param continuous - Whether to poll for new tasks after draining.
 * @param tracker - The live TokenTracker instance for recording usage.
 * @param healthCheckConfig - Health check configuration from resolved config.
 * @param webServer - Optional HTTP server to close on shutdown.
 */
async function runMainLoop(
  engine: ForjisEngine,
  queue: TaskQueue,
  configResult: ConfigResult,
  options: RunOptions,
  maxConcurrent: number,
  continuous: boolean,
  tracker: TokenTracker,
  healthCheckConfig: HealthCheckConfigFile | null,
  tokenBudgetConfig: TokenBudgetFile | null,
  workerState: WorkerStateRef,
  webServer?: Server,
): Promise<void> {
  workerState.busy = 0;
  workerState.max = maxConcurrent;

  const cleanupOnExit = async () => {
    console.log('\n[forjis]: shutting down -- killing running tasks...');
    const tasks = await queue.listAll();
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      const pidPath = pidFilePath(options.projectDir, task.id);
      const pid = readPidSync(options.projectDir, task.id);
      if (pid !== null) {
        killProcess(pid);
        console.log(`[forjis]: killed task "${task.id}" (pid: ${pid})`);
        try { unlinkSync(pidPath); } catch { /* ignore */ }
      }
      await queue.transition(task.id, 'failed');
    }
    if (webServer) {
      webServer.close();
    }
    process.exit(1);
  };

  process.on('SIGINT', cleanupOnExit);
  process.on('SIGTERM', cleanupOnExit);

  const effectiveHealthCheck = healthCheckConfig ?? { interval: 60, max_retries: 3 };

  const processNext = async (): Promise<boolean> => {
    const task = await queue.nextDispatchable(workerState.busy, maxConcurrent);
    if (!task) {
      return false;
    }

    if (tokenBudgetConfig?.max_tokens) {
      await waitForBudgetWindow(
        tracker,
        tokenBudgetConfig.max_tokens,
        tokenBudgetConfig.reset_window ? parseDurationMs(tokenBudgetConfig.reset_window) : 3_600_000,
      );
    }

    workerState.busy++;

    let statePollTimer: ReturnType<typeof setInterval> | undefined;
    let currentIdentity: RoleIdentity | null = null;
    // Captures a plan-parse failure observed in the interval callback so the
    // main run body can rethrow it synchronously at the next checkpoint. The
    // statePollTimer runs inside `setInterval(async () => {...})`, so a raw
    // `throw err` there would become an unhandled promise rejection rather
    // than reaching the outer `try/catch` that performs
    // `queue.transition(task.id, 'failed')`.
    let planParseError: Error | null = null;
    const monitor = new HealthCheckMonitor(
      { interval: effectiveHealthCheck.interval, maxRetries: effectiveHealthCheck.max_retries },
      options.projectDir,
      task.id,
    );

    /**
     * Archives the offending pipeline-plan.yaml so the orchestrator sees an
     * absent-plan state on retry instead of re-reading the same broken plan.
     * Renames to `pipeline-plan.failed.yaml` (single-name — a subsequent
     * failure overwrites it). Guarded by existsSync for the edge case where
     * the parser throws on something other than disk content.
     */
    const archiveFailedPlan = (): void => {
      const planPath = join(options.projectDir, '.forjis', 'tasks', task.id, 'pipeline-plan.yaml');
      if (!existsSync(planPath)) return;
      const failedPath = join(options.projectDir, '.forjis', 'tasks', task.id, 'pipeline-plan.failed.yaml');
      try {
        renameSync(planPath, failedPath);
      } catch {
        /* best-effort — archival failure should not mask the parse error */
      }
    };

    try {
      await queue.transition(task.id, 'running');
      await writePipelinePlan(options.projectDir, task.id);
      console.log(`[queue]: task "${task.id}" -> running`);

      statePollTimer = setInterval(async () => {
        // If a prior tick already captured a plan-parse error, stop polling
        // and let the main body observe the flag at the next checkpoint.
        if (planParseError) return;
        try {
          await syncPlanFromState(options.projectDir, task.id);
          await syncBranchesFromState(options.projectDir, task.id, queue);
          // Strict parser — validates every step's identity shape and
          // looks up the matching RuntimeRole. Any mismatch means the
          // orchestrator wrote a malformed plan; surface as task failure.
          await parsePipelinePlan(options.projectDir, task.id, configResult.runtimeConfig);
          const runningRole = await getRunningRole(options.projectDir, task.id);
          if (runningRole) {
            currentIdentity = runningRole;
          }
        } catch (err) {
          // Plan-parse errors are orchestrator bugs — surface them as a
          // task failure rather than silently burning health-check retries
          // on a malformed plan.
          if (err instanceof PlanRoleNotFoundError || err instanceof RoleIdentityError) {
            planParseError = err;
            archiveFailedPlan();
            // Stop polling and kill the engine subprocess so the main
            // body's await of invokeWithHealthCheck returns promptly.
            if (statePollTimer) clearInterval(statePollTimer);
            const pid = readPidSync(options.projectDir, task.id);
            if (pid !== null) {
              killProcess(pid);
            }
            return;
          }
          /* ignore other poll errors */
        }
      }, 2000);

      try {
        const initialRole = await getRunningRole(options.projectDir, task.id);
        if (initialRole) {
          currentIdentity = initialRole;
        }
        // Run the strict parser once upfront too, so a plan that is already
        // malformed at entry is caught before the engine ever starts.
        await parsePipelinePlan(options.projectDir, task.id, configResult.runtimeConfig);
      } catch (err) {
        if (err instanceof PlanRoleNotFoundError || err instanceof RoleIdentityError) {
          planParseError = err;
          archiveFailedPlan();
          if (statePollTimer) clearInterval(statePollTimer);
          throw err;
        }
        /* ignore -- poll will catch up */
      }

      let engineResult: import('../engine.js').EngineResult;
      try {
        engineResult = await invokeWithHealthCheck(
          engine, monitor, options, task, configResult,
          effectiveHealthCheck.max_retries,
          () => currentIdentity,
          (event) => {
            event.role = currentIdentity?.role ?? 'orchestrator';
            appendEvent(
              options.projectDir, task.id, event,
              currentIdentity ?? undefined,
            ).catch(() => { /* Ignore append errors */ });

            if (
              currentIdentity !== null &&
              event.type === 'tool_call' &&
              event.toolName !== undefined &&
              FILE_WRITE_TOOLS.has(event.toolName)
            ) {
              const filePath = extractFilePath(event.payload);
              if (filePath !== null) {
                // Manifest entries still key by bare role name — the manifest
                // shape is governed by a separate task (see TASK.md #5
                // out-of-scope note on manifest rework).
                appendManifestEntry(options.projectDir, task.id, currentIdentity.role, filePath)
                  .catch(() => { /* best-effort */ });
              }
            }
          },
        );
      } catch (err) {
        // If the interval callback detected a plan-parse failure, the engine
        // subprocess was killed on our command — its rejected promise should
        // not mask the underlying parse error. Prefer the parse error.
        if (planParseError) {
          throw planParseError;
        }
        throw err;
      }

      // Engine returned cleanly — but the final interval tick (or an earlier
      // one that lost the race with engine completion) may still have seen a
      // malformed plan. Surface that as a task failure before we transition
      // this task to 'done'.
      if (planParseError) {
        throw planParseError;
      }

      if (engineResult.usage) {
        const perRole = engineResult.usage.perRole;
        tracker.recordUsage(
          engineResult.usage.inputTokens,
          engineResult.usage.outputTokens,
          task.id,
          undefined,
          perRole,
        );
        if (engineResult.usage.cost !== undefined) {
          tracker.recordCost(engineResult.usage.cost);
        }
        await tracker.persist(options.projectDir);
        console.log(`[tokens]: recorded ${engineResult.usage.inputTokens + engineResult.usage.outputTokens} tokens (total: ${tracker.getTotalTokens()})`);
      }

      const synced = await syncPlanFromState(options.projectDir, task.id).catch(() => false);
      await syncBranchesFromState(options.projectDir, task.id, queue).catch(() => {});
      if (!synced) {
        await forcePlanReady(options.projectDir, task.id).catch(() => {});
      }

      await syncRetryStateToPlan(options.projectDir, task.id, monitor.getAllRetryStates()).catch(() => {});

      // The orchestrator must write pipeline-state.yaml before dispatching any
      // role. If that file is still missing after the engine returns success,
      // the orchestrator exited before doing real work — treat as failure so
      // the task does not silently disappear from the queue.
      const pipelineStatePath = join(options.projectDir, '.forjis', 'tasks', task.id, 'pipeline-state.yaml');
      if (!existsSync(pipelineStatePath)) {
        await queue.transition(task.id, 'failed');
        console.error(`[queue]: task "${task.id}" -> failed: orchestrator returned without dispatching any role (no pipeline-state.yaml)`);
        return true;
      }

      console.log(`[engine]: task "${task.id}" completed (exit code: 0)`);

      await queue.transition(task.id, 'done');
      console.log(`[queue]: task "${task.id}" -> done`);
    } catch (err) {
      await syncRetryStateToPlan(options.projectDir, task.id, monitor.getAllRetryStates()).catch(() => {});
      await queue.transition(task.id, 'failed');
      console.error(`[queue]: task "${task.id}" -> failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      monitor.stop();
      if (statePollTimer) clearInterval(statePollTimer);
      workerState.busy--;
    }

    return true;
  };

  const SLOTS_FULL_RETRY_MS = 5_000;

  let hasWork = true;
  while (hasWork || continuous) {
    const slotsWereFull = workerState.busy >= maxConcurrent;
    hasWork = await processNext();

    if (!hasWork) {
      if (slotsWereFull) {
        // Concurrency cap was full -- queued tasks may exist; retry shortly.
        await new Promise(resolve => setTimeout(resolve, SLOTS_FULL_RETRY_MS));
        hasWork = true;
      } else if (continuous) {
        const tasksPath = queue.getTasksPath();
        if (tasksPath) {
          await queue.checkClarifications(join(options.projectDir, tasksPath));
          await queue.scanDirectory();
        }

        const interval = queue.getPollIntervalMs();
        console.log(`[forjis]: no pending tasks, polling again in ${interval / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, interval));
        hasWork = true;
      }
    }
  }
}

/**
 * Invokes the engine with health check monitoring and automatic retry.
 *
 * Wraps `engine.invoke()` in a retry loop driven by the HealthCheckMonitor.
 * When a stuck role is detected, the subprocess is killed and the engine
 * is re-invoked. When max retries are exceeded, the task is halted.
 *
 * @param engine - The loaded ForjisEngine instance.
 * @param monitor - The HealthCheckMonitor managing retry state.
 * @param options - The run command options.
 * @param task - The current task state.
 * @param configResult - The resolver config result with configDir.
 * @param maxRetries - Maximum number of health-check retries before halting.
 * @param getCurrentRole - Returns the current team/role or null.
 * @param onEvent - Event callback for the engine.
 * @returns The engine result from a successful invocation.
 * @throws {Error} When the task is halted or engine fails without retry.
 */
async function invokeWithHealthCheck(
  engine: ForjisEngine,
  monitor: HealthCheckMonitor,
  options: RunOptions,
  task: { id: string; description: string; started?: string },
  configResult: ConfigResult,
  maxRetries: number,
  getCurrentRole: () => RoleIdentity | null,
  onEvent: (event: import('@forjis/shared').TaskEvent) => void,
): Promise<import('../engine.js').EngineResult> {
  // Loop from attempt 0 up to maxRetries (inclusive) as a backstop.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Fresh local flags for this iteration — no shared mutable state.
    let engineCompleted = false;
    let stuckDetected = false;
    let haltDetected = false;

    const result = await new Promise<import('../engine.js').EngineResult | 'retry'>((resolve, reject) => {
      monitor.start(
        getCurrentRole,
        () => task.started ?? new Date().toISOString(),
        (roleName, retryCount, halt) => {
          if (engineCompleted) return;

          const pid = readPidSync(options.projectDir, task.id);
          if (pid !== null) {
            killProcess(pid);
          }

          if (halt) {
            haltDetected = true;
            monitor.stop();
            console.log(`[health-check]: role "${roleName}" halted after ${retryCount} retries`);
          } else {
            stuckDetected = true;
            monitor.stop();
            console.log(`[health-check]: role "${roleName}" stuck, retry ${retryCount}/${maxRetries}`);
          }
        },
      );

      console.log(`[engine]: invoking claude for task "${task.id}"...`);
      engine.invoke({
        projectDir: options.projectDir,
        taskId: task.id,
        taskDescription: task.description,
        configDir: configResult.configDir,
        dryRun: false,
        onEvent,
      }).then((engineResult) => {
        engineCompleted = true;
        monitor.stop();
        resolve(engineResult);
      }).catch((err) => {
        if (stuckDetected) {
          // Engine was interrupted by a stuck detection; signal outer loop to retry.
          resolve('retry');
        } else {
          reject(err);
        }
      });
    });

    if (result !== 'retry') {
      return result;
    }

    if (haltDetected) {
      throw new Error(`[health-check]: task "${task.id}" halted after max retries`);
    }

    // Prepare monitor baseline for the next iteration.
    monitor.resetBaseline();
  }

  throw new Error(`[health-check]: task "${task.id}" exceeded loop backstop of ${maxRetries} retries`);
}

/** Threshold fraction at which the budget gate triggers. */
const BUDGET_THRESHOLD = 0.9;

/**
 * Pauses execution until the budget window resets if the threshold is exceeded.
 *
 * Calculates the remaining time in the current budget window and sleeps
 * for that duration. After sleeping, resets the tracker for a fresh window.
 * Uses a standard setTimeout that remains interruptible by SIGINT/SIGTERM.
 *
 * @param tracker - The token tracker instance.
 * @param maxTokens - The configured token budget ceiling.
 * @param resetWindowMs - The budget window duration in milliseconds.
 */
async function waitForBudgetWindow(
  tracker: TokenTracker,
  maxTokens: number,
  resetWindowMs: number,
): Promise<void> {
  if (!tracker.isThresholdExceeded(maxTokens, BUDGET_THRESHOLD)) {
    return;
  }

  const windowStart = tracker.getWindowStartedAt().getTime();
  const windowEnd = windowStart + resetWindowMs;
  const remainingMs = Math.max(0, windowEnd - Date.now());

  if (remainingMs <= 0) {
    tracker.reset();
    console.log('[tokens]: budget window expired, resetting counters');
    return;
  }

  const remainingSec = Math.ceil(remainingMs / 1000);
  const ratio = tracker.getUsageRatio(maxTokens);
  console.log(
    `[tokens]: budget ${(ratio * 100).toFixed(1)}% consumed (${tracker.getTotalTokens()}/${maxTokens}). ` +
    `Pausing ${remainingSec}s until window resets.`,
  );

  await new Promise<void>(resolve => setTimeout(resolve, remainingMs));
  tracker.reset();
  console.log('[tokens]: budget window reset, resuming task dispatch');
}
