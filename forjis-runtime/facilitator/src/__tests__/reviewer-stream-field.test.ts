/**
 * Reviewer unit tests — add-stream-to-output-and-visualize-in-ui
 *
 * Written by the Fullstack Reviewer Agent. These tests are INDEPENDENT of the
 * developer's stream-field.test.ts and cover all acceptance criteria:
 *
 *   FR-001: TaskEvent interface has optional stream field with correct type
 *   FR-002: parseOutput stamps stream='stdout'/'stderr' on emitted events
 *   FR-003: JSONL serialization includes stream when present, excludes when absent
 *   NFR-001: Backward compatibility — events without stream field parse/work correctly
 */

import type { TaskEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal valid Claude stream-json system event (produces a TaskEvent). */
const SYSTEM_EVENT_JSON = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'reviewer-session',
  tools: [],
  mcp_servers: [],
  model: 'claude-reviewer-test',
  cwd: '/tmp/reviewer',
  api_key_source: 'env',
});

/** Minimal valid Claude stream-json result event (produces a TaskEvent). */
const RESULT_EVENT_JSON = JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: '',
  session_id: 'reviewer-session',
  total_cost_usd: 0.0,
  duration_ms: 100,
  duration_api_ms: 80,
  num_turns: 1,
  is_error: false,
});

/**
 * Invokes ClaudeEngine.parseOutput (private) via bracket notation and collects
 * all emitted TaskEvent objects. Each call uses a fresh engine instance to
 * avoid shared lineBuffer state from previous tests.
 */
async function invokeParseOutput(
  jsonLine: string,
  stream?: 'stdout' | 'stderr',
): Promise<TaskEvent[]> {
  const { ClaudeEngine } = await import('../engines/claude/claude-engine.js');
  const engine = new ClaudeEngine();
  const captured: TaskEvent[] = [];
  // parseOutput accumulates lines with a line buffer; append '\n' to flush.
  (engine as any).parseOutput(
    Buffer.from(jsonLine + '\n', 'utf-8'),
    (evt: TaskEvent) => captured.push(evt),
    stream,
  );
  return captured;
}

// ===========================================================================
// FR-001: TaskEvent interface shape
// ===========================================================================

describe('FR-001: TaskEvent interface has optional stream field', () => {
  it('accepts a TaskEvent without a stream field (field is optional)', () => {
    /** The stream field must be optional; omitting it must satisfy the type. */
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] test',
    };
    // If this compiles and the field is absent, the contract is fulfilled.
    expect(event.stream).toBeUndefined();
  });

  it('accepts stream: stdout as a valid TaskEvent', () => {
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] test',
      stream: 'stdout',
    };
    expect(event.stream).toBe('stdout');
  });

  it('accepts stream: stderr as a valid TaskEvent', () => {
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] test',
      stream: 'stderr',
    };
    expect(event.stream).toBe('stderr');
  });

  it('TaskEvent retains all pre-existing fields alongside stream', () => {
    /** All four original fields must still exist when stream is added. */
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'result',
      role: 'forjis-developer',
      content: '[DONE] turns=3',
      stream: 'stdout',
    };
    expect(event.timestamp).toBe('2026-03-24T00:00:00.000Z');
    expect(event.type).toBe('result');
    expect(event.role).toBe('forjis-developer');
    expect(event.content).toBe('[DONE] turns=3');
    expect(event.stream).toBe('stdout');
  });
});

// ===========================================================================
// FR-002: parseOutput stamps stream on forwarded events
// ===========================================================================

describe('FR-002: parseOutput stamps stream value on TaskEvents', () => {
  it('stamps stdout when stream param is stdout', async () => {
    const events = await invokeParseOutput(SYSTEM_EVENT_JSON, 'stdout');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.stream).toBe('stdout');
    }
  });

  it('stamps stderr when stream param is stderr', async () => {
    const events = await invokeParseOutput(SYSTEM_EVENT_JSON, 'stderr');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.stream).toBe('stderr');
    }
  });

  it('omits stream field when stream param is undefined', async () => {
    const events = await invokeParseOutput(SYSTEM_EVENT_JSON, undefined);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(Object.prototype.hasOwnProperty.call(e, 'stream')).toBe(false);
    }
  });

  it('result event with stdout stream carries correct stamp', async () => {
    const events = await invokeParseOutput(RESULT_EVENT_JSON, 'stdout');
    expect(events.length).toBeGreaterThan(0);
    const resultEvent = events.find(e => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.stream).toBe('stdout');
  });

  it('result event with stderr stream carries correct stamp', async () => {
    const events = await invokeParseOutput(RESULT_EVENT_JSON, 'stderr');
    const resultEvent = events.find(e => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.stream).toBe('stderr');
  });

  it('stream stamp does not displace timestamp, type, role, or content', async () => {
    /** FR-002: adding stream must not overwrite existing TaskEvent fields. */
    const events = await invokeParseOutput(RESULT_EVENT_JSON, 'stdout');
    const e = events.find(ev => ev.type === 'result');
    expect(e).toBeDefined();
    expect(e!.timestamp).toBeDefined();
    expect(e!.type).toBe('result');
    expect(e!.role).toBeDefined();
    expect(e!.content).toBeDefined();
    expect(e!.stream).toBe('stdout');
  });

  it('malformed JSON lines do not produce events (stream is not stamped on garbage)', async () => {
    /** parseOutput must swallow malformed lines silently (defensive). */
    const events = await invokeParseOutput('not json at all', 'stdout');
    expect(events).toHaveLength(0);
  });

  it('stdout and stderr produce distinct stream values', async () => {
    const [stdoutEvents, stderrEvents] = await Promise.all([
      invokeParseOutput(RESULT_EVENT_JSON, 'stdout'),
      invokeParseOutput(RESULT_EVENT_JSON, 'stderr'),
    ]);
    expect(stdoutEvents[0].stream).toBe('stdout');
    expect(stderrEvents[0].stream).toBe('stderr');
    expect(stdoutEvents[0].stream).not.toBe(stderrEvents[0].stream);
  });
});

// ===========================================================================
// FR-003: JSONL serialization includes/excludes stream field
// ===========================================================================

describe('FR-003: JSONL serialization of stream field', () => {
  it('JSON.stringify includes stream:stdout in the output', () => {
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] reviewer-test',
      stream: 'stdout',
    };
    const json = JSON.stringify(event);
    expect(json).toContain('"stream":"stdout"');
  });

  it('JSON.stringify includes stream:stderr in the output', () => {
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'result',
      role: 'orchestrator',
      content: '[DONE]',
      stream: 'stderr',
    };
    const json = JSON.stringify(event);
    expect(json).toContain('"stream":"stderr"');
  });

  it('JSON.stringify excludes stream key when field is absent', () => {
    /** Optional field with undefined value must NOT appear in JSON output. */
    const event: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] no-stream',
    };
    const json = JSON.stringify(event);
    expect(json).not.toContain('"stream"');
  });

  it('round-trip: serialize then parse preserves stream:stdout', () => {
    const original: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'assistant',
      role: 'forjis-developer',
      content: '[THINK] hello',
      stream: 'stdout',
    };
    const parsed = JSON.parse(JSON.stringify(original)) as TaskEvent;
    expect(parsed.stream).toBe('stdout');
    expect(parsed.timestamp).toBe(original.timestamp);
    expect(parsed.type).toBe(original.type);
    expect(parsed.role).toBe(original.role);
    expect(parsed.content).toBe(original.content);
  });

  it('round-trip: serialize then parse preserves stream:stderr', () => {
    const original: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] error-stream',
      stream: 'stderr',
    };
    const parsed = JSON.parse(JSON.stringify(original)) as TaskEvent;
    expect(parsed.stream).toBe('stderr');
  });

  it('round-trip: serialize then parse leaves stream undefined when absent', () => {
    const original: TaskEvent = {
      timestamp: '2026-03-24T00:00:00.000Z',
      type: 'system',
      role: 'orchestrator',
      content: '[SYSTEM] legacy',
    };
    const parsed = JSON.parse(JSON.stringify(original)) as TaskEvent;
    expect(parsed.stream).toBeUndefined();
  });

  it('JSONL with stream field correctly re-parses to TaskEvent', () => {
    /** Simulates reading a JSONL line written by the event writer. */
    const jsonlLine = JSON.stringify({
      timestamp: '2026-03-24T12:00:00.000Z',
      type: 'result',
      role: 'forjis-developer',
      content: '[DONE] turns=2 cost=$0.0010 ok=true',
      stream: 'stdout',
    });
    const parsed = JSON.parse(jsonlLine) as TaskEvent;
    expect(parsed.stream).toBe('stdout');
    expect(parsed.type).toBe('result');
  });
});

// ===========================================================================
// NFR-001: Backward compatibility — events without stream remain valid
// ===========================================================================

describe('NFR-001: Backward compatibility with legacy JSONL', () => {
  it('legacy JSONL (no stream) parses to valid TaskEvent with all four original fields', () => {
    const legacyLine = '{"timestamp":"2025-06-01T08:00:00.000Z","type":"system","role":"orchestrator","content":"[SYSTEM] session=abc model=claude-3 cwd=/tmp"}';
    const parsed = JSON.parse(legacyLine) as TaskEvent;
    expect(parsed.timestamp).toBe('2025-06-01T08:00:00.000Z');
    expect(parsed.type).toBe('system');
    expect(parsed.role).toBe('orchestrator');
    expect(parsed.content).toContain('[SYSTEM]');
    expect(parsed.stream).toBeUndefined();
  });

  it('legacy JSONL with assistant type parses without error', () => {
    const legacyLine = '{"timestamp":"2025-06-01T09:00:00.000Z","type":"assistant","role":"forjis-developer","content":"[THINK] writing code..."}';
    const parsed = JSON.parse(legacyLine) as TaskEvent;
    expect(parsed.type).toBe('assistant');
    expect(parsed.stream).toBeUndefined();
  });

  it('legacy JSONL with result type parses without error', () => {
    const legacyLine = '{"timestamp":"2025-06-01T10:00:00.000Z","type":"result","role":"forjis-developer","content":"[DONE] turns=5 cost=$0.0050 ok=true"}';
    const parsed = JSON.parse(legacyLine) as TaskEvent;
    expect(parsed.type).toBe('result');
    expect(parsed.stream).toBeUndefined();
  });

  it('new JSONL (with stream) is also a valid TaskEvent with all five fields', () => {
    const newLine = '{"timestamp":"2026-03-24T00:00:00.000Z","type":"system","role":"orchestrator","content":"[SYSTEM] init","stream":"stdout"}';
    const parsed = JSON.parse(newLine) as TaskEvent;
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.type).toBe('system');
    expect(parsed.role).toBe('orchestrator');
    expect(parsed.content).toBeDefined();
    expect(parsed.stream).toBe('stdout');
  });

  it('parseOutput with no stream param does not set stream on emitted events', async () => {
    /** Simulates an old call site that does not pass stream — must not break. */
    const events = await invokeParseOutput(SYSTEM_EVENT_JSON /* no stream param */);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].stream).toBeUndefined();
    // Confirm 'stream' key is absent from the object (not merely falsy)
    expect('stream' in events[0]).toBe(false);
  });

  it('an event without stream does not serialize a stream key', () => {
    /** Ensures legacy-style events remain clean in JSONL output. */
    const event: TaskEvent = {
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'user',
      role: 'orchestrator',
      content: '[TOOL_RESULT] id=xyz done',
    };
    const json = JSON.stringify(event);
    const parsed: Record<string, unknown> = JSON.parse(json);
    expect(Object.keys(parsed)).not.toContain('stream');
  });
});
