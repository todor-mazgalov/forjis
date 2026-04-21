/**
 * Tests for the run command's main loop, health check retry, SIGINT cleanup,
 * and token budget gating.
 *
 * Exercises the internal runMainLoop and invokeWithHealthCheck code paths
 * indirectly through the exported runCommand entry point, with all external
 * dependencies stubbed via jest.unstable_mockModule.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { TaskEvent } from '@forjis/shared';

// ---------------------------------------------------------------------------
// Shared mock state -- declared before mocks so factory closures can capture
// ---------------------------------------------------------------------------

/** Tracks engine.invoke calls for assertion. */
let invokeCallCount = 0;

/** Controls what engine.invoke returns or throws. */
let invokeImpl: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Queue of tasks returned by nextDispatchable -- shift one per call. */
let dispatchQueue: Array<Record<string, unknown> | null>;

/** Tracks transitions recorded by queue.transition. */
let transitionLog: Array<{ id: string; status: string }>;

/** Tracks killProcess calls. */
let killLog: number[];

/** Controls readPidSync return value per task id. */
let pidByTask: Record<string, number | null>;

/** Whether the token budget threshold is exceeded. */
let budgetExceeded: boolean;

/** Captured SIGINT handler so tests can invoke it. */
let sigintHandler: (() => void) | null = null;

/** Captured process.exit spy. */
let exitSpy: ReturnType<typeof jest.spyOn>;

/** Spy for console.log to suppress noisy output. */
let logSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;

/** Controls HealthCheckMonitor onStuck callback trigger. */
let healthCheckStartImpl: (
  getCurrentRole: () => unknown,
  getStartedAt: () => string,
  onStuck: (roleName: string, retryCount: number, halt: boolean) => void,
) => void;

/** Track monitor start/stop calls. */
let monitorStartCount: number;
let monitorStopCount: number;

/** Track monitor.resetBaseline calls. */
let monitorResetCount: number;

/** Retry states returned by the monitor. */
const emptyRetryStates = new Map();

/**
 * Controls what parsePipelinePlan throws (or returns). Replaced per-test to
 * exercise the strict-parser wire-up: when set to throw
 * `PlanRoleNotFoundError`, the statePollTimer inside the run loop should
 * capture it, archive the plan, and bubble the error to `queue.transition('failed')`.
 */
let parsePlanImpl: () => Promise<unknown>;

/** Tracks archive (pipeline-plan.yaml -> pipeline-plan.failed.yaml) calls. */
let archivedPaths: Array<{ from: string; to: string }>;

/** Mock configDir value. */
const mockConfigDir = '/mock/project/.forjis/config';

// ---------------------------------------------------------------------------
// Module mocks -- must be declared before the dynamic import of run.js
// ---------------------------------------------------------------------------

/* Mock @forjis/resolver to return a ConfigResult from resolve() */
jest.unstable_mockModule('@forjis/resolver', () => ({
  resolve: jest.fn().mockResolvedValue({
    generated: ['orgs.yaml', 'tasks.yaml'],
    skipped: [],
    configDir: mockConfigDir,
    runtimeConfig: { orgs: [] },
    registry: { resources: new Map() },
    summary: { orgCount: 1, pluginCount: 1, roleCount: 2 },
  }),
  loadBuildFile: jest.fn<() => Promise<string>>().mockResolvedValue('mock-content'),
  parseBuildFile: jest.fn().mockReturnValue({
    version: 1,
    engine: 'claude',
    repositories: [],
    plugins: [],
    tasks: { path: './tasks', maxConcurrent: 1 },
    orgs: [],
    outcome: null,
    tokenBudget: null,
    constraints: null,
    personas: null,
  }),
  parseDuration: jest.fn().mockReturnValue(3600000),
}));

jest.unstable_mockModule('../engine.js', () => ({
  loadEngine: jest.fn().mockResolvedValue({
    name: 'mock-engine',
    checkPrerequisites: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    invoke: jest.fn((opts: Record<string, unknown>) => invokeImpl(opts)),
    cleanup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    prompt: jest.fn<() => Promise<string>>().mockResolvedValue(''),
  }),
}));

jest.unstable_mockModule('../state.js', () => ({
  readYamlFile: jest.fn().mockImplementation((filePath: string) => {
    if (typeof filePath === 'string' && filePath.includes('tasks.yaml')) {
      return Promise.resolve({
        source: 'cli',
        path: './tasks',
        poll_interval: '5s',
        max_concurrent: 1,
        auto_dependencies: false,
      });
    }
    if (typeof filePath === 'string' && filePath.includes('token-budget.yaml')) {
      return Promise.resolve(null);
    }
    if (typeof filePath === 'string' && filePath.includes('health-check.yaml')) {
      return Promise.resolve({ interval: 5, max_retries: 2 });
    }
    return Promise.resolve(null);
  }),
  writeYamlFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  atomicWriteFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  ensureDir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../display.js', () => ({
  renderStatus: jest.fn().mockReturnValue(''),
}));

/* TaskQueue mock -- returns tasks from dispatchQueue, logs transitions */
jest.unstable_mockModule('../task-queue.js', () => ({
  TaskQueue: jest.fn().mockImplementation(() => ({
    scanDirectory: jest.fn().mockResolvedValue([
      { id: 'task-1', status: 'pending', priority: 'normal' },
    ]),
    ingestInline: jest.fn(),
    nextDispatchable: jest.fn(async () => {
      const next = dispatchQueue.shift();
      return next === undefined ? null : next;
    }),
    transition: jest.fn(async (id: string, status: string) => {
      transitionLog.push({ id, status });
    }),
    listAll: jest.fn(async () => {
      // If no transitions have been recorded yet, return a pending task
      // so the early-exit guard in runCommand does not bail out.
      if (transitionLog.length === 0) {
        return [{
          id: 'task-1',
          status: 'pending',
          priority: 'normal',
          created: new Date().toISOString(),
          source: 'cli' as const,
          dependencies: [],
          description: 'mock',
          retryCount: 0,
        }];
      }
      return transitionLog
        .filter((t) => t.status === 'running')
        .map((t) => ({
          id: t.id,
          status: 'running',
          priority: 'normal',
          created: new Date().toISOString(),
          source: 'cli' as const,
          dependencies: [],
          description: 'mock',
          retryCount: 0,
        }));
    }),
    checkClarifications: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getTasksPath: jest.fn().mockReturnValue(null),
    getPollIntervalMs: jest.fn().mockReturnValue(5000),
    config: null,
  })),
}));

/* TokenTracker mock */
jest.unstable_mockModule('../token-tracker.js', () => ({
  TokenTracker: jest.fn().mockImplementation(() => ({
    load: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getTotalTokens: jest.fn().mockReturnValue(0),
    getWindowStartedAt: jest.fn().mockReturnValue(new Date()),
    recordUsage: jest.fn(),
    persist: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isThresholdExceeded: jest.fn(() => budgetExceeded),
    getUsageRatio: jest.fn().mockReturnValue(0.95),
    reset: jest.fn(),
  })),
}));

/* HealthCheckMonitor mock */
jest.unstable_mockModule('../health-check.js', () => ({
  HealthCheckMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn((getCurrentRole: () => unknown, getStartedAt: () => string, onStuck: (r: string, c: number, h: boolean) => void) => {
      monitorStartCount++;
      healthCheckStartImpl(getCurrentRole, getStartedAt, onStuck);
    }),
    stop: jest.fn(() => { monitorStopCount++; }),
    resetBaseline: jest.fn(() => { monitorResetCount++; }),
    getAllRetryStates: jest.fn(() => emptyRetryStates),
    getRoleRetryState: jest.fn(),
  })),
}));

jest.unstable_mockModule('../process-utils.js', () => ({
  killProcess: jest.fn((pid: number) => { killLog.push(pid); }),
  readPidSync: jest.fn((_dir: string, taskId: string) => pidByTask[taskId] ?? null),
  pidFilePath: jest.fn((_dir: string, taskId: string) => `/mock/.forjis/tasks/${taskId}/pid`),
}));

/**
 * PlanRoleNotFoundError class used by the mock module. Must be a single class
 * declared at module scope so both the mock factory and tests can use the
 * same constructor for `instanceof` checks inside run.ts.
 */
class MockPlanRoleNotFoundError extends Error {
  public readonly stepIndex: number;
  public readonly identity: { org: string; team: string; role: string };
  constructor(stepIndex: number, identity: { org: string; team: string; role: string }) {
    super(`Plan step ${stepIndex} references unknown role identity`);
    this.name = 'PlanRoleNotFoundError';
    this.stepIndex = stepIndex;
    this.identity = identity;
  }
}

jest.unstable_mockModule('../web-services/plan-writer.js', () => ({
  writePipelinePlan: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  syncPlanFromState: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  syncBranchesFromState: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  forcePlanReady: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getRunningRole: jest.fn().mockResolvedValue(null),
  syncRetryStateToPlan: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  parsePipelinePlan: jest.fn(() => parsePlanImpl()),
  // Re-exported error class — the real module surface now includes
  // PlanRoleNotFoundError for the strict plan parser. Used by the
  // wire-up test below for `err instanceof PlanRoleNotFoundError`.
  PlanRoleNotFoundError: MockPlanRoleNotFoundError,
}));

jest.unstable_mockModule('../web-services/event-writer.js', () => ({
  appendEvent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../errors.js', () => ({
  NoTaskSourceError: class extends Error { constructor() { super('No task source'); } },
  CliError: class extends Error {},
  EngineInvocationError: class extends Error {},
}));

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: jest.fn().mockReturnValue(''),
  unlinkSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
  renameSync: jest.fn((from: string, to: string) => {
    archivedPaths.push({ from, to });
  }),
}));

jest.unstable_mockModule('node:module', () => ({
  createRequire: jest.fn(() => {
    const req = () => ({});
    req.resolve = () => '/mock/path';
    return req;
  }),
}));

// ---------------------------------------------------------------------------
// Dynamic import of the module under test (after all mocks are declared)
// ---------------------------------------------------------------------------

const { runCommand } = await import('../commands/run.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds minimal RunOptions for test invocation. */
function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    buildFilePath: '/mock/forjis.yaml',
    inlineTask: null,
    dryRun: false,
    watch: false,
    noAssess: false,
    web: false,
    port: 4242,
    host: '127.0.0.1',
    webToken: null,
    projectDir: '/mock/project',
    ...overrides,
  };
}

/** Creates a minimal task state object. */
function makeTask(id: string) {
  return {
    id,
    status: 'pending' as const,
    priority: 'normal',
    created: new Date().toISOString(),
    source: 'cli' as const,
    dependencies: [],
    description: `Mock task ${id}`,
    retryCount: 0,
  };
}

/** Default engine result with exit code 0. */
function successResult(taskId: string) {
  return {
    exitCode: 0,
    taskId,
    stage: null,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  invokeCallCount = 0;
  invokeImpl = async (opts) => {
    invokeCallCount++;
    return successResult((opts as { taskId: string }).taskId);
  };
  dispatchQueue = [];
  transitionLog = [];
  killLog = [];
  pidByTask = {};
  budgetExceeded = false;
  sigintHandler = null;
  monitorStartCount = 0;
  monitorStopCount = 0;
  monitorResetCount = 0;
  archivedPaths = [];
  // Default: parser is a no-op (valid plan). Tests override to throw.
  parsePlanImpl = async () => null;

  healthCheckStartImpl = () => {};

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  jest.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'SIGINT') {
      sigintHandler = handler as () => void;
    }
    return process;
  });

  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMainLoop via runCommand', () => {
  it('transitions a queued task to running then done on engine success', async () => {
    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'done']);
    expect(invokeCallCount).toBe(1);
  });

  it('retries up to maxRetries when a stuck role is detected, calling killProcess each time', async () => {
    let stuckCallCount = 0;

    healthCheckStartImpl = (_getCurrent, _getStarted, onStuck) => {
      stuckCallCount++;
      if (stuckCallCount <= 2) {
        process.nextTick(() => onStuck('developer', stuckCallCount, false));
      }
    };

    pidByTask['task-1'] = 12345;

    let engineCallIndex = 0;
    invokeImpl = async (opts) => {
      invokeCallCount++;
      engineCallIndex++;
      // Yield to allow process.nextTick (onStuck) to fire before rejection
      await new Promise((r) => setTimeout(r, 5));
      if (engineCallIndex <= 2) {
        throw new Error('Process killed');
      }
      return successResult((opts as { taskId: string }).taskId);
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    expect(killLog.length).toBe(2);
    expect(killLog).toEqual([12345, 12345]);
    expect(invokeCallCount).toBe(3);

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'done']);
  });

  it('transitions to failed after maxRetries is exceeded', async () => {
    let stuckCallCount = 0;

    healthCheckStartImpl = (_getCurrent, _getStarted, onStuck) => {
      stuckCallCount++;
      if (stuckCallCount <= 2) {
        process.nextTick(() => onStuck('developer', stuckCallCount, false));
      } else {
        process.nextTick(() => onStuck('developer', stuckCallCount, true));
      }
    };

    pidByTask['task-1'] = 99999;

    invokeImpl = async () => {
      invokeCallCount++;
      // Yield to allow process.nextTick (onStuck) to fire before rejection
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('Process killed');
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'failed']);

    expect(killLog.length).toBeGreaterThanOrEqual(2);
  });

  it('SIGINT triggers cleanupOnExit, killing running tasks and calling process.exit(1)', async () => {
    let resolveEngine: (v: Record<string, unknown>) => void;
    const enginePromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveEngine = resolve;
    });

    invokeImpl = async () => {
      invokeCallCount++;
      return enginePromise;
    };

    pidByTask['task-1'] = 55555;
    dispatchQueue = [makeTask('task-1'), null];

    const runPromise = runCommand(makeOptions()).catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sigintHandler).not.toBeNull();
    if (sigintHandler) {
      await sigintHandler();
    }

    expect(killLog).toContain(55555);
    expect(exitSpy).toHaveBeenCalledWith(1);

    resolveEngine!(successResult('task-1'));
    await runPromise;
  });

  it('invokeWithHealthCheck resolves with engine result when no stuck event fires', async () => {
    healthCheckStartImpl = () => {};

    const expectedUsage = { inputTokens: 200, outputTokens: 100 };
    invokeImpl = async (opts) => {
      invokeCallCount++;
      return {
        exitCode: 0,
        taskId: (opts as { taskId: string }).taskId,
        stage: null,
        usage: expectedUsage,
      };
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    expect(invokeCallCount).toBe(1);
    expect(monitorStopCount).toBeGreaterThanOrEqual(1);

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'done']);
  });

  it('transitions task to failed and archives the plan when parsePipelinePlan throws PlanRoleNotFoundError (upfront)', async () => {
    // Parser throws on the upfront synchronous call (before the engine is
    // ever invoked). This exercises the `catch` branch right after the
    // initial `await getRunningRole` + `parsePipelinePlan` block.
    parsePlanImpl = async () => {
      throw new MockPlanRoleNotFoundError(0, { org: 'acme', team: 'dev', role: 'ghost' });
    };

    // Engine should not be reached; if it is, return success so the test
    // failure message is about the wrong transition, not a hang.
    invokeImpl = async (opts) => {
      invokeCallCount++;
      return successResult((opts as { taskId: string }).taskId);
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'failed']);

    // The offending plan was archived before the throw propagated.
    expect(archivedPaths.length).toBeGreaterThanOrEqual(1);
    const archived = archivedPaths[0];
    expect(archived.from).toContain('pipeline-plan.yaml');
    expect(archived.to).toContain('pipeline-plan.failed.yaml');

    // Engine must not have been invoked (upfront parse bailed early).
    expect(invokeCallCount).toBe(0);
  });
});
