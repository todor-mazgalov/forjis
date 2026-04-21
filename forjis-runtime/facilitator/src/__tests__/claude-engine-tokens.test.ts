/**
 * Unit tests for ClaudeEngine token accumulation.
 *
 * Requirements validated:
 *   FR-001 Token accumulation — parseOutput accumulates usage from stream events
 *   FR-002 EngineResult.usage — invoke returns accumulated token counts
 */

import { ClaudeEngine } from '../engines/claude/claude-engine.js';
import type { EngineResult } from '../engine.js';

/**
 * Helper to access the private parseOutput method via any-cast.
 *
 * @param engine - The ClaudeEngine instance.
 * @param chunk - A string chunk to parse.
 * @param stream - The originating stream.
 */
function feedChunk(engine: ClaudeEngine, chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  (engine as any).parseOutput(Buffer.from(chunk), undefined, stream);
}

/**
 * Builds a mock assistant stream event JSON line with usage data.
 *
 * @param inputTokens - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @returns A newline-terminated JSON string.
 */
function assistantEvent(inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: 'test-session',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  }) + '\n';
}

/**
 * Builds a mock user stream event JSON line with usage data.
 *
 * @param inputTokens - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @returns A newline-terminated JSON string.
 */
function userEvent(inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'user',
    session_id: 'test-session',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'test', content: 'ok' }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  }) + '\n';
}

/**
 * Builds a mock assistant event without usage data.
 *
 * @returns A newline-terminated JSON string.
 */
function assistantEventNoUsage(): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: 'test-session',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    },
  }) + '\n';
}

// --------------------------------------------------------------------------
// Token accumulation via parseOutput
// --------------------------------------------------------------------------

describe('ClaudeEngine token accumulation', () => {
  it('accumulates tokens from assistant events', () => {
    const engine = new ClaudeEngine();
    feedChunk(engine, assistantEvent(100, 50));
    feedChunk(engine, assistantEvent(200, 75));

    expect((engine as any).invocationInputTokens).toBe(300);
    expect((engine as any).invocationOutputTokens).toBe(125);
  });

  it('accumulates tokens from user events', () => {
    const engine = new ClaudeEngine();
    feedChunk(engine, userEvent(50, 10));

    expect((engine as any).invocationInputTokens).toBe(50);
    expect((engine as any).invocationOutputTokens).toBe(10);
  });

  it('ignores events without usage field', () => {
    const engine = new ClaudeEngine();
    feedChunk(engine, assistantEventNoUsage());

    expect((engine as any).invocationInputTokens).toBe(0);
    expect((engine as any).invocationOutputTokens).toBe(0);
  });

  it('ignores system and result events', () => {
    const engine = new ClaudeEngine();
    const systemEvent = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'test',
      tools: [],
      mcp_servers: [],
      model: 'claude',
      cwd: '.',
      api_key_source: 'env',
    }) + '\n';
    feedChunk(engine, systemEvent);

    expect((engine as any).invocationInputTokens).toBe(0);
    expect((engine as any).invocationOutputTokens).toBe(0);
  });

  it('accumulates from mixed event types', () => {
    const engine = new ClaudeEngine();
    feedChunk(engine, assistantEvent(100, 50));
    feedChunk(engine, userEvent(30, 5));
    feedChunk(engine, assistantEvent(200, 75));

    expect((engine as any).invocationInputTokens).toBe(330);
    expect((engine as any).invocationOutputTokens).toBe(130);
  });
});

// --------------------------------------------------------------------------
// Dry-run returns undefined usage
// --------------------------------------------------------------------------

describe('ClaudeEngine invoke dry-run', () => {
  it('returns undefined usage in dry-run mode', async () => {
    const engine = new ClaudeEngine();
    const result = await engine.invoke({
      projectDir: '.',
      taskId: 'test-task',
      taskDescription: 'test',
      configDir: '.forjis/config',
      dryRun: true,
    });

    expect(result.usage).toBeUndefined();
  });
});
