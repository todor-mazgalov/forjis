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
import type {
  FailureCategory,
  InspectorServiceImpl,
} from '../web-services/inspector-service.js';
import { HealthCheckMonitor } from '../health-check.js';
import { killProcess, readPidSync, pidFilePath } from '../process-utils.js';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveRoleVisuals } from '../role-visuals/index.js';
import { drainAll, release as releaseVisualsCommand } from '../role-visuals/command-runner.js';
import {
  augmentExplorationFilesTouched,
  invalidateExplorations,
  rankByTask,
  readTreeYaml,
  refreshTreeYaml,
  summarizeFile,
  writeContextArtefactsForTask,
  type ArtefactRole,
  type SummarizeOptions,
} from '../context-cache/index.js';
import { PromptOptions } from '../types.js';
import { readFile as readFileAsync } from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
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

/**
 * Emit a `batch.failed` event on the inspector service when the failing
 * task is inspector-sourced.
 *
 * Non-inspector task ids (any id that does not start with the literal
 * prefix `inspector-`) and absent services are no-ops. Inspector task
 * ids are also the batch id in v1 — the emitted payload's `batchId` and
 * `taskId` fields carry the same value for forward compatibility.
 *
 * Exported for direct unit testing; runtime callers live in `runMainLoop`.
 *
 * @param service - Optional inspector service wired by the web-server layer.
 * @param taskId - Identifier of the task that just transitioned to `failed`.
 * @param projectDir - Absolute project root used to compute `taskPath`.
 * @param category - Failure category discriminator recorded at the call site.
 */
export function dispatchFailureIfInspector(
  service: InspectorServiceImpl | undefined,
  taskId: string,
  projectDir: string,
  category: FailureCategory,
): void {
  if (service === undefined) return;
  if (!taskId.startsWith('inspector-')) return;
  const taskPath = join(projectDir, '.forjis', 'tasks', taskId);
  service.emitBatchFailed({
    batchId: taskId,
    taskId,
    taskPath,
    category,
  });
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
 * @param inspectorService - Optional inspector service; when supplied,
 *   inspector-sourced task failures are forwarded via
 *   {@link dispatchFailureIfInspector}. CLI-only wiring leaves this
 *   undefined and the helper becomes a no-op.
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
  inspectorService?: InspectorServiceImpl,
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
      dispatchFailureIfInspector(inspectorService, task.id, options.projectDir, 'shutdown');
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
          await syncPlanFromState(options.projectDir, task.id, configResult.runtimeConfig);
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

      // Context-cache hook (a): pre-task refresh of
      // `.forjis/context/tree.yaml` + `.forjis/context/index.md` when
      // the build file opted in (refresh_on_task: true, the default).
      // Never blocks dispatch — refreshTreeYaml already degrades to
      // zero counts on failure.
      const contextYaml = await readYamlFile<ContextYamlFile>(
        join(configResult.configDir, 'context.yaml'),
      ).catch(() => null);
      const refreshOnTask =
        contextYaml?.refresh_on_task ?? CONTEXT_DEFAULT_REFRESH_ON_TASK;
      const inlineTopN =
        contextYaml?.inline_top_n ?? CONTEXT_DEFAULT_INLINE_TOP_N;
      const concurrency =
        contextYaml?.concurrency ?? CONTEXT_DEFAULT_CONCURRENCY;
      if (refreshOnTask) {
        try {
          const summarizeImpl = buildSummarizeImplFromEngine(engine);
          await refreshTreeYaml({
            repoRoot: options.projectDir,
            summarizeImpl,
            concurrency,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[context-cache]: refresh skipped — ${msg}`);
        }
      }

      // Context-cache hook (b): per-role artefact write. Read the
      // refreshed (or pre-existing) tree.yaml + index.md, build
      // candidate paths, then emit one `context-<org>-<team>-<role>.yaml`
      // per non-Reviewer role. Per-role failure logs + continues.
      try {
        const tree = await readTreeYaml(
          join(options.projectDir, '.forjis', 'context', 'tree.yaml'),
        );
        let indexMd = '';
        try {
          indexMd = await readFileAsync(
            join(options.projectDir, '.forjis', 'context', 'index.md'),
            'utf-8',
          );
        } catch {
          /* index.md missing → empty string (best-effort) */
        }
        const candidatePaths = await buildCandidatePaths(
          options.projectDir,
          task.id,
          task.description,
          tree,
        );
        const flattenedRoles = flattenRoles(configResult.runtimeConfig.orgs);
        await writeContextArtefactsForTask({
          projectDir: options.projectDir,
          taskId: task.id,
          taskDescription: task.description,
          roles: flattenedRoles,
          tree,
          indexMd,
          inlineTopN,
          candidatePaths,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[context-cache]: artefact write skipped — ${msg}`);
      }

      // Tracks every `Read` file_path captured from the Explorer
      // subprocess. Used by hook (c) to rewrite the exploration cache
      // file's `files_touched` frontmatter after the orchestrator has
      // written it on cache-miss.
      const explorerFilesRead = new Set<string>();

      // Resolve per-role visuals artefacts up front (once per task
      // attempt). The orchestrator subprocess reads each file via
      // `.forjis/tasks/<task-id>/visuals-<org>-<team>-<role>.yaml` at
      // the moment it dispatches a role; pre-writing every artefact
      // avoids IPC across the orchestrator boundary. Any command
      // subprocesses spawned here are released after engine.invoke
      // returns (success OR failure); the task-level `drainAll()` in
      // the outer finally is the crash-safety backstop.
      const acquiredVisualsKeys = await resolveVisualsForRoles(
        options.projectDir,
        task.id,
        configResult.runtimeConfig.orgs,
      );

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

            // Context-cache hook (c): capture Explorer Read tool-call
            // paths so the facilitator can inject files_touched on
            // cache-miss writeback. Scoped to the Explorer stage only
            // (the persona that actually populates the cache). Stage
            // is looked up from the runtime config role tree; falls
            // back to the role-name substring when stage is absent.
            if (
              currentIdentity !== null &&
              event.type === 'tool_call' &&
              event.toolName === 'Read'
            ) {
              const runtimeRole = configResult.runtimeConfig.orgs
                .flatMap((o) => o.teams.flatMap((t) => t.roles))
                .find(
                  (r) =>
                    r.org === currentIdentity!.org &&
                    r.team === currentIdentity!.team &&
                    r.name === currentIdentity!.role,
                );
              const stageLc = (runtimeRole?.stage ?? currentIdentity.role)
                .toLowerCase();
              if (stageLc === 'explorer') {
                const readPath = extractReadFilePath(event.payload);
                if (readPath !== null) {
                  explorerFilesRead.add(readPath);
                }
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
      } finally {
        // Release every refcount hold acquired during the per-role
        // visuals resolution, whether the engine completed cleanly or
        // crashed. Each `release` is idempotent.
        for (const key of acquiredVisualsKeys) {
          await releaseVisualsCommand(key).catch(() => {
            /* swallow — task-level drainAll is the backstop */
          });
        }
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

      const synced = await syncPlanFromState(options.projectDir, task.id, configResult.runtimeConfig).catch(() => false);
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
        dispatchFailureIfInspector(
          inspectorService,
          task.id,
          options.projectDir,
          'no-pipeline-state',
        );
        console.error(`[queue]: task "${task.id}" -> failed: orchestrator returned without dispatching any role (no pipeline-state.yaml)`);
        return true;
      }

      console.log(`[engine]: task "${task.id}" completed (exit code: 0)`);

      // Context-cache hook (c, part 2): inject `files_touched` into
      // `.forjis/exploration/<taskId>.md` when the Explorer wrote it
      // on cache-miss. The helper is a silent no-op when the file
      // does not exist (cache-hit path), so it is safe to always
      // invoke unconditionally.
      await augmentExplorationFilesTouched({
        projectDir: options.projectDir,
        taskId: task.id,
        filesRead: Array.from(explorerFilesRead),
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[context-cache]: files_touched inject skipped — ${msg}`);
      });

      await queue.transition(task.id, 'done');
      console.log(`[queue]: task "${task.id}" -> done`);

      // Context-cache hook (d): post-commit invalidator. After the
      // orchestrator's archive+commit step has landed on HEAD, flip
      // any overlapping exploration cache entries to `status: invalid`.
      // Never blocks the pipeline — git unavailability yields zero
      // changed paths, which results in a zero-count no-op.
      try {
        const changedPaths = await gitDiffTreeHead(options.projectDir);
        if (changedPaths.length > 0) {
          const invalidated = await invalidateExplorations({
            projectDir: options.projectDir,
            taskId: task.id,
            changedPaths,
            now: new Date(),
          });
          if (invalidated.invalidatedCount > 0) {
            console.log(
              `[invalidator]: ${invalidated.invalidatedCount} entries invalidated`
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[context-cache]: post-commit invalidation skipped — ${msg}`
        );
      }
    } catch (err) {
      await syncRetryStateToPlan(options.projectDir, task.id, monitor.getAllRetryStates()).catch(() => {});
      await queue.transition(task.id, 'failed');
      dispatchFailureIfInspector(
        inspectorService,
        task.id,
        options.projectDir,
        'engine-error',
      );
      console.error(`[queue]: task "${task.id}" -> failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      monitor.stop();
      if (statePollTimer) clearInterval(statePollTimer);
      // Task-level crash-safety: drain any role-visuals subprocess
      // that outlived its per-role release (e.g. if the orchestrator
      // crashed before the release block ran).
      await drainAll().catch(() => {
        /* best-effort teardown */
      });
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
 * Invokes the engine with health-check monitoring and soft stuck-role nudges.
 *
 * The HealthCheckMonitor drives two callback paths:
 *
 * 1. **Stuck (halt = false):** the role's events JSONL has been silent for
 *    longer than `STUCK_THRESHOLD_MULTIPLIER × interval`. Instead of killing
 *    the orchestrator subprocess, the facilitator injects a `[health-check]`
 *    user turn via {@link ForjisEngine.onUserMessage}. The orchestrator's
 *    `forjis-workflow` skill prescribes how the model responds (defer with a
 *    one-liner, or abort + re-invoke a single subagent). When the injection
 *    fails (subprocess already closed), monitoring stops and the error is
 *    swallowed — the engine's natural completion path takes over.
 * 2. **Halt (halt = true):** the per-role retry counter reached
 *    `maxRetries`. The facilitator reads the pid file, kills the subprocess
 *    via {@link killProcess}, stops monitoring, and throws an error
 *    describing the halted role and retry count. This is the only path that
 *    still kills.
 *
 * @param engine - The loaded ForjisEngine instance.
 * @param monitor - The HealthCheckMonitor managing per-role retry counters.
 * @param options - The run command options.
 * @param task - The current task state.
 * @param configResult - The resolver config result with configDir.
 * @param maxRetries - Maximum number of nudges before the halt branch fires.
 * @param getCurrentRole - Returns the current team/role identity or null.
 * @param onEvent - Event callback for the engine.
 * @returns The engine result from a clean invocation.
 * @throws {Error} When the role is halted (max retries exceeded) or the
 *   engine itself fails.
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
  let haltError: Error | null = null;

  monitor.start(
    getCurrentRole,
    () => task.started ?? new Date().toISOString(),
    async (roleName, retryCount, halt) => {
      if (halt) {
        const pid = readPidSync(options.projectDir, task.id);
        if (pid !== null) {
          killProcess(pid);
        }
        monitor.stop();
        haltError = new Error(
          `role "${roleName}" halted after ${retryCount} retries`,
        );
        console.log(
          `[health-check]: role "${roleName}" halted after ${retryCount} retries`,
        );
        return;
      }

      try {
        if (typeof engine.onUserMessage !== 'function') {
          // Engine does not support nudge injection — surface but do not kill.
          console.warn(
            `[health-check]: engine "${engine.name}" does not support onUserMessage; skipping nudge for role "${roleName}"`,
          );
          return;
        }
        await engine.onUserMessage(task.id, buildNudge(roleName, retryCount));
        console.log(
          `[health-check]: nudged orchestrator about stuck role "${roleName}" (nudge ${retryCount}/${maxRetries})`,
        );
      } catch {
        // Subprocess is already closed (the engine is in cleanup) — stop
        // monitoring so subsequent ticks don't keep firing.
        monitor.stop();
      }
    },
  );

  console.log(`[engine]: invoking claude for task "${task.id}"...`);

  try {
    const result = await engine.invoke({
      projectDir: options.projectDir,
      taskId: task.id,
      taskDescription: task.description,
      configDir: configResult.configDir,
      dryRun: false,
      onEvent,
    });
    if (haltError !== null) {
      throw haltError;
    }
    return result;
  } finally {
    monitor.stop();
  }
}

/**
 * Builds the `[health-check]` user-turn payload injected via
 * {@link ForjisEngine.onUserMessage} when a role's events JSONL has been
 * silent past the stuck threshold.
 *
 * The text is intentionally directive: the model is asked either to defer
 * (with a one-line `[orchestrator]: ... ignoring nudge` reply that the
 * `forjis-workflow` skill prescribes) or to abort and re-invoke the
 * subagent once. Never treat the nudge as a fatal signal.
 *
 * @param roleName - Name of the stuck role from {@link RoleIdentity.role}.
 * @param retryCount - 1-based nudge count from the monitor.
 * @returns The user-turn text to write to the orchestrator's stdin.
 */
function buildNudge(roleName: string, retryCount: number): string {
  return (
    `[health-check] Role "${roleName}" has had no events written for longer ` +
    `than the configured threshold (nudge ${retryCount}). Either interrupt ` +
    `that role's current tool call and re-invoke it once with a brief ` +
    `explanation, or reply with one line stating what it is genuinely ` +
    `waiting on (e.g. a long test run) so the next health-check tick can ` +
    `be ignored.`
  );
}

/**
 * Walks every role in the composed orgs tree and calls
 * `resolveRoleVisuals` for those with a non-empty `visuals` list.
 *
 * Each call writes the role's visuals artefact to
 * `.forjis/tasks/<taskId>/visuals-<org>-<team>-<role>.yaml` and may
 * acquire one or more refcounted subprocess handles. The concatenated
 * `acquiredKeys` are returned so the caller can release them after
 * `engine.invoke` completes.
 *
 * Roles without visuals are silently skipped (FR-19) — no artefact,
 * no log line, no subprocess. Any error thrown during the per-role
 * resolution is caught and logged as a warning so one misconfigured
 * role cannot block invocation of the rest (FR-20 best-effort).
 *
 * @param projectDir - Absolute project root.
 * @param taskId - Identifier of the current task.
 * @param orgs - Composed runtime orgs tree from the resolver.
 * @returns Refcount keys to release after invocation ends.
 */
async function resolveVisualsForRoles(
  projectDir: string,
  taskId: string,
  orgs: ConfigResult['runtimeConfig']['orgs'],
): Promise<string[]> {
  const keys: string[] = [];
  for (const org of orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        if (!role.visuals || role.visuals.length === 0) continue;
        try {
          const result = await resolveRoleVisuals({
            role,
            taskId,
            projectDir,
          });
          keys.push(...result.acquiredKeys);
        } catch (err) {
          // FR-20 best-effort: a single misconfigured role must not
          // block the rest. Surface the failure as a warning so the
          // operator still sees it.
          console.warn(
            `[role-visuals]: failed to prepare "${role.org}:${role.team}:${role.name}" — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }
  return keys;
}

/** Shape of `.forjis/config/context.yaml` on disk. */
interface ContextYamlFile {
  refresh_on_task?: boolean;
  inline_top_n?: number;
  concurrency?: number;
}

/** Default for `context.refresh_on_task` when the file is absent. */
const CONTEXT_DEFAULT_REFRESH_ON_TASK = true;

/** Default for `context.inline_top_n` when the file is absent. */
const CONTEXT_DEFAULT_INLINE_TOP_N = 20;

/** Default for `context.concurrency` when the file is absent. */
const CONTEXT_DEFAULT_CONCURRENCY = 16;

/** Regex used to extract path-like tokens from TASK.md + exploration.md. */
const CANDIDATE_PATH_REGEX =
  /[\w./-]+\.(ts|tsx|js|jsx|md|ya?ml|json|sh|py)\b/g;

/**
 * Flattens the runtime config role tree into {@link ArtefactRole}s.
 *
 * @param orgs - Top-level runtime orgs.
 * @returns One entry per (org, team, role).
 */
function flattenRoles(
  orgs: ConfigResult['runtimeConfig']['orgs'],
): ArtefactRole[] {
  const out: ArtefactRole[] = [];
  for (const org of orgs) {
    for (const team of org.teams) {
      for (const role of team.roles) {
        out.push({
          org: role.org,
          team: role.team,
          role: role.name,
          stage: role.stage,
        });
      }
    }
  }
  return out;
}

/**
 * Builds the candidate-path set used by the per-role artefact and the
 * overlap scanner.
 *
 * Sources (union, dedupe, POSIX-normalised):
 *   - path-like tokens in TASK.md
 *   - path-like tokens in openspec/changes/<taskId>/exploration.md
 *   - top-20 rows from `rankByTask(tree, taskDescription, 20)`
 */
async function buildCandidatePaths(
  projectDir: string,
  taskId: string,
  taskDescription: string,
  tree: { files: Array<{ path: string; summary: string }> },
): Promise<string[]> {
  const set = new Set<string>();

  const taskMdPath = join(projectDir, '.forjis', 'tasks', taskId, 'TASK.md');
  const explorationPath = join(
    projectDir,
    'openspec',
    'changes',
    taskId,
    'exploration.md',
  );

  for (const candidate of [taskMdPath, explorationPath]) {
    try {
      const content = await readFileAsync(candidate, 'utf-8');
      for (const match of content.matchAll(CANDIDATE_PATH_REGEX)) {
        const p = match[0].replace(/\\/g, '/');
        set.add(p);
      }
    } catch {
      /* ignore missing file */
    }
  }

  for (const ranked of rankByTask(
    tree.files as Array<{ path: string; oid: string; summary: string }>,
    taskDescription,
    20,
  )) {
    set.add(ranked.path);
  }

  return Array.from(set);
}

/**
 * Runs `git diff-tree --no-commit-id --name-status -r HEAD` in
 * `projectDir` and returns the raw stdout lines.
 *
 * Returns an empty array on any failure (non-zero exit, git missing,
 * non-git repo). Never throws.
 */
function gitDiffTreeHead(projectDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawnChild(
      'git',
      ['diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD'],
      { cwd: projectDir },
    );
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      resolve(lines);
    });
  });
}

/**
 * Extracts the `file_path` from a `Read` tool-call payload.
 *
 * Claude tool-call payloads use `file_path` for `Read`. Returns null
 * when the payload is missing the field or the value is not a
 * non-empty string.
 */
function extractReadFilePath(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const fp = (payload as Record<string, unknown>).file_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

/**
 * Wraps a live {@link ForjisEngine} handle in a summariser-shaped seam
 * compatible with `summarize.ts`'s `engineInvokeImpl` parameter.
 *
 * The adapter combines the static system prompt and the per-file user
 * prompt with a `\n\n---\n\n` separator before delegating to the
 * engine's single-string `prompt()` method. Reuses the engine handle
 * already loaded for task dispatch — never calls `loadEngine` itself.
 *
 * @param engine - Live engine handle owned by `runCommand`.
 * @returns A `summarizeFile`-shaped function that injects the engine
 *   adapter into every per-file call.
 */
function buildSummarizeImplFromEngine(
  engine: ForjisEngine,
): typeof summarizeFile {
  const engineImpl = async (
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> => {
    const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
    const opts = new PromptOptions();
    opts.returnOutput = true;
    // Suppress per-call subprocess exit lines under parallelism — the
    // throttled `[context-cache]: X/Y summarized` reporter is the
    // sole operator-visible signal during a refresh.
    opts.silent = true;
    return engine.prompt(combined, opts);
  };
  return (input, opts) =>
    summarizeFile(input, {
      ...(opts as SummarizeOptions | undefined),
      engineInvokeImpl: engineImpl,
    });
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
