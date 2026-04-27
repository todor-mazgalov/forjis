/**
 * Tests for the soft-nudge body of `invokeWithHealthCheck` in
 * `forjis-runtime/facilitator/src/commands/run.ts` (fix-health-check).
 *
 * Behaviour under test:
 *   - The stuck callback (halt = false) calls `engine.onUserMessage` with
 *     a payload that begins with `[health-check]` and names the stuck
 *     role. The orchestrator subprocess pid is NOT killed.
 *   - The halt callback (halt = true) reads the pid file and kills the
 *     subprocess via `killProcess`, then the run transitions to failed.
 *   - When the engine emits a final `result` (modelled by the stub
 *     resolving normally), `engine.invoke` resolves and the task
 *     transitions to `done`.
 *   - `monitor.stop()` is called in the engine's `finally` block.
 *
 * The harness is a deep stub of every external module the run module
 * imports, mirroring the established pattern in
 * `run-main-loop.test.ts`. The dispatch queue, engine impl, monitor
 * callback, and pid map are all captured-by-reference closures so
 * each test can configure them independently.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock state — declared before mocks so factory closures can capture
// ---------------------------------------------------------------------------

/** Tracks engine.invoke calls. */
let invokeCallCount = 0;

/** Controls what engine.invoke returns or throws. */
let invokeImpl: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Records every onUserMessage call with `(taskId, text)` so the test can
 * assert that the nudge text begins with `[health-check]` and names the
 * stuck role.
 */
let onUserMessageLog: Array<{ taskId: string; text: string }>;

/**
 * Optional stub that lets a single test reject the next onUserMessage
 * call (subprocess closed). When null, onUserMessage resolves normally
 * and records the call.
 */
let onUserMessageImpl: ((taskId: string, text: string) => Promise<void>) | null;

/** Queue of tasks returned by nextDispatchable — shift one per call. */
let dispatchQueue: Array<Record<string, unknown> | null>;

/** Records every queue.transition call. */
let transitionLog: Array<{ id: string; status: string }>;

/** Records every killProcess call (we expect zero on the soft-nudge path). */
let killLog: number[];

/** Per-task pid map consulted by readPidSync. */
let pidByTask: Record<string, number | null>;

/** Captured SIGINT handler — runs nothing in these tests. */
let sigintHandler: (() => void) | null = null;

/** Captured process.exit spy. */
let exitSpy: ReturnType<typeof jest.spyOn>;

/** Spies for console.log / console.error to suppress noisy output. */
let logSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;

/**
 * Drives the HealthCheckMonitor mock: each test installs a function that
 * receives the monitor's onStuck callback and may invoke it on its own
 * schedule (e.g. once with halt=false, once with halt=true).
 */
let healthCheckStartImpl: (
  getCurrentRole: () => unknown,
  getStartedAt: () => string,
  onStuck: (roleName: string, retryCount: number, halt: boolean) => void,
) => void;

/** Counts monitor.stop calls. */
let monitorStopCount: number;

/** Mock configDir. */
const mockConfigDir = '/mock/project/.forjis/config';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the dynamic import of run.js
// ---------------------------------------------------------------------------

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
    onUserMessage: jest.fn((taskId: string, text: string) => {
      if (onUserMessageImpl) {
        return onUserMessageImpl(taskId, text);
      }
      onUserMessageLog.push({ taskId, text });
      return Promise.resolve();
    }),
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
      return [];
    }),
    checkClarifications: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getTasksPath: jest.fn().mockReturnValue(null),
    getPollIntervalMs: jest.fn().mockReturnValue(5000),
    config: null,
  })),
}));

jest.unstable_mockModule('../token-tracker.js', () => ({
  TokenTracker: jest.fn().mockImplementation(() => ({
    load: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getTotalTokens: jest.fn().mockReturnValue(0),
    getWindowStartedAt: jest.fn().mockReturnValue(new Date()),
    recordUsage: jest.fn(),
    persist: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isThresholdExceeded: jest.fn(() => false),
    getUsageRatio: jest.fn().mockReturnValue(0),
    reset: jest.fn(),
  })),
}));

jest.unstable_mockModule('../health-check.js', () => ({
  HealthCheckMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(
      (
        getCurrentRole: () => unknown,
        getStartedAt: () => string,
        onStuck: (r: string, c: number, h: boolean) => void,
      ) => {
        healthCheckStartImpl(getCurrentRole, getStartedAt, onStuck);
      },
    ),
    stop: jest.fn(() => { monitorStopCount++; }),
    resetBaseline: jest.fn(),
    getAllRetryStates: jest.fn(() => new Map()),
    getRoleRetryState: jest.fn(),
  })),
}));

jest.unstable_mockModule('../process-utils.js', () => ({
  killProcess: jest.fn((pid: number) => { killLog.push(pid); }),
  readPidSync: jest.fn((_dir: string, taskId: string) => pidByTask[taskId] ?? null),
  pidFilePath: jest.fn((_dir: string, taskId: string) => `/mock/.forjis/tasks/${taskId}/pid`),
}));

jest.unstable_mockModule('../web-services/plan-writer.js', () => ({
  writePipelinePlan: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  syncPlanFromState: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  syncBranchesFromState: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  forcePlanReady: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getRunningRole: jest.fn().mockResolvedValue(null),
  syncRetryStateToPlan: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  parsePipelinePlan: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
  PlanRoleNotFoundError: class extends Error {},
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
  renameSync: jest.fn(),
}));

jest.unstable_mockModule('node:module', () => ({
  createRequire: jest.fn(() => {
    const req = () => ({});
    req.resolve = () => '/mock/path';
    return req;
  }),
}));

// ---------------------------------------------------------------------------
// Dynamic import — after every mock has been declared
// ---------------------------------------------------------------------------

const { runCommand } = await import('../commands/run.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal RunOptions object. */
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

/** Builds a minimal task state object. */
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

/** A successful engine result for the given task id. */
function successResult(taskId: string) {
  return {
    exitCode: 0,
    taskId,
    stage: null,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  invokeCallCount = 0;
  invokeImpl = async (opts) => {
    invokeCallCount++;
    return successResult((opts as { taskId: string }).taskId);
  };
  onUserMessageLog = [];
  onUserMessageImpl = null;
  dispatchQueue = [];
  transitionLog = [];
  killLog = [];
  pidByTask = {};
  monitorStopCount = 0;
  healthCheckStartImpl = () => {};
  sigintHandler = null;

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

describe('invokeWithHealthCheck — soft nudge', () => {
  /**
   * The stuck callback (halt = false) MUST nudge via engine.onUserMessage
   * with text starting with `[health-check]` that names the stuck role,
   * and MUST NOT kill the subprocess. The engine then resolves
   * naturally, transitioning the task to done.
   */
  it('nudges via onUserMessage with [health-check] text and does NOT kill the subprocess', async () => {
    pidByTask['task-1'] = 12345;

    healthCheckStartImpl = (_getCurrent, _getStarted, onStuck) => {
      // Fire one stuck tick (halt = false) shortly after engine.invoke is called.
      process.nextTick(() => onStuck('developer', 1, false));
    };

    invokeImpl = async (opts) => {
      invokeCallCount++;
      // Yield so the stuck callback can fire before we resolve.
      await new Promise((r) => setTimeout(r, 5));
      return successResult((opts as { taskId: string }).taskId);
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    expect(invokeCallCount).toBe(1);
    expect(killLog).toEqual([]);
    expect(onUserMessageLog).toHaveLength(1);
    expect(onUserMessageLog[0].taskId).toBe('task-1');
    expect(onUserMessageLog[0].text.startsWith('[health-check]')).toBe(true);
    expect(onUserMessageLog[0].text).toContain('"developer"');

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'done']);
  });

  /**
   * The halt callback (halt = true) MUST read the pid file and kill the
   * subprocess via killProcess. The task then transitions to failed.
   */
  it('halt callback kills the subprocess via killProcess and transitions task to failed', async () => {
    pidByTask['task-1'] = 99999;

    healthCheckStartImpl = (_getCurrent, _getStarted, onStuck) => {
      // Fire halt = true once the engine yields.
      process.nextTick(() => onStuck('reviewer', 3, true));
    };

    invokeImpl = async () => {
      invokeCallCount++;
      // Allow the halt callback to fire, then reject as the engine
      // would when its subprocess gets killed.
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('Process killed');
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    expect(killLog).toContain(99999);
    expect(onUserMessageLog).toHaveLength(0);

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'failed']);
  });

  /**
   * If onUserMessage rejects (subprocess already closed during the
   * 2 s grace window), the run loop must NOT kill the subprocess and
   * the engine's natural resolution path must still take over.
   */
  it('swallows onUserMessage failure and lets the engine resolve naturally', async () => {
    pidByTask['task-1'] = 7777;

    onUserMessageImpl = async () => {
      throw new Error('stdin closed for task "task-1"');
    };

    healthCheckStartImpl = (_getCurrent, _getStarted, onStuck) => {
      process.nextTick(() => onStuck('developer', 1, false));
    };

    invokeImpl = async (opts) => {
      invokeCallCount++;
      await new Promise((r) => setTimeout(r, 5));
      return successResult((opts as { taskId: string }).taskId);
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    expect(killLog).toEqual([]);
    expect(invokeCallCount).toBe(1);

    const statuses = transitionLog.filter((t) => t.id === 'task-1').map((t) => t.status);
    expect(statuses).toEqual(['running', 'done']);

    // The error spy should not have observed an unhandled rejection
    // bubble up from invokeWithHealthCheck.
    expect(errorSpy.mock.calls.flat().some((arg) =>
      typeof arg === 'string' && arg.includes('stdin closed'),
    )).toBe(false);
  });

  /**
   * monitor.stop MUST be invoked in the engine's finally block so the
   * setInterval timer is released even on the happy path.
   */
  it('calls monitor.stop after engine.invoke resolves', async () => {
    healthCheckStartImpl = () => {};
    invokeImpl = async (opts) => {
      invokeCallCount++;
      return successResult((opts as { taskId: string }).taskId);
    };

    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions());

    expect(monitorStopCount).toBeGreaterThanOrEqual(1);
  });
});
