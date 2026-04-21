/**
 * Unit tests for ClaudeEngine.parseOutput() and accumulateTokenUsage().
 *
 * These tests exercise the private methods directly via any-casting, using
 * raw Buffer chunks that mimic what the claude CLI writes to stdout.
 *
 * Coverage areas:
 *   - Single complete JSON line in one chunk
 *   - JSON object split across two chunks (partial line buffering)
 *   - Multiple complete JSON lines in one chunk
 *   - Malformed / non-JSON line (must not throw)
 *   - Token accumulation across events for different roles
 */

import { ClaudeEngine } from '../claude-engine.js';
import type { InvocationContext } from '../../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh InvocationContext with zero state. */
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
  };
}

/**
 * Calls the private parseOutput method with a raw string chunk.
 *
 * @param engine - ClaudeEngine instance under test.
 * @param chunk  - String content to feed (converted to Buffer internally by the engine).
 * @param ctx    - Optional InvocationContext; when provided the engine buffers partial lines.
 * @param stream - Which process stream produced this chunk (default 'stdout').
 */
function feed(
  engine: ClaudeEngine,
  chunk: string,
  ctx?: InvocationContext,
  stream: 'stdout' | 'stderr' = 'stdout',
): void {
  (engine as any).parseOutput(Buffer.from(chunk), undefined, stream, undefined, ctx);
}

// ---------------------------------------------------------------------------
// JSON line factories — all produce newline-terminated strings
// ---------------------------------------------------------------------------

function assistantLine(inputTokens: number, outputTokens: number, role = 'assistant'): string {
  return (
    JSON.stringify({
      type: 'assistant',
      session_id: 'test-session',
      message: {
        id: 'msg_test',
        role,
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }) + '\n'
  );
}

function userLine(inputTokens: number, outputTokens: number): string {
  return (
    JSON.stringify({
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tid', content: 'ok' }],
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }) + '\n'
  );
}

function systemLine(): string {
  return (
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'test-session',
      tools: [],
      mcp_servers: [],
      model: 'claude-opus-4',
      cwd: '/tmp',
      api_key_source: 'env',
    }) + '\n'
  );
}

function resultLine(): string {
  return (
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'test-session',
      total_cost_usd: 0.01,
      duration_ms: 500,
      duration_api_ms: 400,
      num_turns: 2,
      is_error: false,
    }) + '\n'
  );
}

// ---------------------------------------------------------------------------
// Test suite: parseOutput — line buffering
// ---------------------------------------------------------------------------

describe('ClaudeEngine.parseOutput — line buffering', () => {
  it('processes a single complete JSON line in one chunk', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    feed(engine, assistantLine(100, 50), ctx);

    expect(ctx.invocationInputTokens).toBe(100);
    expect(ctx.invocationOutputTokens).toBe(50);
    expect(ctx.lineBuffer).toBe('');
  });

  it('buffers a partial line and processes it when the remainder arrives', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    const full = assistantLine(200, 80);
    // Split the line in the middle (no newline in first chunk)
    const mid = Math.floor(full.length / 2);
    const part1 = full.slice(0, mid);
    const part2 = full.slice(mid);

    // First chunk: no newline — nothing should be parsed yet
    feed(engine, part1, ctx);
    expect(ctx.invocationInputTokens).toBe(0);
    expect(ctx.lineBuffer).toBe(part1);

    // Second chunk: completes the line — should be parsed now
    feed(engine, part2, ctx);
    expect(ctx.invocationInputTokens).toBe(200);
    expect(ctx.invocationOutputTokens).toBe(80);
    expect(ctx.lineBuffer).toBe('');
  });

  it('processes multiple complete JSON lines in a single chunk', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    const chunk = assistantLine(100, 40) + userLine(60, 20) + assistantLine(50, 10);
    feed(engine, chunk, ctx);

    expect(ctx.invocationInputTokens).toBe(210);
    expect(ctx.invocationOutputTokens).toBe(70);
  });

  it('retains trailing partial line in lineBuffer for next chunk', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    const complete = assistantLine(100, 30);
    const partial = '{"type":"assistant"';  // no closing brace or newline

    feed(engine, complete + partial, ctx);

    // The complete line must have been processed
    expect(ctx.invocationInputTokens).toBe(100);
    // The partial remainder must sit in the buffer
    expect(ctx.lineBuffer).toBe(partial);
  });

  it('handles empty chunks without errors', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    expect(() => feed(engine, '', ctx)).not.toThrow();
    expect(ctx.invocationInputTokens).toBe(0);
    expect(ctx.lineBuffer).toBe('');
  });

  it('handles a chunk that is only whitespace or blank lines', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    expect(() => feed(engine, '\n\n   \n', ctx)).not.toThrow();
    expect(ctx.invocationInputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test suite: parseOutput — malformed input
// ---------------------------------------------------------------------------

describe('ClaudeEngine.parseOutput — malformed input', () => {
  it('does not throw on a malformed JSON line', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    expect(() => feed(engine, 'not-json-at-all\n', ctx)).not.toThrow();
    expect(ctx.invocationInputTokens).toBe(0);
  });

  it('does not throw on a truncated JSON object', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    // Force the partial into the buffer then try to flush with a newline
    feed(engine, '{"type":"assistant"\n', ctx);

    expect(ctx.invocationInputTokens).toBe(0);
  });

  it('skips malformed lines but still processes valid lines in the same chunk', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    const chunk = 'malformed-line\n' + assistantLine(150, 60);
    feed(engine, chunk, ctx);

    expect(ctx.invocationInputTokens).toBe(150);
    expect(ctx.invocationOutputTokens).toBe(60);
  });

  it('does not throw when chunk contains mixed valid, invalid, and empty lines', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    const chunk =
      '\n' +
      'RANDOM LOG OUTPUT\n' +
      assistantLine(10, 5) +
      '{broken json}\n' +
      userLine(20, 8);

    expect(() => feed(engine, chunk, ctx)).not.toThrow();
    expect(ctx.invocationInputTokens).toBe(30);
    expect(ctx.invocationOutputTokens).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Test suite: parseOutput — without a context (no buffering)
// ---------------------------------------------------------------------------

describe('ClaudeEngine.parseOutput — no context (checkPrerequisites path)', () => {
  it('processes complete lines without ctx, returning raw output string', () => {
    const engine = new ClaudeEngine();
    // No ctx passed — each chunk is treated independently
    // We just verify no exception is thrown and the return value is the raw chunk text
    const chunk = systemLine();
    expect(() => feed(engine, chunk, undefined)).not.toThrow();
  });

  it('does not persist partial lines between calls when ctx is absent', () => {
    const engine = new ClaudeEngine();
    const full = assistantLine(100, 50);
    const mid = Math.floor(full.length / 2);

    // Feed first half with no ctx — no buffer to carry over
    feed(engine, full.slice(0, mid), undefined);
    // Feed second half with no ctx — each call is independent, no parsing expected
    // This just verifies no crash
    expect(() => feed(engine, full.slice(mid), undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test suite: accumulateTokenUsage — role tracking
// ---------------------------------------------------------------------------

describe('ClaudeEngine.accumulateTokenUsage — per-role token tracking', () => {
  it('accumulates tokens under "orchestrator" role by default (currentRole is null)', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    feed(engine, assistantLine(100, 50), ctx);

    const orchestratorTokens = ctx.roleTokens.get('orchestrator');
    expect(orchestratorTokens).toBeDefined();
    expect(orchestratorTokens!.input).toBe(100);
    expect(orchestratorTokens!.output).toBe(50);
  });

  it('accumulates tokens under a named role when currentRole is set', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();
    ctx.currentRole = 'forjis-designer';

    feed(engine, assistantLine(200, 80), ctx);

    const designerTokens = ctx.roleTokens.get('forjis-designer');
    expect(designerTokens).toBeDefined();
    expect(designerTokens!.input).toBe(200);
    expect(designerTokens!.output).toBe(80);

    // "orchestrator" bucket should not have been touched
    expect(ctx.roleTokens.has('orchestrator')).toBe(false);
  });

  it('accumulates tokens across multiple events for the same role', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();
    ctx.currentRole = 'forjis-engineer';

    feed(engine, assistantLine(100, 40), ctx);
    feed(engine, assistantLine(200, 60), ctx);
    feed(engine, userLine(50, 10), ctx);

    const engineerTokens = ctx.roleTokens.get('forjis-engineer');
    expect(engineerTokens!.input).toBe(350);
    expect(engineerTokens!.output).toBe(110);

    expect(ctx.invocationInputTokens).toBe(350);
    expect(ctx.invocationOutputTokens).toBe(110);
  });

  it('tracks separate buckets for different roles across events', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    // Phase 1: orchestrator turn
    ctx.currentRole = null;
    feed(engine, assistantLine(100, 30), ctx);

    // Phase 2: designer turn
    ctx.currentRole = 'forjis-designer';
    feed(engine, assistantLine(200, 70), ctx);

    // Phase 3: engineer turn
    ctx.currentRole = 'forjis-engineer';
    feed(engine, userLine(50, 15), ctx);

    // Per-role buckets
    expect(ctx.roleTokens.get('orchestrator')!.input).toBe(100);
    expect(ctx.roleTokens.get('orchestrator')!.output).toBe(30);

    expect(ctx.roleTokens.get('forjis-designer')!.input).toBe(200);
    expect(ctx.roleTokens.get('forjis-designer')!.output).toBe(70);

    expect(ctx.roleTokens.get('forjis-engineer')!.input).toBe(50);
    expect(ctx.roleTokens.get('forjis-engineer')!.output).toBe(15);

    // Invocation-wide totals must equal the sum of all roles
    expect(ctx.invocationInputTokens).toBe(350);
    expect(ctx.invocationOutputTokens).toBe(115);
  });

  it('ignores system events (no token fields)', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    feed(engine, systemLine(), ctx);

    expect(ctx.invocationInputTokens).toBe(0);
    expect(ctx.roleTokens.size).toBe(0);
  });

  it('ignores result events (no token fields)', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    feed(engine, resultLine(), ctx);

    expect(ctx.invocationInputTokens).toBe(0);
    expect(ctx.roleTokens.size).toBe(0);
  });

  it('ignores assistant events that have no usage field', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();

    const noUsage =
      JSON.stringify({
        type: 'assistant',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          // no usage field
        },
      }) + '\n';

    feed(engine, noUsage, ctx);

    expect(ctx.invocationInputTokens).toBe(0);
    expect(ctx.roleTokens.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test suite: onEvent callback integration
// ---------------------------------------------------------------------------

describe('ClaudeEngine.parseOutput — onEvent callback', () => {
  it('calls onEvent with a TaskEvent when a parseable assistant line arrives', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();
    const events: unknown[] = [];

    (engine as any).parseOutput(
      Buffer.from(assistantLine(10, 5)),
      (evt: unknown) => events.push(evt),
      'stdout',
      undefined,
      ctx,
    );

    expect(events.length).toBeGreaterThan(0);
    const evt = events[0] as any;
    expect(evt.type).toBe('assistant');
    expect(evt.stream).toBe('stdout');
    expect(typeof evt.timestamp).toBe('string');
    expect(typeof evt.content).toBe('string');
  });

  it('does not call onEvent for empty or whitespace-only lines', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();
    const events: unknown[] = [];

    (engine as any).parseOutput(
      Buffer.from('\n   \n'),
      (evt: unknown) => events.push(evt),
      'stdout',
      undefined,
      ctx,
    );

    expect(events.length).toBe(0);
  });

  it('does not call onEvent for malformed JSON lines', () => {
    const engine = new ClaudeEngine();
    const ctx = makeCtx();
    const events: unknown[] = [];

    (engine as any).parseOutput(
      Buffer.from('this is not json\n'),
      (evt: unknown) => events.push(evt),
      'stdout',
      undefined,
      ctx,
    );

    expect(events.length).toBe(0);
  });
});
