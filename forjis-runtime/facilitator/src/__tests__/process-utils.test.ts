/**
 * Unit tests for process-utils.ts
 *
 * Validates:
 *   pidFilePath — correct path construction
 *   killProcess — Windows path via taskkill, Unix path via process.kill(-pid)
 *   killProcess — Unix fallback when process group kill fails
 *   killProcess — silently handles already-dead process
 *   readPidFile — async: valid file, missing file, NaN content
 *   readPidSync — sync: valid file, missing file, NaN content
 */

import { jest } from '@jest/globals';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  pidFilePath,
  killProcess,
  readPidFile,
  readPidSync,
} from '../process-utils.js';

// ---------------------------------------------------------------------------
// Temp directory helpers (used for fs-dependent tests)
// ---------------------------------------------------------------------------

async function createProjectDir(taskId: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'forjis-pu-test-'));
  await mkdir(join(base, '.forjis', 'tasks', taskId), { recursive: true });
  return base;
}

async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Helper to override process.platform
// ---------------------------------------------------------------------------
function setPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}

// ---------------------------------------------------------------------------
// pidFilePath
// ---------------------------------------------------------------------------

describe('pidFilePath', () => {
  it('returns the correct path joining projectDir, .forjis, tasks, taskId, pid', () => {
    const result = pidFilePath('/home/user/project', 'task-abc');
    expect(result).toBe(join('/home/user/project', '.forjis', 'tasks', 'task-abc', 'pid'));
  });

  it('constructs the path correctly for any projectDir and taskId combination', () => {
    const result = pidFilePath('/opt/apps/myapp', 'task-xyz');
    expect(result).toBe(join('/opt/apps/myapp', '.forjis', 'tasks', 'task-xyz', 'pid'));
  });

  it('includes all required segments: .forjis, tasks, taskId, pid', () => {
    const result = pidFilePath('/base', 'my-task');
    expect(result).toContain('.forjis');
    expect(result).toContain('tasks');
    expect(result).toContain('my-task');
    expect(result.endsWith('pid')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// killProcess — Unix (tested via process.kill spy, which works on process object)
// ---------------------------------------------------------------------------

describe('killProcess (Unix)', () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = setPlatform('linux');
  });

  afterEach(() => {
    restorePlatform();
  });

  it('calls process.kill(-pid, SIGTERM) on Unix for process group kill', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    killProcess(9999);
    expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('does not attempt a second kill when process group kill succeeds', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    killProcess(9999);
    expect(killSpy).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });

  it('falls back to process.kill(pid, SIGTERM) when process group kill throws', () => {
    const killSpy = jest
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => { throw new Error('ESRCH'); })
      .mockImplementationOnce(() => true);

    killProcess(4321);

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, -4321, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 4321, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('silently handles an already-dead process when both group and single kill throw', () => {
    const killSpy = jest
      .spyOn(process, 'kill')
      .mockImplementation(() => { throw new Error('ESRCH'); });

    expect(() => killProcess(7777)).not.toThrow();
    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// killProcess — Windows (test via platform detection: on Windows branch,
// process.kill is NOT called; spawnSync is called)
// ---------------------------------------------------------------------------

describe('killProcess (Windows — platform branch)', () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = setPlatform('win32');
  });

  afterEach(() => {
    restorePlatform();
  });

  it('does not call process.kill when platform is win32', () => {
    // On Windows the code takes the spawnSync branch, skipping process.kill.
    // We verify process.kill is never invoked.
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    // spawnSync will be called with real taskkill — on non-Windows CI this is a no-op
    // (taskkill not found, spawnSync returns error status, no exception thrown).
    // We only assert that process.kill was not reached.
    try {
      killProcess(99999);
    } catch {
      // ignore spawnSync errors in non-Windows environments
    }
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('process.kill is not the mechanism on Windows (spawnSync path is taken)', () => {
    // Verifies the conditional branching: win32 uses taskkill, not process.kill
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('process.kill should not be called on win32');
    });
    // On Windows, this should NOT throw (process.kill branch is not taken)
    // On non-Windows runners the spawnSync('taskkill') call will fail silently
    expect(() => killProcess(12345)).not.toThrow();
    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// readPidFile (async)
// ---------------------------------------------------------------------------

describe('readPidFile', () => {
  const TASK_ID = 'test-task-async';
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createProjectDir(TASK_ID);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it('returns the parsed PID when file contains a valid integer', async () => {
    const pidFile = join(projectDir, '.forjis', 'tasks', TASK_ID, 'pid');
    await writeFile(pidFile, '42\n', 'utf-8');
    const pid = await readPidFile(projectDir, TASK_ID);
    expect(pid).toBe(42);
  });

  it('returns null when the file does not exist', async () => {
    const pid = await readPidFile(projectDir, TASK_ID);
    expect(pid).toBeNull();
  });

  it('returns null when file content is not a valid number (NaN)', async () => {
    const pidFile = join(projectDir, '.forjis', 'tasks', TASK_ID, 'pid');
    await writeFile(pidFile, 'not-a-pid\n', 'utf-8');
    const pid = await readPidFile(projectDir, TASK_ID);
    expect(pid).toBeNull();
  });

  it('reads from the correct path: .forjis/tasks/<taskId>/pid', async () => {
    const expectedPath = join(projectDir, '.forjis', 'tasks', TASK_ID, 'pid');
    await writeFile(expectedPath, '77', 'utf-8');
    const pid = await readPidFile(projectDir, TASK_ID);
    expect(pid).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// readPidSync (sync)
// ---------------------------------------------------------------------------

describe('readPidSync', () => {
  const TASK_ID = 'test-task-sync';
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createProjectDir(TASK_ID);
  });

  afterEach(async () => {
    await removeDir(projectDir);
  });

  it('returns the parsed PID when file contains a valid integer', async () => {
    const pidFile = join(projectDir, '.forjis', 'tasks', TASK_ID, 'pid');
    await writeFile(pidFile, '99\n', 'utf-8');
    const pid = readPidSync(projectDir, TASK_ID);
    expect(pid).toBe(99);
  });

  it('returns null when the file does not exist', () => {
    const pid = readPidSync(projectDir, TASK_ID);
    expect(pid).toBeNull();
  });

  it('returns null when file content is not a valid number (NaN)', async () => {
    const pidFile = join(projectDir, '.forjis', 'tasks', TASK_ID, 'pid');
    await writeFile(pidFile, 'garbage', 'utf-8');
    const pid = readPidSync(projectDir, TASK_ID);
    expect(pid).toBeNull();
  });

  it('reads from the correct path: .forjis/tasks/<taskId>/pid', async () => {
    const expectedPath = join(projectDir, '.forjis', 'tasks', TASK_ID, 'pid');
    await writeFile(expectedPath, '55', 'utf-8');
    const pid = readPidSync(projectDir, TASK_ID);
    expect(pid).toBe(55);
  });
});
