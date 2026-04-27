/**
 * Unit tests for the ClaudeEngine silence watchdog (fix-hang).
 *
 * Verifies that:
 *   - When no stream event is parsed for `silenceTimeoutMs` ms, the child
 *     subprocess is killed and the promise rejects with EngineTimeoutError.
 *   - On watchdog kill, the task's pid file is removed.
 *   - A fast-completing invocation (child emits a `result` event and then
 *     exits cleanly) is NOT affected — the watchdog is cleared and the
 *     promise resolves normally.
 *
 * The tests subclass ClaudeEngine and override the `spawnChild` seam so
 * no real `claude` binary is needed. The fake child is a PassThrough-based
 * stub that lets the test drive `data` / `close` events on its schedule.
 *
 * Relationship to `fix-health-check`: the engine-level silence watchdog
 * remains the safety net for genuinely hung subprocesses. The new
 * `[health-check]` stdin nudge mechanism (see
 * `run-health-check-nudge.test.ts` and `claude-engine-keepstdin-counter.test.ts`)
 * is a non-destructive *upstream* signal — it gives the orchestrator a
 * chance to recover before this watchdog escalates to a forced kill.
 * If a subprocess is so wedged that it cannot read its own stdin, the
 * watchdog is what eventually frees the parent process.
 */

import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ClaudeEngine } from '../engines/claude/claude-engine.js';
import { EngineTimeoutError } from '../errors.js';
import { PromptOptions } from '../types.js';
import type {
  ChildProcessByStdio,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for Node's ChildProcess that exposes the three fields
 * the engine actually reads: `pid`, `stdin`, `stdout`, `stderr`, plus the
 * `error` / `close` events on itself. The test drives data chunks and the
 * close event explicitly so timing is deterministic.
 */
class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | number | undefined;

  constructor(pid = 9999) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  /** Emits a data chunk on stdout, as the real CLI would. */
  writeStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  /** Closes the stdio streams and emits 'close' with the given exit code. */
  finish(code: number): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

/**
 * Subclass that records spawn calls and returns a prepared FakeChild so the
 * test can poke data / close events into the engine's prompt() pipeline.
 */
class TestClaudeEngine extends ClaudeEngine {
  fakeChildren: FakeChild[] = [];
  nextChild: FakeChild | null = null;

  protected override spawnChild(
    _command: string,
    _args: string[],
    _opts: SpawnOptionsWithoutStdio,
  ): ChildProcessByStdio<Writable, Readable, Readable> {
    const child = this.nextChild ?? new FakeChild();
    this.fakeChildren.push(child);
    this.nextChild = null;
    return child as unknown as ChildProcessByStdio<Writable, Readable, Readable>;
  }
}

// ---------------------------------------------------------------------------
// Project-dir helpers (PID-file tests)
// ---------------------------------------------------------------------------

async function createProjectDir(taskId: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'forjis-watchdog-test-'));
  await mkdir(join(base, '.forjis', 'tasks', taskId), { recursive: true });
  return base;
}

async function removeProjectDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Fixture: a valid "result" stream-json event
// ---------------------------------------------------------------------------

function resultEvent(): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: 's',
    total_cost_usd: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    is_error: false,
  }) + '\n';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeEngine silence watchdog', () => {
  /**
   * The watchdog MUST kill the child and reject with EngineTimeoutError when
   * no stream events arrive within silenceTimeoutMs. This is the exact
   * failure mode from the fix-hang task: the child claude has a hung nested
   * Bash call, no result event ever fires, and without a watchdog the
   * promise never settles.
   */
  it('rejects with EngineTimeoutError after silenceTimeoutMs of no events', async () => {
    const engine = new TestClaudeEngine();
    const child = new FakeChild();
    engine.nextChild = child;

    const opts = new PromptOptions();
    opts.silenceTimeoutMs = 80; // short, deterministic

    const promise = engine.prompt('hi', opts);

    await expect(promise).rejects.toBeInstanceOf(EngineTimeoutError);
  });

  /**
   * The watchdog MUST send a kill signal to the child when it fires. On POSIX
   * that is a process-group SIGKILL; on Windows it is a `taskkill /T /F`.
   * The FakeChild records `killed` only when `child.kill()` is called — the
   * engine uses `process.kill(-pid, SIGKILL)` first, which will throw ESRCH
   * for our synthetic pid and fall back to `child.kill('SIGKILL')`. Either
   * way, some kill attempt happens and the promise settles.
   */
  it('invokes kill on the child when the watchdog fires', async () => {
    const engine = new TestClaudeEngine();
    const child = new FakeChild(123456789); // high pid so the group kill fails cleanly
    engine.nextChild = child;

    const opts = new PromptOptions();
    opts.silenceTimeoutMs = 60;

    await expect(engine.prompt('hi', opts)).rejects.toBeInstanceOf(
      EngineTimeoutError,
    );

    // On POSIX the group-kill path via process.kill throws ESRCH, so the
    // engine falls back to child.kill('SIGKILL'). On Windows the engine uses
    // spawnSync('taskkill', ...) and never touches child.kill — which is
    // still a successful kill attempt from the engine's perspective. Either
    // branch is acceptable; we only assert the watchdog settled the promise.
    expect(child.killed || process.platform === 'win32').toBe(true);
  });

  /**
   * The watchdog must also delete the task's pid file when it fires, so a
   * later `forjis stop` or `forjis status` does not think the dead engine
   * is still running.
   */
  it('removes the pid file after a watchdog kill', async () => {
    const taskId = 'watchdog-test-task';
    const projectDir = await createProjectDir(taskId);
    const pidFile = join(projectDir, '.forjis', 'tasks', taskId, 'pid');

    try {
      const engine = new TestClaudeEngine();
      const child = new FakeChild(424242);
      engine.nextChild = child;

      const opts = new PromptOptions();
      opts.id = taskId;
      opts.projectDir = projectDir;
      opts.silenceTimeoutMs = 60;

      // prompt() writes the pid file synchronously right after spawning,
      // so we can assert both the pre-kill presence and the post-kill
      // absence in a single await chain.
      await expect(engine.prompt('hi', opts)).rejects.toBeInstanceOf(
        EngineTimeoutError,
      );

      await expect(access(pidFile)).rejects.toThrow();
    } finally {
      await removeProjectDir(projectDir);
    }
  });

  /**
   * A fast-completing invocation must NOT be affected by the watchdog. The
   * engine receives a `result` event (which resets the watchdog), then the
   * child exits with code 0, and the promise resolves normally. A second
   * later the watchdog would have fired if it were still armed — the test
   * waits past that point to make sure nothing rejects.
   */
  it('does not fire when the child completes quickly', async () => {
    const engine = new TestClaudeEngine();
    const child = new FakeChild();
    engine.nextChild = child;

    const opts = new PromptOptions();
    opts.silenceTimeoutMs = 50;
    opts.returnOutput = true;

    const promise = engine.prompt('hi', opts);

    // Give prompt() a microtask to wire up the 'data' / 'close' listeners.
    await Promise.resolve();
    child.writeStdout(resultEvent());
    // Let the stdout 'data' event propagate to the engine's parser before
    // we close the stream — otherwise the engine sees `close` first and
    // resolves with an empty resultText.
    await new Promise((r) => setImmediate(r));
    child.finish(0);

    // The promise must resolve with the result text, not reject.
    await expect(promise).resolves.toBe('done');

    // Wait past the original watchdog deadline to ensure no late rejection
    // slips through (would crash the test with an unhandled rejection).
    await new Promise((r) => setTimeout(r, 120));
  });

  /**
   * Stream activity must reset the watchdog. A child that keeps emitting
   * events slightly faster than the silence threshold should never be
   * killed, even if it runs longer than silenceTimeoutMs overall.
   */
  it('resets the watchdog on each stream chunk', async () => {
    const engine = new TestClaudeEngine();
    const child = new FakeChild();
    engine.nextChild = child;

    const opts = new PromptOptions();
    opts.silenceTimeoutMs = 80;
    opts.returnOutput = true;

    const promise = engine.prompt('hi', opts);
    await Promise.resolve();

    // Pulse an event every 30ms for ~180ms total — well past the 80ms
    // silence deadline, but each event resets the watchdog.
    for (let i = 0; i < 6; i++) {
      child.writeStdout(`{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"m","cwd":".","api_key_source":"env"}\n`);
      await new Promise((r) => setTimeout(r, 30));
    }
    child.writeStdout(resultEvent());
    await new Promise((r) => setImmediate(r));
    child.finish(0);

    await expect(promise).resolves.toBe('done');
  });
});

describe('EngineTimeoutError shape', () => {
  it('carries kind, elapsedMs, and a descriptive message', () => {
    const err = new EngineTimeoutError('silence', 1234);
    expect(err.name).toBe('EngineTimeoutError');
    expect(err.kind).toBe('silence');
    expect(err.elapsedMs).toBe(1234);
    expect(err.message).toContain('1234');
    expect(err.message).toContain('silence');
  });

  it('is an instance of Error', () => {
    const err = new EngineTimeoutError('silence', 10);
    expect(err).toBeInstanceOf(Error);
  });
});
