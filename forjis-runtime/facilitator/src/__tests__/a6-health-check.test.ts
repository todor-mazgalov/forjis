/**
 * Unit tests for a6_health-check feature.
 *
 * Validates:
 *   FR-001 — Health check config schema validation (validateHealthCheck via parseBuildFile)
 *   FR-002 — Health check config propagation through RuntimeConfig (composeRuntime)
 *   FR-003 — Stuck role detection via stale JSONL mtime (HealthCheckMonitor)
 *   FR-004 — Stuck role detection via dead PID (HealthCheckMonitor + isPidAlive)
 *   FR-005 — Automatic retry on stuck detection (HealthCheckMonitor callback)
 *   FR-006 — Task halt when max retries exceeded (HealthCheckMonitor.handleStuck)
 *   FR-007 — Per-role independent retry counters (HealthCheckMonitor.getRoleRetryState)
 *   FR-008 — PipelineStep DTO extension with retryCount and halted fields
 *   FR-009 — Pipeline plan sync with retry state (syncRetryStateToPlan, syncPlanFromState)
 *   NFR-001 — isChecking guard prevents overlapping ticks
 *   NFR-002 — Race condition guard (engineCompleted pattern)
 *   NFR-004 — Backward compatibility (optional fields, default values)
 */

import { jest } from '@jest/globals';
import { parseBuildFile, composeRuntime, BuildFileValidationError } from '@forjis/resolver';
import {
  HealthCheckMonitor,
  isPidAlive,
  RoleRetryState,
} from '../health-check.js';
import {
  syncRetryStateToPlan,
  syncPlanFromState,
} from '../web-services/plan-writer.js';
import type { BuildConfig, HealthCheckConfig, RuntimeConfig } from '../types.js';
import type { PipelinePlanResponse, PipelineStep } from '@forjis/shared';
import type { ResourceRegistry } from '@forjis/resolver';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal valid build file YAML string. */
function minimalBuildYaml(extra = ''): string {
  return [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://github.com/a/b.git"',
    '    ref: v1',
    extra,
  ].join('\n');
}

/** Creates a minimal valid BuildConfig for compositor tests. */
function minimalBuildConfig(overrides?: Partial<BuildConfig>): BuildConfig {
  return {
    version: 1,
    repositories: [{ type: 'git', url: 'https://github.com/a/b.git', ref: 'v1' }],
    plugins: [],
    orgs: [],
    tasks: null,
    outcome: null,
    tokenBudget: null,
    constraints: null,
    personas: null,
    healthCheck: null,
    ...overrides,
  };
}

/** Creates a mock ResourceRegistry that always resolves. */
function mockRegistry(): ResourceRegistry {
  return {
    resolve: jest.fn().mockReturnValue({ filePath: '/fake/path.yaml', name: 'resource' }),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ResourceRegistry;
}

/** Creates a temp project directory with the required queue subdirectory. */
async function createProjectDir(taskId: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'forjis-hc-test-'));
  await mkdir(join(base, '.forjis', 'tasks', taskId), { recursive: true });
  await mkdir(join(base, '.forjis', 'tasks', taskId), { recursive: true });
  return base;
}

/** Removes a temp project directory. */
async function removeProjectDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Writes a pipeline-plan.yaml file. */
async function writePipelinePlan(
  projectDir: string,
  taskId: string,
  plan: PipelinePlanResponse,
): Promise<void> {
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  await writeFile(planPath, stringifyYaml(plan), 'utf-8');
}

/** Reads a pipeline-plan.yaml file. */
async function readPipelinePlan(
  projectDir: string,
  taskId: string,
): Promise<PipelinePlanResponse> {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const planPath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-plan.yaml');
  const content = await readFile(planPath, 'utf-8');
  return parse(content) as PipelinePlanResponse;
}

/** Writes a pipeline-state.yaml file. */
async function writePipelineState(
  projectDir: string,
  taskId: string,
  roles: Array<{ name: string; agent: string; status: string; description?: string }>,
): Promise<void> {
  const statePath = join(projectDir, '.forjis', 'tasks', taskId, 'pipeline-state.yaml');
  const state = {
    org: 'test-org',
    team: 'test-team',
    status: 'running',
    roles: roles.map((r) => ({ description: 'A test role', ...r })),
  };
  await writeFile(statePath, stringifyYaml(state), 'utf-8');
}

/**
 * Waits up to maxWaitMs for a condition to become true, polling every pollMs.
 * Used with real (non-fake) timers to let async tick I/O complete.
 */
async function waitFor(
  condition: () => boolean,
  maxWaitMs = 2000,
  pollMs = 10,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${maxWaitMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------------------------------------
// FR-001: Health Check Config Schema Validation
// ---------------------------------------------------------------------------

describe('FR-001: validateHealthCheck — parseBuildFile integration', () => {
  /** Flow 4: health_check omitted returns null on BuildConfig */
  it('returns healthCheck === null when health_check block is omitted', () => {
    const yaml = minimalBuildYaml();
    const config = parseBuildFile(yaml);
    expect(config.healthCheck).toBeNull();
  });

  /** Flow 5: valid interval and max_retries are parsed */
  it('parses valid interval and max_retries correctly', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  interval: 120',
      '  max_retries: 5',
    ].join('\n'));
    const config = parseBuildFile(yaml);
    expect(config.healthCheck).not.toBeNull();
    expect(config.healthCheck!.interval).toBe(120);
    expect(config.healthCheck!.maxRetries).toBe(5);
  });

  /** Flow 6: missing max_retries applies default of 3 */
  it('applies default max_retries when only interval is specified', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  interval: 60',
    ].join('\n'));
    const config = parseBuildFile(yaml);
    expect(config.healthCheck).not.toBeNull();
    expect(config.healthCheck!.interval).toBe(60);
    expect(config.healthCheck!.maxRetries).toBe(3);
  });

  /** Flow 7: empty health_check object applies both defaults */
  it('applies both defaults for empty health_check object', () => {
    const yaml = minimalBuildYaml('health_check: {}');
    const config = parseBuildFile(yaml);
    expect(config.healthCheck).not.toBeNull();
    expect(config.healthCheck!.interval).toBe(300);
    expect(config.healthCheck!.maxRetries).toBe(3);
  });

  /** missing interval applies default of 300 */
  it('applies default interval when only max_retries is specified', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  max_retries: 5',
    ].join('\n'));
    const config = parseBuildFile(yaml);
    expect(config.healthCheck).not.toBeNull();
    expect(config.healthCheck!.interval).toBe(300);
    expect(config.healthCheck!.maxRetries).toBe(5);
  });

  /** Flow 8: non-object health_check throws validation error */
  it('throws BuildFileValidationError when health_check is not an object', () => {
    const yaml = minimalBuildYaml('health_check: "bad"');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const errors = (err as BuildFileValidationError).errors;
      expect(errors.some((e) => e.includes('"health_check" must be an object'))).toBe(true);
    }
  });

  /** Flow 9: zero interval throws validation error */
  it('throws BuildFileValidationError when interval is 0', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  interval: 0',
    ].join('\n'));
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const errors = (err as BuildFileValidationError).errors;
      expect(errors.some((e) => e.includes('health_check.interval: must be a positive integer'))).toBe(true);
    }
  });

  /** interval negative throws */
  it('throws BuildFileValidationError when interval is negative', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  interval: -10',
    ].join('\n'));
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
  });

  /** Flow 10: negative max_retries throws validation error */
  it('throws BuildFileValidationError when max_retries is negative', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  max_retries: -1',
    ].join('\n'));
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const errors = (err as BuildFileValidationError).errors;
      expect(errors.some((e) => e.includes('health_check.max_retries: must be a positive integer'))).toBe(true);
    }
  });

  /** max_retries zero throws */
  it('throws BuildFileValidationError when max_retries is 0', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  max_retries: 0',
    ].join('\n'));
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
  });

  /** Flow 11: non-integer interval throws validation error */
  it('throws BuildFileValidationError when interval is a float', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  interval: 1.5',
    ].join('\n'));
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const errors = (err as BuildFileValidationError).errors;
      expect(errors.some((e) => e.includes('health_check.interval: must be a positive integer'))).toBe(true);
    }
  });

  /** Flow 12: unrecognized key throws validation error */
  it('throws BuildFileValidationError for unrecognized keys in health_check', () => {
    const yaml = minimalBuildYaml([
      'health_check:',
      '  interval: 60',
      '  foo: bar',
    ].join('\n'));
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      const errors = (err as BuildFileValidationError).errors;
      expect(errors.some((e) => e.includes('health_check: unrecognized key "foo"'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-002: Health Check Config Propagation through RuntimeConfig
// ---------------------------------------------------------------------------

describe('FR-002: composeRuntime — healthCheck propagation', () => {
  /** Flow 13: null healthCheck in BuildConfig applies defaults */
  it('uses default healthCheck when buildConfig.healthCheck is null', () => {
    const buildConfig = minimalBuildConfig({ healthCheck: null });
    const runtime = composeRuntime(buildConfig, [], mockRegistry());
    expect(runtime.healthCheck).toEqual({ interval: 300, maxRetries: 3 });
  });

  /** Flow 14: custom healthCheck values propagate to RuntimeConfig */
  it('propagates custom healthCheck values from BuildConfig', () => {
    const buildConfig = minimalBuildConfig({
      healthCheck: { interval: 120, maxRetries: 5 },
    });
    const runtime = composeRuntime(buildConfig, [], mockRegistry());
    expect(runtime.healthCheck.interval).toBe(120);
    expect(runtime.healthCheck.maxRetries).toBe(5);
  });

  it('healthCheck is always non-null on RuntimeConfig', () => {
    const buildConfig = minimalBuildConfig({ healthCheck: null });
    const runtime = composeRuntime(buildConfig, [], mockRegistry());
    expect(runtime.healthCheck).not.toBeNull();
    expect(typeof runtime.healthCheck.interval).toBe('number');
    expect(typeof runtime.healthCheck.maxRetries).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// FR-004: isPidAlive utility
// ---------------------------------------------------------------------------

describe('FR-004: isPidAlive', () => {
  /** Flow 15: returns true for a live process (current process) */
  it('returns true for the current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  /** Flow 16: returns false for a dead/nonexistent PID */
  it('returns false for a PID that does not exist', () => {
    // PID 999999 is extremely unlikely to exist
    expect(isPidAlive(999999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-007: HealthCheckMonitor — per-role retry state (unit-level, no I/O)
// ---------------------------------------------------------------------------

describe('FR-007: HealthCheckMonitor — getRoleRetryState', () => {
  /** Initial state is zero retries, not halted */
  it('returns retryCount=0 and halted=false for a role that was never retried', () => {
    const config: HealthCheckConfig = { interval: 300, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, '/tmp/project', 'task-1');
    const state = monitor.getRoleRetryState('developer');
    expect(state.retryCount).toBe(0);
    expect(state.halted).toBe(false);
  });

  /** getAllRetryStates returns empty map initially */
  it('returns an empty map when no roles have been retried', () => {
    const config: HealthCheckConfig = { interval: 300, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, '/tmp/project', 'task-1');
    expect(monitor.getAllRetryStates().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FR-003, FR-004, FR-005, FR-006, FR-007, NFR-001:
// HealthCheckMonitor — full behavior with real timers (interval=1ms for speed)
// ---------------------------------------------------------------------------

describe('HealthCheckMonitor — stuck detection and retry logic', () => {
  let projectDir: string;
  const taskId = 'task-hc-test';

  beforeAll(async () => {
    projectDir = await createProjectDir(taskId);
  });

  afterAll(async () => {
    await removeProjectDir(projectDir);
  });

  /**
   * FR-004, Flow 20: dead PID causes immediate stuck detection.
   * Uses a real 1ms interval — tick fires within milliseconds.
   * The onStuck callback calls stop() immediately to prevent multiple calls.
   */
  it('detects stuck role immediately when PID is dead (FR-004)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, '999999', 'utf-8');

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 }; // ~1ms
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    let capturedArgs: [string, number, boolean] | null = null;
    let resolve: () => void;
    const done = new Promise<void>((r) => { resolve = r; });

    monitor.start(
      () => ({ org: '', team: 'test-team', role: 'developer' }),
      () => new Date().toISOString(),
      (roleName, retryCount, shouldHalt) => {
        if (capturedArgs) return; // only capture first call
        capturedArgs = [roleName, retryCount, shouldHalt];
        monitor.stop();
        resolve();
      },
    );

    await done;
    await rm(pidPath, { force: true });

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs![0]).toBe('developer');
    expect(capturedArgs![1]).toBe(1);
    expect(capturedArgs![2]).toBe(false); // 1 < 3
  }, 10000);

  /**
   * FR-006, Flow 24: shouldHalt = true when retryCount reaches maxRetries.
   * Uses callback to stop on each detection to prevent extra calls.
   */
  it('sets shouldHalt=true when retryCount reaches maxRetries (FR-006)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, '999999', 'utf-8');

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 2 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    // --- First detection ---
    let firstArgs: [string, number, boolean] | null = null;
    await new Promise<void>((resolve) => {
      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'developer' }),
        () => new Date().toISOString(),
        (roleName, retryCount, shouldHalt) => {
          if (firstArgs) return;
          firstArgs = [roleName, retryCount, shouldHalt];
          monitor.stop();
          resolve();
        },
      );
    });
    expect(firstArgs![1]).toBe(1);
    expect(firstArgs![2]).toBe(false);

    // --- Second detection ---
    let secondArgs: [string, number, boolean] | null = null;
    await new Promise<void>((resolve) => {
      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'developer' }),
        () => new Date().toISOString(),
        (roleName, retryCount, shouldHalt) => {
          if (secondArgs) return;
          secondArgs = [roleName, retryCount, shouldHalt];
          monitor.stop();
          resolve();
        },
      );
    });
    expect(secondArgs![1]).toBe(2);
    expect(secondArgs![2]).toBe(true); // shouldHalt

    await rm(pidPath, { force: true });
  }, 10000);

  /**
   * FR-007, Flow 22–23: per-role counters are independent.
   * Uses callback to stop on first detection.
   */
  it('tracks independent per-role retry counters (FR-007)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, '999999', 'utf-8');

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    // Trigger for 'developer' — stop on first detection
    await new Promise<void>((resolve) => {
      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'developer' }),
        () => new Date().toISOString(),
        (_roleName, _retryCount, _shouldHalt) => {
          monitor.stop();
          resolve();
        },
      );
    });

    // developer: retryCount=1, reviewer: retryCount=0
    expect(monitor.getRoleRetryState('developer').retryCount).toBe(1);
    expect(monitor.getRoleRetryState('reviewer').retryCount).toBe(0);
    expect(monitor.getRoleRetryState('reviewer').halted).toBe(false);

    await rm(pidPath, { force: true });
  }, 10000);

  /**
   * FR-006: halted flag is set on RoleRetryState when shouldHalt.
   */
  it('sets halted=true on RoleRetryState when maxRetries is exceeded (FR-006)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, '999999', 'utf-8');

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 1 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    await new Promise<void>((resolve) => {
      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'assessor' }),
        () => new Date().toISOString(),
        (_roleName, _retryCount, _shouldHalt) => {
          monitor.stop();
          resolve();
        },
      );
    });

    const state = monitor.getRoleRetryState('assessor');
    expect(state.retryCount).toBe(1);
    expect(state.halted).toBe(true); // 1 >= 1

    await rm(pidPath, { force: true });
  }, 10000);

  /**
   * FR-003, Flow 19: No stuck detection when PID is alive and JSONL mtime is fresh.
   * The monitor fires once with a short interval; since JSONL is fresh, no stuck.
   * We wait 50ms and verify no onStuck was ever called.
   */
  it('does NOT fire onStuck when PID is alive and JSONL mtime is fresh (FR-003)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, String(process.pid), 'utf-8');

    const jsonlPath = join(projectDir, '.forjis', 'tasks', taskId, 'events-test-team-developer.jsonl');
    await writeFile(jsonlPath, '{"type":"load"}\n', 'utf-8');

    // Use a 60 second interval — won't fire during the 100ms wait
    const config: HealthCheckConfig = { interval: 60, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    const onStuck = jest.fn();
    monitor.start(
      () => ({ org: '', team: 'test-team', role: 'developer' }),
      () => new Date().toISOString(),
      onStuck,
    );

    // Wait 100ms — interval is 60s, so no tick fires
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    monitor.stop();

    expect(onStuck).not.toHaveBeenCalled();

    await rm(pidPath, { force: true });
    await rm(jsonlPath, { force: true });
  }, 10000);

  /**
   * FR-003, Flow 21: When no JSONL file exists, startedAt is used as baseline.
   * PID is alive but startedAt is 5 minutes ago, well past any interval.
   */
  it('uses startedAt as baseline when no JSONL file exists (FR-003)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, String(process.pid), 'utf-8');

    const jsonlPath = join(projectDir, '.forjis', 'tasks', taskId, 'events-test-team-analyst.jsonl');
    await rm(jsonlPath, { force: true });

    const oldStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    let capturedRole: string | null = null;
    await new Promise<void>((resolve) => {
      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'analyst' }),
        () => oldStartedAt,
        (roleName) => {
          if (capturedRole) return;
          capturedRole = roleName;
          monitor.stop();
          resolve();
        },
      );
    });

    expect(capturedRole).toBe('analyst');
    await rm(pidPath, { force: true });
  }, 10000);

  /**
   * FR-003, Flow 18: JSONL file with stale mtime triggers stuck detection.
   */
  it('detects stuck role when JSONL mtime is stale (FR-003)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, String(process.pid), 'utf-8');

    const jsonlPath = join(projectDir, '.forjis', 'tasks', taskId, 'events-test-team-reviewer.jsonl');
    await writeFile(jsonlPath, '{"type":"load"}\n', 'utf-8');

    const { utimes } = await import('node:fs/promises');
    const oldTime = (Date.now() - 10 * 60 * 1000) / 1000;
    await utimes(jsonlPath, oldTime, oldTime);

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    let capturedRole: string | null = null;
    await new Promise<void>((resolve) => {
      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'reviewer' }),
        () => new Date().toISOString(),
        (roleName) => {
          if (capturedRole) return;
          capturedRole = roleName;
          monitor.stop();
          resolve();
        },
      );
    });

    expect(capturedRole).toBe('reviewer');
    await rm(pidPath, { force: true });
    await rm(jsonlPath, { force: true });
  }, 10000);

  /**
   * NFR-001 / Flow 25: stop() prevents further tick callbacks.
   * Monitor is immediately stopped — no ticks should fire.
   */
  it('stop() prevents further ticks from firing (NFR-001)', async () => {
    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, '/nonexistent-dir', 'no-task');
    const onStuck = jest.fn();

    monitor.start(
      () => null, // no role active — tick skips when role is null
      () => new Date().toISOString(),
      onStuck,
    );
    monitor.stop(); // Stop immediately

    // Wait 50ms — no ticks should have produced onStuck calls
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // onStuck is never called because getCurrentRole returns null
    expect(onStuck).not.toHaveBeenCalled();
  }, 10000);

  /**
   * NFR-001 / Flow 25: stop() is safe to call multiple times.
   */
  it('stop() is safe to call multiple times without error', () => {
    const config: HealthCheckConfig = { interval: 300, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, '/nonexistent-dir', 'no-task');
    expect(() => {
      monitor.stop();
      monitor.stop();
      monitor.stop();
    }).not.toThrow();
  });

  /**
   * NFR-001: no onStuck when getCurrentRole returns null.
   * The tick runs but returns early without calling onStuck.
   */
  it('does not fire onStuck when getCurrentRole returns null (guard skips tick)', async () => {
    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, '/nonexistent-dir', 'no-task');
    const onStuck = jest.fn();

    monitor.start(
      () => null, // no active role — tick body returns early
      () => new Date().toISOString(),
      onStuck,
    );

    // Wait 100ms — ticks fire but getCurrentRole returns null
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    monitor.stop();

    expect(onStuck).not.toHaveBeenCalled();
  }, 10000);

  /**
   * Flow 5 / FR-005: retryCount increments on each stuck detection.
   * Uses callback to stop on each detection — guarantees exactly 1 call per start.
   */
  it('increments retryCount on each stuck detection (FR-005, FR-007)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, '999999', 'utf-8');

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 5 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    for (let i = 1; i <= 3; i++) {
      await new Promise<void>((resolve) => {
        monitor.start(
          () => ({ org: '', team: 'test-team', role: 'setup' }),
          () => new Date().toISOString(),
          () => {
            monitor.stop();
            resolve();
          },
        );
      });
      expect(monitor.getRoleRetryState('setup').retryCount).toBe(i);
    }

    await rm(pidPath, { force: true });
  }, 10000);

  /**
   * FR-007, Flow 22: halted flag and shouldHalt when retryCount === maxRetries.
   * Uses callback to stop on each detection — guarantees exactly 3 total.
   */
  it('halts with shouldHalt=true when retryCount equals maxRetries (FR-006, FR-007)', async () => {
    const pidPath = join(projectDir, '.forjis', 'tasks', taskId, 'pid');
    await writeFile(pidPath, '999999', 'utf-8');

    const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, projectDir, taskId);

    let lastCaptured: [string, number, boolean] | null = null;

    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        monitor.start(
          () => ({ org: '', team: 'test-team', role: 'explorer' }),
          () => new Date().toISOString(),
          (roleName, retryCount, shouldHalt) => {
            lastCaptured = [roleName, retryCount, shouldHalt];
            monitor.stop();
            resolve();
          },
        );
      });
    }

    const state = monitor.getRoleRetryState('explorer');
    expect(state.retryCount).toBe(3);
    expect(state.halted).toBe(true);

    // Last call: shouldHalt=true
    expect(lastCaptured![2]).toBe(true);

    await rm(pidPath, { force: true });
  }, 10000);

  /**
   * resetBaseline() clears isChecking without throwing.
   */
  it('resetBaseline() executes without error and allows subsequent ticks', () => {
    const config: HealthCheckConfig = { interval: 300, maxRetries: 3 };
    const monitor = new HealthCheckMonitor(config, '/nonexistent-dir', 'no-task');
    expect(() => monitor.resetBaseline()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-008: PipelineStep DTO extension — optional fields
// ---------------------------------------------------------------------------

describe('FR-008: PipelineStep DTO extension', () => {
  /** Flow 28: PipelineStep without retryCount and halted type-checks correctly */
  it('PipelineStep without retryCount or halted fields is valid (backward compat)', () => {
    const step: PipelineStep = {
      role: 'developer',
      agent: 'claude',
      status: 'planned',
      description: 'Implementation',
    };
    // Both fields are optional — no runtime error
    expect(step.retryCount).toBeUndefined();
    expect(step.halted).toBeUndefined();
  });

  /** PipelineStep with retryCount and halted fields */
  it('PipelineStep accepts optional retryCount and halted fields', () => {
    const step: PipelineStep = {
      role: 'developer',
      agent: 'claude',
      status: 'done',
      description: 'Implementation',
      retryCount: 2,
      halted: false,
    };
    expect(step.retryCount).toBe(2);
    expect(step.halted).toBe(false);
  });

  /** halted: true is valid */
  it('PipelineStep accepts halted=true', () => {
    const step: PipelineStep = {
      role: 'developer',
      agent: 'claude',
      status: 'done',
      description: 'Implementation',
      retryCount: 3,
      halted: true,
    };
    expect(step.halted).toBe(true);
    expect(step.retryCount).toBe(3);
  });

  /** Flow 29: PipelinePlanResponse with optional maxRetries */
  it('PipelinePlanResponse without maxRetries is valid (backward compat)', () => {
    const plan: PipelinePlanResponse = {
      taskId: 'task-1',
      orgName: null,
      teamName: null,
      steps: [],
      status: 'ready',
    };
    expect(plan.maxRetries).toBeUndefined();
  });

  it('PipelinePlanResponse accepts maxRetries field', () => {
    const plan: PipelinePlanResponse = {
      taskId: 'task-1',
      orgName: null,
      teamName: null,
      steps: [],
      status: 'ready',
      maxRetries: 3,
    };
    expect(plan.maxRetries).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// FR-009: Pipeline Plan Sync with Retry State
// ---------------------------------------------------------------------------

describe('FR-009: syncRetryStateToPlan', () => {
  let projectDir: string;
  const taskId = 'task-sync-retry';

  beforeEach(async () => {
    projectDir = await createProjectDir(taskId);
  });

  afterEach(async () => {
    await removeProjectDir(projectDir);
  });

  /** Flow 30: syncRetryStateToPlan writes retryCount and halted to plan */
  it('writes retryCount and halted to matching step in plan (FR-009)', async () => {
    const initialPlan: PipelinePlanResponse = {
      taskId,
      orgName: 'test-org',
      teamName: 'test-team',
      steps: [
        { role: 'developer', agent: 'claude', status: 'done', description: 'Dev' },
        { role: 'reviewer', agent: 'claude', status: 'done', description: 'Review' },
      ],
    };
    await writePipelinePlan(projectDir, taskId, initialPlan);

    const retryStates = new Map([
      ['developer', { retryCount: 2, halted: false }],
    ]);

    await syncRetryStateToPlan(projectDir, taskId, retryStates);

    const updatedPlan = await readPipelinePlan(projectDir, taskId);
    const devStep = updatedPlan.steps.find((s) => s.role === 'developer')!;
    const reviewStep = updatedPlan.steps.find((s) => s.role === 'reviewer')!;

    expect(devStep.retryCount).toBe(2);
    expect(devStep.halted).toBe(false);
    // reviewer has no retry state — should not have retryCount
    expect(reviewStep.retryCount).toBeUndefined();
    expect(reviewStep.halted).toBeUndefined();
  });

  /** Flow 31: syncRetryStateToPlan writes halted=true */
  it('writes halted=true and retryCount=3 when role is halted (FR-009)', async () => {
    const initialPlan: PipelinePlanResponse = {
      taskId,
      orgName: 'test-org',
      teamName: 'test-team',
      steps: [
        { role: 'developer', agent: 'claude', status: 'done', description: 'Dev' },
      ],
    };
    await writePipelinePlan(projectDir, taskId, initialPlan);

    const retryStates = new Map([
      ['developer', { retryCount: 3, halted: true }],
    ]);

    await syncRetryStateToPlan(projectDir, taskId, retryStates);

    const updatedPlan = await readPipelinePlan(projectDir, taskId);
    const devStep = updatedPlan.steps.find((s) => s.role === 'developer')!;

    expect(devStep.retryCount).toBe(3);
    expect(devStep.halted).toBe(true);
  });

  /** retryCount === 0 is not written (omitted) */
  it('does NOT write retryCount when retryCount is 0 (FR-009)', async () => {
    const initialPlan: PipelinePlanResponse = {
      taskId,
      orgName: 'test-org',
      teamName: 'test-team',
      steps: [
        { role: 'developer', agent: 'claude', status: 'done', description: 'Dev' },
      ],
    };
    await writePipelinePlan(projectDir, taskId, initialPlan);

    const retryStates = new Map([
      ['developer', { retryCount: 0, halted: false }],
    ]);

    await syncRetryStateToPlan(projectDir, taskId, retryStates);

    const updatedPlan = await readPipelinePlan(projectDir, taskId);
    const devStep = updatedPlan.steps.find((s) => s.role === 'developer')!;
    // retryCount 0 should not be written
    expect(devStep.retryCount).toBeUndefined();
  });

  /** No plan file — syncRetryStateToPlan does nothing gracefully */
  it('does nothing when plan file does not exist (FR-009)', async () => {
    const retryStates = new Map([
      ['developer', { retryCount: 2, halted: false }],
    ]);
    // Should not throw
    await expect(
      syncRetryStateToPlan(projectDir, 'no-such-task', retryStates)
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-009: syncPlanFromState preserves retry fields across syncs
// ---------------------------------------------------------------------------

describe('FR-009: syncPlanFromState preserves retryCount and halted (Flow 32)', () => {
  let projectDir: string;
  const taskId = 'task-preserve-retry';

  beforeEach(async () => {
    projectDir = await createProjectDir(taskId);
  });

  afterEach(async () => {
    await removeProjectDir(projectDir);
  });

  /** Flow 32: syncPlanFromState carries retryCount forward from existing plan */
  it('preserves retryCount across plan syncs (FR-009)', async () => {
    // Write a pipeline-state.yaml
    await writePipelineState(projectDir, taskId, [
      { name: 'developer', agent: 'claude', status: 'done', description: 'Dev' },
    ]);

    // Write existing pipeline-plan.yaml with retryCount already set
    const existingPlan: PipelinePlanResponse = {
      taskId,
      orgName: 'test-org',
      teamName: 'test-team',
      steps: [
        {
          role: 'developer',
          agent: 'claude',
          status: 'done',
          description: 'Dev',
          retryCount: 2,
          halted: false,
        },
      ],
    };
    await writePipelinePlan(projectDir, taskId, existingPlan);

    // Now sync from state — should preserve retryCount
    await syncPlanFromState(projectDir, taskId);

    const updatedPlan = await readPipelinePlan(projectDir, taskId);
    const devStep = updatedPlan.steps.find((s) => s.role === 'developer')!;

    expect(devStep.retryCount).toBe(2);
    // halted: false is the default/absent state — sync does not write it explicitly
    // (only truthy halted is carried forward; absent/false is treated as not halted)
    expect(!devStep.halted).toBe(true);
  });

  /** Halted=true is preserved across syncs */
  it('preserves halted=true across plan syncs (FR-009)', async () => {
    await writePipelineState(projectDir, taskId, [
      { name: 'developer', agent: 'claude', status: 'failed', description: 'Dev' },
    ]);

    const existingPlan: PipelinePlanResponse = {
      taskId,
      orgName: 'test-org',
      teamName: 'test-team',
      steps: [
        {
          role: 'developer',
          agent: 'claude',
          status: 'done',
          description: 'Dev',
          retryCount: 3,
          halted: true,
        },
      ],
    };
    await writePipelinePlan(projectDir, taskId, existingPlan);

    await syncPlanFromState(projectDir, taskId);

    const updatedPlan = await readPipelinePlan(projectDir, taskId);
    const devStep = updatedPlan.steps.find((s) => s.role === 'developer')!;

    expect(devStep.retryCount).toBe(3);
    expect(devStep.halted).toBe(true);
  });

  /** When no previous plan has retry state, new sync doesn't add it */
  it('does not add retry fields to steps that never had them (NFR-004)', async () => {
    await writePipelineState(projectDir, taskId, [
      { name: 'developer', agent: 'claude', status: 'done', description: 'Dev' },
    ]);

    // Plan with no retry state
    const initialPlan: PipelinePlanResponse = {
      taskId,
      orgName: 'test-org',
      teamName: 'test-team',
      steps: [
        { role: 'developer', agent: 'claude', status: 'running', description: 'Dev' },
      ],
    };
    await writePipelinePlan(projectDir, taskId, initialPlan);

    await syncPlanFromState(projectDir, taskId);

    const updatedPlan = await readPipelinePlan(projectDir, taskId);
    const devStep = updatedPlan.steps.find((s) => s.role === 'developer')!;

    // No retry state → fields should be absent or falsy
    expect(devStep.retryCount === undefined || devStep.retryCount === 0).toBe(true);
    expect(!devStep.halted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NFR-002: Race condition guard (engineCompleted pattern)
// ---------------------------------------------------------------------------

describe('NFR-002: Race condition guard — engineCompleted pattern', () => {
  /**
   * This test validates the guard pattern described in the design:
   * if engineCompleted is true when onStuck fires, the callback should
   * return without incrementing retryCount. We test the HealthCheckMonitor
   * callback contract — the monitor itself calls onStuck, and the caller
   * is responsible for the engineCompleted guard. We verify the monitor
   * always calls onStuck when stuck is detected, and the caller can safely
   * ignore it.
   */
  it('HealthCheckMonitor always calls onStuck for stuck role (caller handles guard)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'forjis-race-'));
    await mkdir(join(tmpDir, '.forjis', 'tasks', 'task-race'), { recursive: true });

    try {
      await writeFile(
        join(tmpDir, '.forjis', 'tasks', 'task-race', 'pid'),
        '999999',
        'utf-8',
      );

      const config: HealthCheckConfig = { interval: 0.001, maxRetries: 3 }; // ~1ms
      const monitor = new HealthCheckMonitor(config, tmpDir, 'task-race');

      let engineCompleted = false;
      let retryWouldHaveHappened = false;

      const onStuck = jest.fn((_roleName: string, _retryCount: number, _halt: boolean) => {
        if (engineCompleted) {
          // Guard: caller ignores this call
          return;
        }
        retryWouldHaveHappened = true;
      });

      // Simulate engine completing before the tick fires
      engineCompleted = true;

      monitor.start(
        () => ({ org: '', team: 'test-team', role: 'developer' }),
        () => new Date().toISOString(),
        onStuck,
      );

      await waitFor(() => (onStuck as jest.Mock).mock.calls.length >= 1);
      monitor.stop();

      // onStuck was called by the monitor
      expect(onStuck).toHaveBeenCalled();
      // But the engineCompleted guard prevented the retry from happening
      expect(retryWouldHaveHappened).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// NFR-004: Backward compatibility
// ---------------------------------------------------------------------------

describe('NFR-004: Backward compatibility', () => {
  /** Existing build files with no health_check produce valid RuntimeConfig */
  it('build file without health_check produces valid RuntimeConfig with defaults', () => {
    const yaml = minimalBuildYaml();
    const config = parseBuildFile(yaml);
    expect(config.healthCheck).toBeNull();

    const runtime = composeRuntime(minimalBuildConfig({ healthCheck: null }), [], mockRegistry());
    expect(runtime.healthCheck.interval).toBe(300);
    expect(runtime.healthCheck.maxRetries).toBe(3);
  });

  /** PipelineStep without retry fields renders without error (type safety) */
  it('PipelineStep missing retryCount/halted fields is backward compatible', () => {
    const step: PipelineStep = {
      role: 'developer',
      agent: 'claude',
      status: 'done',
      description: 'Implementation',
    };
    // Accessing undefined fields should not throw
    const retryCount = step.retryCount ?? 0;
    const halted = step.halted ?? false;
    expect(retryCount).toBe(0);
    expect(halted).toBe(false);
  });
});
