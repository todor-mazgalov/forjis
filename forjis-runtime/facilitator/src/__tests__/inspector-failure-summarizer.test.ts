/**
 * Unit tests for {@link summarizeFailure} and {@link tailEventLog}.
 *
 * Follows the harness pattern used by `inspector-clarifier-runner.test.ts`:
 * inject a fake engine that records invocations, drive assistant events
 * synchronously, and assert the resolved summary plus token-tracker
 * side effects.
 *
 * Covers the FR-013-B-002 scenarios (happy path, input trimming,
 * engine failure fallback, empty-events fallback) and FR-013-B-004
 * scenarios (token usage recording and skip-on-fallback) plus the
 * ancillary timeout + streaming-tail behaviour required by D4/D7.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  EngineInvokeOptions,
  EngineResult,
  ForjisEngine,
} from '../engine.js';
import {
  summarizeFailure,
  tailEventLog,
  type SummarizeFailureInput,
} from '../inspector-failure-summarizer.js';
import { TokenTracker } from '../token-tracker.js';
import type { TaskEvent } from '../types.js';

/**
 * Script the assistant-content chunks + result payload the fake engine
 * should produce for the next invocation.
 */
interface ScriptedBehaviour {
  kind: 'respond';
  chunks: string[];
  usage?: EngineResult['usage'];
}

/** Script a thrown error instead of a clean completion. */
interface ThrowingBehaviour {
  kind: 'throw';
  error: Error;
}

/** Script an indefinite hang — only finalises when timeout fires. */
interface HangingBehaviour {
  kind: 'hang';
}

type Behaviour = ScriptedBehaviour | ThrowingBehaviour | HangingBehaviour;

/**
 * Fake engine used by the summarizer tests. The next queued
 * {@link Behaviour} drives each `invoke()` call.
 */
class FakeSummarizerEngine implements ForjisEngine {
  readonly name = 'fake-summarizer';
  readonly invocations: EngineInvokeOptions[] = [];
  private readonly queue: Behaviour[] = [];

  async checkPrerequisites(): Promise<string> {
    return 'ok';
  }

  async cleanup(): Promise<void> {
    /* no-op */
  }

  async prompt(): Promise<string> {
    return '';
  }

  async invoke(options: EngineInvokeOptions): Promise<EngineResult> {
    this.invocations.push(options);
    const next = this.queue.shift();
    if (!next) {
      throw new Error('FakeSummarizerEngine: no behaviour queued');
    }

    if (next.kind === 'throw') {
      throw next.error;
    }

    if (next.kind === 'hang') {
      return new Promise<EngineResult>(() => {
        /* never resolves */
      });
    }

    for (const chunk of next.chunks) {
      options.onEvent?.({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        role: 'orchestrator',
        content: chunk,
      });
    }

    return {
      exitCode: 0,
      taskId: options.taskId,
      stage: null,
      usage: next.usage,
    };
  }

  /** Queue a clean completion with the supplied chunks + optional usage. */
  scriptRespond(chunks: string[], usage?: EngineResult['usage']): void {
    this.queue.push({ kind: 'respond', chunks, usage });
  }

  /** Queue a thrown error for the next invocation. */
  scriptThrow(error: Error): void {
    this.queue.push({ kind: 'throw', error });
  }

  /** Queue an indefinite hang for the next invocation. */
  scriptHang(): void {
    this.queue.push({ kind: 'hang' });
  }
}

/**
 * Build a minimal, well-formed {@link SummarizeFailureInput} with test
 * defaults; callers override fields as needed.
 */
function buildInput(
  engine: FakeSummarizerEngine,
  overrides: Partial<SummarizeFailureInput> = {},
): SummarizeFailureInput {
  return {
    batchId: 'inspector-demo',
    taskId: 'inspector-demo',
    taskPath: '/tmp/fake/.forjis/tasks/inspector-demo',
    category: 'engine-error',
    events: makeEvents(3),
    engine,
    projectDir: '/tmp/fake',
    configDir: '/tmp/fake/.forjis/config',
    tokenTracker: new TokenTracker(),
    ...overrides,
  };
}

/**
 * Build `count` synthetic TaskEvent entries.
 *
 * `shortContent` keeps each entry small enough that 500 of them fit under
 * the 16 KiB prompt cap — useful for the "last 500 survive" assertion.
 */
function makeEvents(count: number, shortContent = false): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      timestamp: 't',
      type: 'a',
      role: 'r',
      content: shortContent ? `e${i}` : `event body ${i}`,
    });
  }
  return events;
}

describe('summarizeFailure — happy path', () => {
  it('returns a trimmed, bounded summary from the fake engine response', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptRespond(['Orchestrator ', 'failed because of a parse error.']);

    const tracker = new TokenTracker();
    const input = buildInput(engine, { tokenTracker: tracker });

    const summary = await summarizeFailure(input);

    expect(summary).toBe('Orchestrator failed because of a parse error.');
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).not.toContain('\n');
    expect(engine.invocations).toHaveLength(1);
    expect(engine.invocations[0].mode).toBe('inspector-failure-summary');
    const modeArgs = engine.invocations[0].modeArgs ?? {};
    expect(modeArgs['maxOutputTokens']).toBe(1000);
    expect(typeof modeArgs['prompt']).toBe('string');
  });

  it('collapses whitespace and caps the output at 160 characters', async () => {
    const engine = new FakeSummarizerEngine();
    const longChunk = `${'word '.repeat(60)}tail`;
    engine.scriptRespond([`   ${longChunk}\n  trailing noise   `]);

    const summary = await summarizeFailure(buildInput(engine));

    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).not.toMatch(/\s{2,}/);
    expect(summary).not.toContain('\n');
  });

  it('records token usage on the tracker when usage is present', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptRespond(['ok'], { inputTokens: 120, outputTokens: 40 });

    const tracker = new TokenTracker();
    await summarizeFailure(buildInput(engine, { tokenTracker: tracker }));

    expect(tracker.getTotalTokens()).toBe(160);
  });
});

describe('summarizeFailure — trimming before the engine', () => {
  it('trims the events array to the last 500 entries before building the prompt', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptRespond(['Trimmed summary']);

    // Short content so all 500 rendered lines fit under the 16 KiB cap.
    const events = makeEvents(650, true);
    await summarizeFailure(buildInput(engine, { events }));

    const prompt = engine.invocations[0].modeArgs?.['prompt'] as string;
    // The tail (positions 150..649) survives; earlier events are dropped.
    expect(prompt).toContain(' e649');
    expect(prompt).toContain(' e150');
    // The very first event should not have been rendered into the prompt.
    expect(prompt).not.toContain(' e0\n');
    expect(prompt).not.toMatch(/ e0$/);
    expect(prompt.length).toBeLessThanOrEqual(16 * 1024 + 400);
  });

  it('caps a large string excerpt at 16 KiB before sending to the engine', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptRespond(['Capped summary']);

    const huge = 'x'.repeat(32 * 1024);
    await summarizeFailure(buildInput(engine, { events: huge }));

    const prompt = engine.invocations[0].modeArgs?.['prompt'] as string;
    // Prompt includes header + excerpt; the excerpt alone must not exceed 16 KiB.
    expect(prompt.length).toBeLessThanOrEqual(16 * 1024 + 400);
  });
});

describe('summarizeFailure — fallback paths', () => {
  it('returns the category fallback and does not call the engine when events is empty', async () => {
    const engine = new FakeSummarizerEngine();
    const tracker = new TokenTracker();
    const summary = await summarizeFailure(
      buildInput(engine, { events: [], category: 'engine-error', tokenTracker: tracker }),
    );

    expect(summary).toBe(
      'Task failed — no event log available.',
    );
    expect(engine.invocations).toHaveLength(0);
    expect(tracker.getTotalTokens()).toBe(0);
  });

  it('returns the category fallback on engine throw without retrying', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptThrow(new Error('boom'));

    const tracker = new TokenTracker();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await summarizeFailure(
        buildInput(engine, { category: 'no-pipeline-state', tokenTracker: tracker }),
      );
      expect(summary).toBe('Orchestrator exited without producing a pipeline plan.');
      expect(engine.invocations).toHaveLength(1);
      expect(tracker.getTotalTokens()).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns the category fallback when the engine emits no assistant content', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptRespond([]);

    const tracker = new TokenTracker();
    const summary = await summarizeFailure(
      buildInput(engine, { category: 'shutdown', tokenTracker: tracker }),
    );

    expect(summary).toBe('Task interrupted during facilitator shutdown.');
    expect(tracker.getTotalTokens()).toBe(0);
  });

  it('returns the category fallback when the engine call times out', async () => {
    jest.useFakeTimers();
    const engine = new FakeSummarizerEngine();
    engine.scriptHang();

    const tracker = new TokenTracker();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = summarizeFailure(
        buildInput(engine, { category: 'engine-error', tokenTracker: tracker }),
      );
      // Race the timer forward past the 30-second guard.
      jest.advanceTimersByTime(31_000);
      const summary = await pending;

      expect(summary).toBe(
        'Task failed during the orchestrator run. Check the dashboard events for details.',
      );
      expect(tracker.getTotalTokens()).toBe(0);
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('invokes the engine exactly once across all paths (no retries)', async () => {
    const engine = new FakeSummarizerEngine();
    engine.scriptThrow(new Error('first'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await summarizeFailure(buildInput(engine));
      expect(engine.invocations).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('tailEventLog', () => {
  it('returns an empty array when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forjis-tail-'));
    try {
      const events = await tailEventLog(join(dir, 'does-not-exist.jsonl'), 10);
      expect(events).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads all entries from a small file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forjis-tail-'));
    try {
      const path = join(dir, 'events.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            timestamp: `2026-04-22T00:00:0${i}Z`,
            type: 'assistant',
            role: 'orchestrator',
            content: `content ${i}`,
          }),
        );
      }
      await writeFile(path, `${lines.join('\n')}\n`);

      const events = await tailEventLog(path, 100);
      expect(events).toHaveLength(5);
      expect(events[0].content).toBe('content 0');
      expect(events[4].content).toBe('content 4');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns exactly maxLines entries from a large file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forjis-tail-'));
    try {
      const path = join(dir, 'events.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 1200; i++) {
        lines.push(
          JSON.stringify({
            timestamp: `2026-04-22T00:00:${String(i).padStart(4, '0')}Z`,
            type: 'assistant',
            role: 'orchestrator',
            content: `entry ${i} padding ${'x'.repeat(200)}`,
          }),
        );
      }
      await writeFile(path, `${lines.join('\n')}\n`);

      const events = await tailEventLog(path, 500);
      expect(events).toHaveLength(500);
      expect(events[events.length - 1].content).toContain('entry 1199');
      expect(events[0].content).toContain('entry 700');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('silently drops malformed JSON lines but keeps the valid ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forjis-tail-'));
    try {
      const path = join(dir, 'events.jsonl');
      const validA = JSON.stringify({
        timestamp: 'a',
        type: 'assistant',
        role: 'orchestrator',
        content: 'A',
      });
      const validB = JSON.stringify({
        timestamp: 'b',
        type: 'assistant',
        role: 'orchestrator',
        content: 'B',
      });
      await writeFile(path, `${validA}\n{not-json\n${validB}\n`);

      const events = await tailEventLog(path, 100);
      expect(events.map((e) => e.content)).toEqual(['A', 'B']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
