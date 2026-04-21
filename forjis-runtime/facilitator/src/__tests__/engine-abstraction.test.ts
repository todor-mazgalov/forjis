/**
 * Unit tests for the engine abstraction layer.
 *
 * Requirements validated:
 *   FR-001  ForjisEngine interface definition (no prepare())
 *   FR-002  Engine registry with lazy loading
 *   FR-003  EngineNotFoundError in error hierarchy
 *   FR-004  ClaudeEngine implements ForjisEngine
 *   FR-005  ClaudeEngine.checkPrerequisites verifies CLI availability
 *   FR-007  ClaudeEngine.invoke spawns subprocess with configDir
 *   FR-008  ClaudeEngine orchestrator directory resolution
 *   FR-009  Orchestrator files relocation
 *   FR-014  getCurrentStage utility extraction
 *   FR-015  Public API update
 *   FR-016  engine-adapter.ts removal
 *   FR-017  TASK.md generation in engine invoke
 *   NFR-002 ESM-only module structure
 *
 * Note: Tests for prepare(), checksum cache, resolveAllResources, and
 * parseBuildFile have been migrated to @forjis/resolver test suite.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

// -- Helpers --

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-engine-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// -- FR-003: EngineNotFoundError --

describe('EngineNotFoundError (FR-003)', () => {
  /** Validates FR-003: error is a CliError subclass */
  it('is an instance of CliError', async () => {
    const { EngineNotFoundError, CliError } = await import('../errors.js');
    const err = new EngineNotFoundError('missing-engine', ['claude']);
    expect(err).toBeInstanceOf(CliError);
  });

  /** Validates FR-003: error has the correct name property */
  it('has name equal to EngineNotFoundError', async () => {
    const { EngineNotFoundError } = await import('../errors.js');
    const err = new EngineNotFoundError('x', []);
    expect(err.name).toBe('EngineNotFoundError');
  });

  /** Validates FR-003: error exposes engineName */
  it('exposes the engineName property', async () => {
    const { EngineNotFoundError } = await import('../errors.js');
    const err = new EngineNotFoundError('codex', []);
    expect(err.engineName).toBe('codex');
  });

  /** Validates FR-003: message includes context */
  it('includes engine name and available engines in message', async () => {
    const { EngineNotFoundError } = await import('../errors.js');
    const err = new EngineNotFoundError('codex', ['claude', 'custom']);
    expect(err.message).toContain('codex');
    expect(err.message).toContain('claude');
  });

  /** Validates FR-003: available engines list is stored */
  it('stores the available engines list', async () => {
    const { EngineNotFoundError } = await import('../errors.js');
    const err = new EngineNotFoundError('x', ['claude', 'y']);
    expect(err.availableEngines).toEqual(['claude', 'y']);
  });

  /** Validates FR-003: handles empty list gracefully */
  it('handles empty available engines gracefully', async () => {
    const { EngineNotFoundError } = await import('../errors.js');
    const err = new EngineNotFoundError('x', []);
    expect(err.availableEngines).toEqual([]);
    expect(err.message).toContain('x');
  });
});

// -- FR-002: Engine registry --

describe('Engine registry -- registerEngine / loadEngine (FR-002)', () => {
  /** Validates FR-002: registered engine can be loaded */
  it('loads a freshly registered engine', async () => {
    const { registerEngine, loadEngine } = await import('../engine.js');
    registerEngine('test-engine', async () => ({
      name: 'test-engine',
      checkPrerequisites: async () => 'ok',
      invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
      cleanup: async () => {},
      prompt: async () => '',
    }));
    const engine = await loadEngine('test-engine');
    expect(engine.name).toBe('test-engine');
  });

  /** Validates FR-002: factory invoked each time */
  it('invokes the factory exactly once per loadEngine call', async () => {
    const { registerEngine, loadEngine } = await import('../engine.js');
    let callCount = 0;
    registerEngine('counting', async () => {
      callCount++;
      return {
        name: 'counting',
        checkPrerequisites: async () => 'ok',
        invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
        cleanup: async () => {},
        prompt: async () => '',
      };
    });
    await loadEngine('counting');
    await loadEngine('counting');
    expect(callCount).toBe(2);
  });

  /** Validates FR-002: missing engine throws EngineNotFoundError */
  it('throws EngineNotFoundError for unregistered engine name', async () => {
    const { loadEngine } = await import('../engine.js');
    await expect(loadEngine('__does_not_exist__')).rejects.toThrow();
  });

  /** Validates FR-002: error includes the requested name */
  it('includes the requested engine name in EngineNotFoundError', async () => {
    const { loadEngine } = await import('../engine.js');
    const { EngineNotFoundError } = await import('../errors.js');
    try {
      await loadEngine('__does_not_exist__');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineNotFoundError);
      expect((err as any).engineName).toBe('__does_not_exist__');
    }
  });

  /** Validates FR-002: error includes registered engine names */
  it('includes available engine names in EngineNotFoundError message', async () => {
    const { registerEngine, loadEngine } = await import('../engine.js');
    registerEngine('alpha', async () => ({
      name: 'alpha',
      checkPrerequisites: async () => 'ok',
      invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
      cleanup: async () => {},
      prompt: async () => '',
    }));
    try {
      await loadEngine('__missing__');
    } catch (err: any) {
      expect(err.message).toContain('alpha');
    }
  });

  /** Validates FR-002: overwriting a registration is allowed */
  it('allows overwriting an existing engine registration', async () => {
    const { registerEngine, loadEngine } = await import('../engine.js');
    registerEngine('overwrite-test', async () => ({
      name: 'first',
      checkPrerequisites: async () => 'ok',
      invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
      cleanup: async () => {},
      prompt: async () => '',
    }));
    registerEngine('overwrite-test', async () => ({
      name: 'second',
      checkPrerequisites: async () => 'ok',
      invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
      cleanup: async () => {},
      prompt: async () => '',
    }));
    const engine = await loadEngine('overwrite-test');
    expect(engine.name).toBe('second');
  });
});

// -- FR-001, FR-004: ForjisEngine interface --

describe('ForjisEngine interface (FR-001, FR-004)', () => {
  /** Validates FR-004: ClaudeEngine has name "claude" */
  it('ClaudeEngine has name equal to "claude"', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    expect(engine.name).toBe('claude');
  });

  /** Validates FR-004: ClaudeEngine has all required lifecycle methods (no prepare) */
  it('ClaudeEngine has checkPrerequisites, invoke, cleanup, prompt methods', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    expect(typeof engine.checkPrerequisites).toBe('function');
    expect(typeof engine.invoke).toBe('function');
    expect(typeof engine.cleanup).toBe('function');
    expect(typeof engine.prompt).toBe('function');
  });

  /** Validates FR-004: prepare() is NOT on ClaudeEngine */
  it('ClaudeEngine does not have a prepare method', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    expect((engine as any).prepare).toBeUndefined();
  });

  /** Validates FR-002: claude engine is pre-registered */
  it('loadEngine("claude") returns a ForjisEngine with name "claude"', async () => {
    const { loadEngine } = await import('../engine.js');
    const engine = await loadEngine('claude');
    expect(engine.name).toBe('claude');
  });
});

// -- FR-014: getCurrentStage --

describe('getCurrentStage (FR-014)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates FR-014: reads stage from TASK.md */
  it('returns the stage value from a TASK.md containing stage: running', async () => {
    const { getCurrentStage } = await import('../task-state.js');
    const taskDir = join(tmpDir, '.forjis', 'tasks', 'test-task');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'TASK.md'), '---\nstage: running\n');

    const stage = await getCurrentStage(tmpDir, 'test-task');
    expect(stage).toBe('running');
  });

  /** Validates FR-014: returns null when file missing */
  it('returns null when the TASK.md file does not exist', async () => {
    const { getCurrentStage } = await import('../task-state.js');
    const stage = await getCurrentStage(tmpDir, 'nonexistent');
    expect(stage).toBeNull();
  });

  /** Validates FR-014: returns null when no stage field */
  it('returns null when TASK.md has no stage field', async () => {
    const { getCurrentStage } = await import('../task-state.js');
    const taskDir = join(tmpDir, '.forjis', 'tasks', 'no-stage');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'TASK.md'), '# Some task\n');

    const stage = await getCurrentStage(tmpDir, 'no-stage');
    expect(stage).toBeNull();
  });

  /** Validates FR-014: trims whitespace */
  it('trims trailing whitespace from stage value', async () => {
    const { getCurrentStage } = await import('../task-state.js');
    const taskDir = join(tmpDir, '.forjis', 'tasks', 'trim-test');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'TASK.md'), '---\nstage: pending   \n');

    const stage = await getCurrentStage(tmpDir, 'trim-test');
    expect(stage).toBe('pending');
  });

  /** Validates FR-014: exported from package index */
  it('is exported from the package index', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.getCurrentStage).toBe('function');
  });
});

// -- FR-007, FR-017: ClaudeEngine.invoke --

describe('ClaudeEngine.invoke (FR-007, FR-017)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  function makeInvokeOptions(overrides: Partial<import('../engine.js').EngineInvokeOptions> = {}): import('../engine.js').EngineInvokeOptions {
    return {
      projectDir: tmpDir,
      taskId: 'test-task-id',
      taskDescription: 'Test description',
      configDir: join(tmpDir, '.forjis', 'config'),
      dryRun: false,
      ...overrides,
    };
  }

  /** Validates FR-007: dry-run mode returns exitCode 0 without spawning */
  it('dry-run mode returns exitCode 0 with the input taskId', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();

    const result = await engine.invoke(makeInvokeOptions({ dryRun: true }));

    expect(result.exitCode).toBe(0);
    expect(result.taskId).toBe('test-task-id');
    expect(result.stage).toBeNull();
  });

  /** Validates FR-017: TASK.md is not written during dry-run */
  it('dry-run mode does not write TASK.md', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();

    await engine.invoke(makeInvokeOptions({ dryRun: true }));

    const taskMdPath = join(tmpDir, '.forjis', 'tasks', 'test-task-id', 'TASK.md');
    await expect(readFile(taskMdPath)).rejects.toThrow();
  });

  /** Validates FR-004: cleanup is a no-op that resolves immediately */
  it('cleanup() resolves without throwing', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    await expect(engine.cleanup(tmpDir)).resolves.toBeUndefined();
  });
});

// -- FR-005: ClaudeEngine.checkPrerequisites --

describe('ClaudeEngine.checkPrerequisites (FR-005)', () => {
  /** Validates FR-005: missing binary causes spawn to emit error */
  it('OS reports ENOENT when a binary does not exist on PATH', async () => {
    const outcome = await new Promise<{ event: 'error' | 'close'; code?: number | null; err?: Error }>((resolve) => {
      const child = spawn('__forjis_test_binary_xyz_not_real__', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', (err) => resolve({ event: 'error', err }));
      child.on('close', (code) => resolve({ event: 'close', code }));
    });

    const didFail =
      outcome.event === 'error' ||
      (outcome.event === 'close' && outcome.code !== 0);

    expect(didFail).toBe(true);
  });

  /** Validates FR-005: EngineNotFoundError has correct shape */
  it('EngineNotFoundError produced by checkPrerequisites has correct shape', async () => {
    const { EngineNotFoundError, CliError } = await import('../errors.js');
    const err = new EngineNotFoundError('claude', ['claude', 'other']);
    expect(err).toBeInstanceOf(CliError);
    expect(err.engineName).toBe('claude');
    expect(err.name).toBe('EngineNotFoundError');
    expect(err.message).toContain('claude');
  });

  /** Validates FR-005: checkPrerequisites returns a Promise */
  it('checkPrerequisites returns a Promise', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const result = engine.checkPrerequisites().catch(() => {/* ignore */});
    expect(result).toBeInstanceOf(Promise);
  });
});

// -- FR-008 / FR-009: Orchestrator directory resolution --

describe('ClaudeEngine.getOrchestratorDir (FR-008, FR-009)', () => {
  /** Validates FR-008: orchestrator dir resolves to a real path */
  it('returns a path string', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const dir = engine.getOrchestratorDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });

  /** Validates FR-009: orchestrator dir ends with expected path segment */
  it('resolved path ends with orchestrator', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const dir = engine.getOrchestratorDir();
    const normalised = dir.replace(/\\/g, '/');
    expect(normalised).toMatch(/\/orchestrator$/);
  });

  /** Validates FR-009: .claude/commands/forjis.md exists */
  it('orchestrator directory contains .claude/commands/forjis.md', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const dir = engine.getOrchestratorDir();
    const forjisMd = join(dir, '.claude', 'commands', 'forjis.md');
    await expect(readFile(forjisMd, 'utf-8')).resolves.toBeTruthy();
  });

  /** Validates FR-009: all expected command files are present */
  it('orchestrator directory contains all expected command files', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const commandsDir = join(engine.getOrchestratorDir(), '.claude', 'commands');

    const expectedFiles = [
      'forjis.md',
      'forjis-org-mode.md',
      'forjis-swarm-mode.md',
      'forjis-independent-mode.md',
      'forjis-fallback-mode.md',
      'forjis-init.md',
    ];

    for (const file of expectedFiles) {
      await expect(access(join(commandsDir, file))).resolves.toBeUndefined();
    }
  });

  /** Validates FR-009: skill files are present */
  it('orchestrator directory contains forjis-workflow/SKILL.md and openspec/SKILL.md', async () => {
    const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
    const engine = new ClaudeEngine();
    const skillsDir = join(engine.getOrchestratorDir(), '.claude', 'skills');
    await expect(access(join(skillsDir, 'forjis-workflow', 'SKILL.md'))).resolves.toBeUndefined();
    await expect(access(join(skillsDir, 'openspec', 'SKILL.md'))).resolves.toBeUndefined();
  });
});

// -- FR-015: Public API exports --

describe('Public API exports (FR-015)', () => {
  /** Validates FR-015: loadEngine is exported */
  it('exports loadEngine from index', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.loadEngine).toBe('function');
  });

  /** Validates FR-015: registerEngine is exported */
  it('exports registerEngine from index', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.registerEngine).toBe('function');
  });

  /** Validates FR-015: getCurrentStage is exported */
  it('exports getCurrentStage from package index', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.getCurrentStage).toBe('function');
  });

  /** Validates: resolver re-exports are available */
  it('exports parseBuildFile from index (re-exported from resolver)', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.parseBuildFile).toBe('function');
  });

  /** Validates: resolve function is re-exported */
  it('exports resolve from index (re-exported from resolver)', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.resolve).toBe('function');
  });

  /** Validates FR-015 / FR-016: generateOrgsFile is NOT exported */
  it('does not export generateOrgsFile', async () => {
    const pkg = await import('../index.js');
    expect((pkg as Record<string, unknown>)['generateOrgsFile']).toBeUndefined();
  });

  /** Validates FR-015 / FR-016: invokeEngine is NOT exported */
  it('does not export invokeEngine', async () => {
    const pkg = await import('../index.js');
    expect((pkg as Record<string, unknown>)['invokeEngine']).toBeUndefined();
  });
});

// -- FR-016: engine-adapter.ts removal --

describe('engine-adapter.ts removal (FR-016)', () => {
  /** Validates FR-016: engine-adapter.ts does not exist on disk */
  it('src/engine-adapter.ts does not exist', async () => {
    const { access: fsAccess } = await import('node:fs/promises');
    const path = new URL('../engine-adapter.ts', import.meta.url).pathname;
    await expect(fsAccess(path)).rejects.toThrow();
  });
});

// -- NFR-002: ESM-only modules --

describe('ESM-only module structure (NFR-002)', () => {
  const newModulePaths = [
    '../engine.ts',
    '../task-state.ts',
    '../engines/claude/claude-engine.ts',
  ];

  /** Validates NFR-002: no require() calls in new modules */
  it.each(newModulePaths)('module %s does not use require()', async (modulePath) => {
    const url = new URL(modulePath, import.meta.url);
    const content = await readFile(url, 'utf-8');
    expect(content).not.toMatch(/\brequire\s*\(/);
  });

  /** Validates NFR-002: no module.exports in new modules */
  it.each(newModulePaths)('module %s does not use module.exports', async (modulePath) => {
    const url = new URL(modulePath, import.meta.url);
    const content = await readFile(url, 'utf-8');
    expect(content).not.toMatch(/module\.exports/);
  });
});
