/**
 * Tests for: engine-exposes-internal-no-id-on-interrupt bug fix
 * Part 2: Early-exit guard in runCommand when no pending tasks exist.
 *
 * Verifies:
 *   1. runCommand() exits cleanly when no pending tasks and continuous=false.
 *   2. The early-exit log message is exactly "[forjis]: no pending tasks found. Nothing to run."
 *   3. engine.cleanup() is called on early exit.
 *   4. engine.invoke() is NOT called when early exit fires.
 *   5. Early-exit guard does NOT trigger when continuous=true (watch mode).
 *   6. Early-exit guard does NOT trigger when pending tasks exist.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock state (captured by mock factory closures)
// ---------------------------------------------------------------------------

let listAllResult: Array<{ id: string; status: string }>;
let invokeCallCount: number;
let cleanupCalled: boolean;
let dispatchQueue: Array<Record<string, unknown> | null>;
let transitionLog: Array<{ id: string; status: string }>;

const mockConfigDir = '/mock/project/.forjis/config';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic import of run.js
// ---------------------------------------------------------------------------

jest.unstable_mockModule('@forjis/resolver', () => ({
  resolve: jest.fn().mockResolvedValue({
    generated: ['tasks.yaml'],
    skipped: [],
    configDir: mockConfigDir,
    runtimeConfig: { orgs: [] },
    registry: { resources: new Map() },
    summary: { orgCount: 1, pluginCount: 0, roleCount: 1 },
  }),
  loadBuildFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
  parseBuildFile: jest.fn().mockReturnValue({
    version: 1, engine: 'claude', repositories: [], plugins: [],
    tasks: { path: './tasks', maxConcurrent: 1 },
    orgs: [], outcome: null, tokenBudget: null, constraints: null, personas: null,
  }),
  parseDuration: jest.fn().mockReturnValue(3600000),
}));

jest.unstable_mockModule('../engine.js', () => ({
  loadEngine: jest.fn().mockImplementation(async () => ({
    name: 'mock-engine',
    checkPrerequisites: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
    invoke: jest.fn(async (opts: Record<string, unknown>) => {
      invokeCallCount++;
      return { exitCode: 0, taskId: opts['taskId'], stage: null };
    }),
    cleanup: jest.fn(async () => { cleanupCalled = true; }),
    prompt: jest.fn<() => Promise<string>>().mockResolvedValue(''),
  })),
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
    scanDirectory: jest.fn().mockResolvedValue([]),
    ingestInline: jest.fn(),
    nextDispatchable: jest.fn(async () => {
      const next = dispatchQueue.shift();
      return next === undefined ? null : next;
    }),
    transition: jest.fn(async (id: string, status: string) => {
      transitionLog.push({ id, status });
    }),
    listAll: jest.fn(async () => listAllResult),
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
    isThresholdExceeded: jest.fn().mockReturnValue(false),
    getUsageRatio: jest.fn().mockReturnValue(0),
    reset: jest.fn(),
  })),
}));

jest.unstable_mockModule('../health-check.js', () => ({
  HealthCheckMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    resetBaseline: jest.fn(),
    getAllRetryStates: jest.fn(() => new Map()),
    getRoleRetryState: jest.fn(),
  })),
}));

jest.unstable_mockModule('../process-utils.js', () => ({
  killProcess: jest.fn(),
  readPidSync: jest.fn().mockReturnValue(null),
  pidFilePath: jest.fn((_dir: string, taskId: string) => `/mock/.forjis/tasks/${taskId}/pid`),
}));

jest.unstable_mockModule('../web-services/plan-writer.js', () => ({
  writePipelinePlan: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  syncPlanFromState: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  syncBranchesFromState: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  forcePlanReady: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getRunningRole: jest.fn().mockResolvedValue(null),
  syncRetryStateToPlan: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  // Strict plan parser — no-op in this test (resolved to null / no throw).
  parsePipelinePlan: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
  // Re-exported error class from the plan-writer surface; the test doesn't
  // exercise it, but run.ts imports it unconditionally.
  PlanRoleNotFoundError: class extends Error {},
}));

jest.unstable_mockModule('../web-services/event-writer.js', () => ({
  appendEvent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../errors.js', () => ({
  NoTaskSourceError: class extends Error { constructor() { super('No task source'); } },
  CliError: class extends Error {},
  EngineInvocationError: class extends Error {
    constructor(public readonly taskId: string, cause: Error) {
      super(`Engine invocation failed for task "${taskId}": ${cause.message}`, { cause });
    }
  },
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
// Dynamic import AFTER all mocks are declared
// ---------------------------------------------------------------------------

const { runCommand } = await import('../commands/run.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeTask(id: string, status: 'pending' | 'done' | 'failed' | 'running' = 'pending') {
  return {
    id, status, priority: 'normal', created: new Date().toISOString(),
    source: 'cli' as const, dependencies: [], description: `task ${id}`, retryCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  listAllResult = [];
  invokeCallCount = 0;
  cleanupCalled = false;
  dispatchQueue = [];
  transitionLog = [];

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'on').mockImplementation((_event, _handler) => process);
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCommand — early-exit guard: no pending tasks + continuous=false', () => {
  it('prints the exact expected log message when queue is empty', async () => {
    listAllResult = [];

    await runCommand(makeOptions({ watch: false }));

    const logCalls = logSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls).toContain('[forjis]: no pending tasks found. Nothing to run.');
  });

  it('calls engine.cleanup() on early exit', async () => {
    listAllResult = [];

    await runCommand(makeOptions({ watch: false }));

    expect(cleanupCalled).toBe(true);
  });

  it('does NOT call engine.invoke() when early exit fires', async () => {
    listAllResult = [];

    await runCommand(makeOptions({ watch: false }));

    expect(invokeCallCount).toBe(0);
  });

  it('exits cleanly when all tasks are "done"', async () => {
    listAllResult = [makeTask('task-1', 'done'), makeTask('task-2', 'done')];

    await runCommand(makeOptions({ watch: false }));

    const logCalls = logSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(msg => msg.includes('no pending tasks found'))).toBe(true);
    expect(invokeCallCount).toBe(0);
  });

  it('exits cleanly when all tasks are "failed"', async () => {
    listAllResult = [makeTask('task-1', 'failed')];

    await runCommand(makeOptions({ watch: false }));

    const logCalls = logSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(msg => msg.includes('no pending tasks found'))).toBe(true);
    expect(invokeCallCount).toBe(0);
  });

  it('does NOT apply early-exit when a pending task exists (guard is skipped)', async () => {
    listAllResult = [makeTask('task-1', 'pending')];
    dispatchQueue = [makeTask('task-1'), null];

    await runCommand(makeOptions({ watch: false }));

    const logCalls = logSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(msg => msg.includes('no pending tasks found'))).toBe(false);
    expect(invokeCallCount).toBe(1);
  });
});

describe('runCommand — early-exit guard: continuous=true bypasses early exit', () => {
  it('does NOT print no-pending-tasks message when watch=true even with empty queue', async () => {
    jest.useFakeTimers();

    listAllResult = [];
    dispatchQueue = [null];

    const runPromise = runCommand(makeOptions({ watch: true }));

    // Flush promises so the loop reaches the setTimeout poll sleep.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Advance fake timers past the 5-second poll sleep so the loop iterates.
    jest.advanceTimersByTime(6000);

    // Give one more tick to reach next loop iteration.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    jest.useRealTimers();

    // Verify early-exit message was never logged.
    const logCalls = logSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(msg => msg.includes('no pending tasks found. Nothing to run.'))).toBe(false);

    // runPromise will remain pending (continuous loop) — that is correct behavior.
    // We do NOT await it to avoid the test hanging.
  });
});
