/**
 * Unit tests for the `outstandingTurns` counter and stdin grace timer on
 * {@link import('../engines/claude/claude-engine.js').ClaudeEngine} (fix-health-check).
 *
 * The counter governs when the engine closes the subprocess's stdin under
 * `keepStdinOpen: true`. Behaviour under test:
 *   - The counter starts at 1 once the initial user turn has been written.
 *   - {@link import('../engines/claude/claude-engine.js').ClaudeEngine.onUserMessage}
 *     increments the counter immediately before its stdin write.
 *   - {@link import('../engines/claude/claude-engine.js').ClaudeEngine}
 *     decrements the counter on every parsed `result` event.
 *   - When the counter reaches 0 the engine schedules `child.stdin.end()`
 *     on a 2 s grace timer.
 *   - If a fresh turn arrives during the grace window the timer is
 *     cancelled and stdin stays open.
 *
 * The tests subclass {@link import('../engines/claude/claude-engine.js').ClaudeEngine}
 * to substitute a fake child via the `spawnChild` seam at
 * `claude-engine.ts:87-97`. No real `claude` binary is required.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ChildProcessByStdio,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { ClaudeEngine } from '../engines/claude/claude-engine.js';
import { InvocationContext, PromptOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Fake child process — exposes the three streams the engine touches plus a
// recording PassThrough on stdin so the test can inspect every byte the
// engine writes (initial prompt + injected user turns).
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for Node's ChildProcess used by the counter tests.
 * Records every stdin write, and exposes `endCount` so a test can assert
 * the number of times the engine closed stdin via `child.stdin.end()`.
 */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdin: PassThrough;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every chunk written to stdin in order. */
  readonly stdinWrites: string[] = [];
  /** Number of times the engine has called `stdin.end()`. */
  endCount = 0;

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinWrites.push(chunk.toString('utf-8'));
    });
    const originalEnd = this.stdin.end.bind(this.stdin);
    // Wrap end() so the test can count calls without losing the real
    // stream-end behaviour.
    this.stdin.end = ((...args: unknown[]) => {
      this.endCount += 1;
      // @ts-expect-error — forward args opaquely
      return originalEnd(...args);
    }) as PassThrough['end'];
  }

  kill(): boolean {
    return true;
  }

  /** Emits a stream-json `result` event on stdout. */
  emitResult(): void {
    this.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        session_id: 's',
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        is_error: false,
      }) + '\n',
    );
  }
}

/**
 * ClaudeEngine subclass that exposes the most recent invocation context so
 * the test can read `outstandingTurns` and `stdinGraceTimer` directly,
 * and hand-injects a single FakeChild via the `spawnChild` seam.
 */
class TestEngine extends ClaudeEngine {
  readonly fakeChild = new FakeChild();
  /** The InvocationContext attached to the most recent prompt() call. */
  observedCtx: InvocationContext | null = null;

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

/**
 * Builds a fresh InvocationContext shaped like the one ClaudeEngine.invoke
 * creates internally. The keepstdin-counter tests need to exercise prompt()
 * directly so they can pass options.ctx with a known initial value.
 */
function makeCtx(): InvocationContext {
  return {
    invocationInputTokens: 0,
    invocationOutputTokens: 0,
    invocationCostUsd: 0,
    roleTokens: new Map(),
    currentRole: null,
    lineBuffer: '',
    eventLog: [],
    toolIdToName: new Map(),
    outstandingTurns: 1,
  };
}

/** Drains microtasks so PassThrough writes propagate to the data listener. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ClaudeEngine outstandingTurns counter', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * The counter is initialised to 1 by the caller of prompt() (mirroring
   * what ClaudeEngine.invoke does). After the initial prompt write nothing
   * else has happened, so the counter must still read 1.
   */
  it('starts at 1 after the initial prompt write', async () => {
    const engine = new TestEngine();
    const ctx = makeCtx();
    const opts = new PromptOptions();
    opts.id = 'counter-init';
    opts.keepStdinOpen = true;
    opts.ctx = ctx;
    opts.silenceTimeoutMs = 0; // disable watchdog for these tests

    engine.prompt('hi', opts).catch(() => {
      /* prompt resolves only when the fake child closes — ignore */
    });

    await flush();

    expect(ctx.outstandingTurns).toBe(1);
    expect(engine.fakeChild.stdinWrites).toHaveLength(1);
  });

  /**
   * Each {@link ClaudeEngine.onUserMessage} call must increment the counter
   * before the stdin write so a `result` event arriving on the same tick
   * cannot drop it to 0 ahead of the new turn.
   */
  it('increments on each onUserMessage', async () => {
    const engine = new TestEngine();
    const ctx = makeCtx();
    const opts = new PromptOptions();
    opts.id = 'counter-increment';
    opts.keepStdinOpen = true;
    opts.ctx = ctx;
    opts.silenceTimeoutMs = 0;

    engine.prompt('hi', opts).catch(() => {});
    await flush();
    expect(ctx.outstandingTurns).toBe(1);

    await engine.onUserMessage('counter-increment', 'first nudge');
    expect(ctx.outstandingTurns).toBe(2);

    await engine.onUserMessage('counter-increment', 'second nudge');
    expect(ctx.outstandingTurns).toBe(3);
  });

  /**
   * Each parsed `result` event drops the counter by 1. Multiple results
   * (one per outstanding turn) bring it back to 0.
   */
  it('decrements on each parsed result event', async () => {
    const engine = new TestEngine();
    const ctx = makeCtx();
    const opts = new PromptOptions();
    opts.id = 'counter-decrement';
    opts.keepStdinOpen = true;
    opts.ctx = ctx;
    opts.silenceTimeoutMs = 0;

    engine.prompt('hi', opts).catch(() => {});
    await flush();
    await engine.onUserMessage('counter-decrement', 'extra');
    expect(ctx.outstandingTurns).toBe(2);

    engine.fakeChild.emitResult();
    await flush();
    expect(ctx.outstandingTurns).toBe(1);

    engine.fakeChild.emitResult();
    await flush();
    expect(ctx.outstandingTurns).toBe(0);
  });

  /**
   * When the counter hits 0 the engine schedules `child.stdin.end()` on a
   * 2 s grace timer. The end must not fire before the timer expires.
   */
  it('arms a 2 s grace timer that closes stdin when the counter reaches 0', async () => {
    const engine = new TestEngine();
    const ctx = makeCtx();
    const opts = new PromptOptions();
    opts.id = 'counter-grace';
    opts.keepStdinOpen = true;
    opts.ctx = ctx;
    opts.silenceTimeoutMs = 0;

    engine.prompt('hi', opts).catch(() => {});
    await flush();

    // Final result arrives → counter hits 0 → grace timer arms.
    engine.fakeChild.emitResult();
    await flush();
    expect(ctx.outstandingTurns).toBe(0);
    expect(ctx.stdinGraceTimer).toBeDefined();
    expect(engine.fakeChild.endCount).toBe(0);

    // Tick well past the 2 s window — the engine must close stdin.
    jest.advanceTimersByTime(2100);
    await flush();
    expect(engine.fakeChild.endCount).toBe(1);
  });

  /**
   * If a new turn arrives via {@link ClaudeEngine.onUserMessage} during the
   * 2 s grace window, the timer must be cancelled and stdin must stay
   * open. This is the race-mitigation path: a nudge queued at the same
   * instant the previous turn's `result` event is parsed must reach the
   * subprocess.
   */
  it('cancels the grace timer when a new turn arrives mid-grace', async () => {
    const engine = new TestEngine();
    const ctx = makeCtx();
    const opts = new PromptOptions();
    opts.id = 'counter-cancel';
    opts.keepStdinOpen = true;
    opts.ctx = ctx;
    opts.silenceTimeoutMs = 0;

    engine.prompt('hi', opts).catch(() => {});
    await flush();

    engine.fakeChild.emitResult();
    await flush();
    expect(ctx.stdinGraceTimer).toBeDefined();

    // Nudge arrives 500 ms into the grace window.
    jest.advanceTimersByTime(500);
    await engine.onUserMessage('counter-cancel', 'late nudge');

    // The timer must be cancelled; counter is back to 1.
    expect(ctx.stdinGraceTimer).toBeUndefined();
    expect(ctx.outstandingTurns).toBe(1);

    // Even after the original 2 s deadline passes, stdin must remain open.
    jest.advanceTimersByTime(3000);
    await flush();
    expect(engine.fakeChild.endCount).toBe(0);
    expect(engine.fakeChild.stdin.writableEnded).toBe(false);
  });
});
