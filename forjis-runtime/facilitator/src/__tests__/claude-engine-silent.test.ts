/**
 * Unit tests for the `PromptOptions.silent` flag honoured by
 * {@link ClaudeEngine.prompt}.
 *
 * The flag suppresses the success-path
 * `[engine]: claude subprocess exited (code: <code>)` informational
 * log line so a parallel context-cache refresh does not flood the
 * operator's terminal with N interleaved per-call exit lines. The
 * default (undefined / false) preserves the historical behaviour for
 * every other engine consumer (`forjis run`, persona,
 * inspector-clarify).
 *
 * Approach mirrors `claude-engine-keep-stdin-open.test.ts`: subclass
 * the engine to swap in a {@link FakeChild} so we can fire the
 * `'close'` event ourselves and observe what `console.log` saw.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ChildProcessByStdio,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { jest } from '@jest/globals';

import { ClaudeEngine } from '../engines/claude/claude-engine.js';
import { PromptOptions } from '../types.js';

/** Minimal fake child supporting stdin/stdout/stderr + EventEmitter. */
class FakeChild extends EventEmitter {
  readonly pid = 9001;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

/** Subclass that swaps spawnChild for a FakeChild we can drive. */
class TestEngine extends ClaudeEngine {
  readonly fakeChild = new FakeChild();

  protected override spawnChild(
    _command: string,
    _args: string[],
    _opts: SpawnOptionsWithoutStdio,
  ): ChildProcessByStdio<Writable, Readable, Readable> {
    return this.fakeChild as unknown as ChildProcessByStdio<
      Writable,
      Readable,
      Readable
    >;
  }
}

/** Drain microtasks so attached listeners fire before assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ClaudeEngine.prompt silent flag', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('suppresses the per-call subprocess exit log line when silent=true', async () => {
    const engine = new TestEngine();
    const opts = new PromptOptions();
    opts.returnOutput = true;
    opts.silent = true;
    opts.silenceTimeoutMs = 0; // disable watchdog so it cannot fire first

    const promptPromise = engine.prompt('hello', opts);
    await settle();

    // Drive the success-path close: emit clean exit code 0.
    engine.fakeChild.emit('close', 0);
    await promptPromise;

    const matched = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes(
        '[engine]: claude subprocess exited (code: 0)',
      ),
    );
    expect(matched).toHaveLength(0);
  });

  it('emits the per-call subprocess exit log line when silent is unset (default)', async () => {
    const engine = new TestEngine();
    const opts = new PromptOptions();
    opts.returnOutput = true;
    opts.silenceTimeoutMs = 0;

    const promptPromise = engine.prompt('hello', opts);
    await settle();

    engine.fakeChild.emit('close', 0);
    await promptPromise;

    const matched = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes(
        '[engine]: claude subprocess exited (code: 0)',
      ),
    );
    expect(matched).toHaveLength(1);
  });
});
