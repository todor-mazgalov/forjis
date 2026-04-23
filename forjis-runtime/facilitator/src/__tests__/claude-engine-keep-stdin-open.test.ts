/**
 * Unit tests for the `keepStdinOpen` + stream-json input contract on
 * {@link ClaudeEngine.prompt} (inspector-019 fix).
 *
 * Inspector 019 failure mode: the Claude CLI, spawned with `-p` and the
 * default `--input-format text`, blocks until stdin is closed before it
 * processes any prompt. The inspector-clarify runner needs stdin to
 * stay open so later clarify answers can be injected as fresh user
 * turns, so the CLI never starts and the whole clarifier batch stalls.
 *
 * The fix: when the caller sets `PromptOptions.keepStdinOpen = true`
 * the engine switches the CLI to `--input-format stream-json` and
 * writes each user turn as a JSONL envelope. Each envelope is a
 * complete record the CLI can start processing immediately — no EOF
 * required — while stdin can remain open for subsequent turns.
 *
 * These tests subclass {@link ClaudeEngine} to intercept `spawnChild`
 * and inspect both the spawn args and every stdin write produced by
 * the engine, without requiring a real `claude` binary on PATH.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ChildProcessByStdio,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { ClaudeEngine } from '../engines/claude/claude-engine.js';
import { PromptOptions } from '../types.js';

/**
 * Fake child that exposes a PassThrough stdin the test can inspect.
 * The engine writes to `stdin` either raw text (legacy) or one JSONL
 * envelope per turn (keepStdinOpen=true), which we capture via a
 * 'data' listener so tests can assert the exact byte payload.
 */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every write the engine makes to stdin, in order. */
  readonly stdinWrites: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinWrites.push(chunk.toString('utf-8'));
    });
  }

  kill(): boolean {
    return true;
  }
}

/** Subclass that records the spawn args and returns a FakeChild. */
class TestEngine extends ClaudeEngine {
  lastArgs: string[] = [];
  readonly fakeChild = new FakeChild();

  protected override spawnChild(
    _command: string,
    args: string[],
    _opts: SpawnOptionsWithoutStdio,
  ): ChildProcessByStdio<Writable, Readable, Readable> {
    this.lastArgs = args;
    return this.fakeChild as unknown as ChildProcessByStdio<
      Writable,
      Readable,
      Readable
    >;
  }
}

/** Drain any buffered stdin writes so assertions see them. */
async function settleStdin(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ClaudeEngine.prompt with keepStdinOpen=true (inspector-019)', () => {
  /**
   * The engine MUST pass `--input-format stream-json` to the CLI when
   * `keepStdinOpen=true` so the CLI does not wait for EOF before
   * processing the first prompt.
   */
  it('adds --input-format stream-json to the spawn args', async () => {
    const engine = new TestEngine();

    const opts = new PromptOptions();
    opts.keepStdinOpen = true;
    opts.id = 'test-batch';
    opts.silenceTimeoutMs = 30; // settle quickly after the test
    engine.prompt('hi', opts).catch(() => {
      /* the watchdog will reject — we only care about spawn args */
    });

    await settleStdin();

    const args = engine.lastArgs;
    const fmtIdx = args.indexOf('--input-format');
    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(args[fmtIdx + 1]).toBe('stream-json');
  });

  /**
   * The engine MUST encode the initial prompt as a JSONL user message
   * envelope (not raw text) so the stream-json parser accepts it as
   * the first user turn.
   */
  it('writes the initial prompt as a JSONL user envelope', async () => {
    const engine = new TestEngine();

    const opts = new PromptOptions();
    opts.keepStdinOpen = true;
    opts.id = 'test-batch';
    opts.silenceTimeoutMs = 30;
    engine.prompt('hello world', opts).catch(() => {
      /* watchdog rejection is fine for this assertion */
    });

    await settleStdin();

    expect(engine.fakeChild.stdinWrites).toHaveLength(1);
    const first = engine.fakeChild.stdinWrites[0];
    expect(first.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(first.trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello world' },
    });
  });

  /**
   * The engine MUST NOT close stdin after the initial write when
   * `keepStdinOpen=true` so subsequent {@link ClaudeEngine.onUserMessage}
   * calls can append further turns.
   */
  it('leaves stdin open after the initial write', async () => {
    const engine = new TestEngine();

    const opts = new PromptOptions();
    opts.keepStdinOpen = true;
    opts.id = 'test-batch';
    opts.silenceTimeoutMs = 30;
    engine.prompt('hi', opts).catch(() => {
      /* watchdog rejection is fine */
    });

    await settleStdin();

    expect(engine.fakeChild.stdin.writableEnded).toBe(false);
  });
});

describe('ClaudeEngine.prompt with keepStdinOpen=false (legacy mode)', () => {
  /**
   * Regression guard: legacy callers that do not set `keepStdinOpen`
   * must still receive the original `--input-format text` CLI
   * behaviour (no explicit flag) and have their raw prompt text
   * written to stdin followed by an EOF.
   */
  it('does not add --input-format and writes raw text + EOF', async () => {
    const engine = new TestEngine();

    const opts = new PromptOptions();
    opts.silenceTimeoutMs = 30;
    engine.prompt('legacy prompt', opts).catch(() => {
      /* watchdog rejection is fine */
    });

    await settleStdin();

    expect(engine.lastArgs).not.toContain('--input-format');
    expect(engine.fakeChild.stdinWrites).toEqual(['legacy prompt']);
    expect(engine.fakeChild.stdin.writableEnded).toBe(true);
  });
});

describe('ClaudeEngine.onUserMessage stream-json framing', () => {
  /**
   * `onUserMessage` MUST frame its payload as a JSONL user envelope so
   * the CLI's stream-json parser treats the write as a fresh user
   * turn. A raw-text write would be silently ignored by the CLI.
   */
  it('frames each injected turn as a JSONL user envelope', async () => {
    const engine = new TestEngine();

    const opts = new PromptOptions();
    opts.keepStdinOpen = true;
    opts.id = 'inject-test';
    opts.silenceTimeoutMs = 200;
    engine.prompt('initial', opts).catch(() => {
      /* watchdog */
    });

    await settleStdin();

    // Clear the initial envelope so we can isolate the injected one.
    engine.fakeChild.stdinWrites.length = 0;

    await engine.onUserMessage('inject-test', '{"answer":"yes"}');

    expect(engine.fakeChild.stdinWrites).toHaveLength(1);
    const write = engine.fakeChild.stdinWrites[0];
    expect(write.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(write.trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: '{"answer":"yes"}' },
    });
  });
});
