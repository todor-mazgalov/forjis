/**
 * Unit tests for the stream field on TaskEvent.
 *
 * Covers:
 *   - FR-002: parseOutput stamps 'stdout' and 'stderr' on forwarded events
 *   - FR-003: JSONL serialization includes/excludes stream field
 *   - NFR-001: Legacy JSONL without stream field parses correctly
 */

import type { TaskEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a ClaudeEngine instance and invokes its private parseOutput method.
 *
 * Uses bracket notation to access the private method for testing purposes.
 * Returns the collected TaskEvent objects emitted via the onEvent callback.
 */
async function callParseOutput(
  chunk: string,
  stream?: 'stdout' | 'stderr',
): Promise<TaskEvent[]> {
  const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
  const engine = new ClaudeEngine();
  const events: TaskEvent[] = [];
  const onEvent = (event: TaskEvent) => events.push(event);

  (engine as any).parseOutput(Buffer.from(chunk + '\n', 'utf-8'), onEvent, stream);

  return events;
}

/**
 * Builds a minimal valid Claude stream-json system event as a JSON string.
 */
function makeSystemEventJson(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'test-session',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-20250514',
    cwd: '/tmp',
    api_key_source: 'env',
  });
}

/**
 * Builds a minimal valid Claude stream-json result event as a JSON string.
 */
function makeResultEventJson(): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: 'test-session',
    total_cost_usd: 0.01,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    is_error: false,
  });
}

// ---------------------------------------------------------------------------
// FR-002: parseOutput stamps stream on events
// ---------------------------------------------------------------------------

describe('FR-002: parseOutput stream stamping', () => {
  it('stamps stdout on events from the stdout stream', async () => {
    /** Validates FR-002: events from stdout carry stream: 'stdout' */
    const events = await callParseOutput(makeSystemEventJson(), 'stdout');
    expect(events).toHaveLength(1);
    expect(events[0].stream).toBe('stdout');
  });

  it('stamps stderr on events from the stderr stream', async () => {
    /** Validates FR-002: events from stderr carry stream: 'stderr' */
    const events = await callParseOutput(makeSystemEventJson(), 'stderr');
    expect(events).toHaveLength(1);
    expect(events[0].stream).toBe('stderr');
  });

  it('omits stream field when stream parameter is undefined', async () => {
    /** Validates NFR-001: backward compat — no stream when not provided */
    const events = await callParseOutput(makeSystemEventJson(), undefined);
    expect(events).toHaveLength(1);
    expect(events[0].stream).toBeUndefined();
  });

  it('includes stream alongside other TaskEvent fields', async () => {
    /** Validates FR-002: stream does not displace existing fields */
    const events = await callParseOutput(makeResultEventJson(), 'stdout');
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBeDefined();
    expect(events[0].type).toBe('result');
    expect(events[0].role).toBe('orchestrator');
    expect(events[0].content).toContain('[DONE]');
    expect(events[0].stream).toBe('stdout');
  });
});

// ---------------------------------------------------------------------------
// FR-003: JSONL serialization includes/excludes stream field
// ---------------------------------------------------------------------------

describe('FR-003: JSONL serialization of stream field', () => {
  it('JSON.stringify includes stream when present', () => {
    /** Validates FR-003: stream field is serialized into JSONL */
    const event: TaskEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] test',
      stream: 'stdout',
    };
    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized) as TaskEvent;
    expect(parsed.stream).toBe('stdout');
  });

  it('JSON.stringify excludes stream when undefined', () => {
    /** Validates FR-003: no stream key in serialized output when absent */
    const event: TaskEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] test',
    };
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('"stream"');
  });
});

// ---------------------------------------------------------------------------
// NFR-001: Legacy JSONL backward compatibility
// ---------------------------------------------------------------------------

describe('NFR-001: Legacy JSONL without stream field', () => {
  it('parses legacy JSONL (no stream) into a valid TaskEvent', () => {
    /** Validates NFR-001: old JSONL entries remain valid TaskEvent objects */
    const legacyJsonl = '{"timestamp":"2025-01-01T00:00:00.000Z","type":"system","role":"orchestrator","content":"[SYSTEM] init"}';
    const parsed = JSON.parse(legacyJsonl) as TaskEvent;
    expect(parsed.timestamp).toBe('2025-01-01T00:00:00.000Z');
    expect(parsed.type).toBe('system');
    expect(parsed.role).toBe('orchestrator');
    expect(parsed.content).toBe('[SYSTEM] init');
    expect(parsed.stream).toBeUndefined();
  });

  it('parses new JSONL (with stream) into a valid TaskEvent', () => {
    /** Validates NFR-001: new JSONL entries with stream are valid */
    const newJsonl = '{"timestamp":"2026-01-01T00:00:00.000Z","type":"system","role":"orchestrator","content":"[SYSTEM] init","stream":"stderr"}';
    const parsed = JSON.parse(newJsonl) as TaskEvent;
    expect(parsed.stream).toBe('stderr');
  });
});
