/**
 * Unit tests for ClaudeEngine formatEvent — DONE string format.
 *
 * Requirements validated:
 *   FR-006 — Result event format is `[DONE] turns=N ok=BOOL` (no cost= field)
 */

import { ClaudeEngine } from '../engines/claude/claude-engine.js';

/**
 * Accesses the private formatEvent method via any-cast.
 */
function formatEvent(engine: ClaudeEngine, event: Record<string, unknown>): string | null {
  return (engine as any).formatEvent(event);
}

describe('formatEvent result (DONE) string', () => {
  it('formats result event as [DONE] turns=N ok=BOOL without cost', () => {
    const engine = new ClaudeEngine();
    const resultEvent = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'test-session',
      total_cost_usd: 0.1234,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 3,
      is_error: false,
    };

    const formatted = formatEvent(engine, resultEvent);
    expect(formatted).toBe('[DONE] turns=3 ok=true');
  });

  it('formats result event with is_error=true as ok=false', () => {
    const engine = new ClaudeEngine();
    const resultEvent = {
      type: 'result',
      subtype: 'error_max_turns',
      result: 'error',
      session_id: 'test-session',
      total_cost_usd: 0.5678,
      duration_ms: 10000,
      duration_api_ms: 9000,
      num_turns: 10,
      is_error: true,
    };

    const formatted = formatEvent(engine, resultEvent);
    expect(formatted).toBe('[DONE] turns=10 ok=false');
  });

  it('does not contain cost= in the formatted string', () => {
    const engine = new ClaudeEngine();
    const resultEvent = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'test-session',
      total_cost_usd: 99.9999,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      is_error: false,
    };

    const formatted = formatEvent(engine, resultEvent);
    expect(formatted).not.toContain('cost=');
    expect(formatted).not.toContain('$');
  });

  it('result event matches exact pattern [DONE] turns=N ok=BOOL', () => {
    const engine = new ClaudeEngine();
    const resultEvent = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'test-session',
      total_cost_usd: 0.0,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 7,
      is_error: false,
    };

    const formatted = formatEvent(engine, resultEvent);
    expect(formatted).toMatch(/^\[DONE\] turns=\d+ ok=(true|false)$/);
  });
});
