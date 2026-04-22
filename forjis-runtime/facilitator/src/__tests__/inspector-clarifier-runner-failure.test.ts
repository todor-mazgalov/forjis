/**
 * Failure-path tests for {@link InspectorClarifierRunner}, added by task
 * `inspector-013-failure-surface` (§ Test Strategy).
 *
 * Uses a lightweight harness that is tuned for the failure-subscriber
 * scenarios — in particular, the fake engine routes the new
 * `'inspector-failure-summary'` mode through an inline summarizer
 * responder so the runner's {@link InspectorClarifierRunner.handleFailure}
 * path can be exercised synchronously without the 30-second engine
 * timeout ever firing.
 *
 * Covers:
 *
 * - Live-run failure: `batch.failed` while a run is still active sends
 *   exactly one `task.status { status: 'failed', summary }` frame.
 * - Post-finalize failure: finalized batch is still addressable via
 *   `recentBatchClients`.
 * - Defence-in-depth: a non-inspector task id is ignored.
 * - `recentBatchClients` FIFO eviction caps at 50 entries.
 * - Missing client id logs a warning and sends no frame.
 * - `parent.json` with `failureSummary` / `failedTaskPath` flows into
 *   `modeArgs.parentContext` verbatim.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Batch,
  ClarifyAnswer,
  ClarifyQuestion,
  InspectorMessage,
  InspectorTransport,
  Pin,
} from '@forjis/shared';

import type {
  EngineInvokeOptions,
  EngineResult,
  ForjisEngine,
} from '../engine.js';
import type { ClarifierAgent } from '../inspector-agent-loader.js';
import { InspectorClarifierRunner } from '../inspector-clarifier-runner.js';
import {
  InspectorServiceImpl,
  type BatchFailedEventPayload,
} from '../web-services/inspector-service.js';
import { TokenTracker } from '../token-tracker.js';
import type { TaskEvent } from '../types.js';

// -- Fake engine ------------------------------------------------------------

/**
 * Fake engine that resolves the failure-summary mode immediately with a
 * canned assistant chunk and leaves the clarify mode's promise pending
 * (matching the primary test file's semantics).
 */
class FakeEngineWithSummary implements ForjisEngine {
  readonly name = 'fake-failure';
  readonly invocations: EngineInvokeOptions[] = [];
  summaryChunks: string[] = ['canned failure summary'];
  summaryUsage: EngineResult['usage'] = { inputTokens: 10, outputTokens: 5 };
  clarifyInvokeResolvers: Array<(r: EngineResult) => void> = [];

  async checkPrerequisites(): Promise<string> {
    return 'ok';
  }

  async cleanup(): Promise<void> {
    /* no-op */
  }

  async prompt(): Promise<string> {
    return '';
  }

  async onUserMessage(): Promise<void> {
    /* no-op */
  }

  invoke(options: EngineInvokeOptions): Promise<EngineResult> {
    this.invocations.push(options);
    if (options.mode === 'inspector-failure-summary') {
      for (const chunk of this.summaryChunks) {
        options.onEvent?.({
          timestamp: new Date().toISOString(),
          type: 'assistant',
          role: 'orchestrator',
          content: chunk,
        });
      }
      return Promise.resolve({
        exitCode: 0,
        taskId: options.taskId,
        stage: null,
        usage: this.summaryUsage,
      });
    }
    // Clarify invocations hang — tests drive the subprocess via
    // emitAssistantJson below.
    return new Promise<EngineResult>((resolve) => {
      this.clarifyInvokeResolvers.push(resolve);
    });
  }

  /** Emit a stream-json assistant turn against the most recent clarify invocation. */
  emitAssistantJson(payload: unknown): void {
    const options = this.invocations[this.invocations.length - 1];
    if (!options || !options.onEvent) return;
    const text = JSON.stringify(payload);
    const event: TaskEvent = {
      timestamp: new Date().toISOString(),
      type: 'assistant',
      role: 'orchestrator',
      content: `[THINK] ${text}...`,
    };
    options.onEvent(event);
  }
}

// -- Fake transport ---------------------------------------------------------

/** Captures the arguments passed to {@link InspectorTransport.send}. */
function createFakeTransport(): {
  transport: InspectorTransport;
  sent: Array<{ clientId: string; msg: InspectorMessage }>;
} {
  const sent: Array<{ clientId: string; msg: InspectorMessage }> = [];
  const transport: InspectorTransport = {
    onConnect: () => {},
    onMessage: () => {},
    onDisconnect: () => {},
    send: (clientId, msg) => {
      sent.push({ clientId, msg });
    },
    broadcast: () => {},
  };
  return { transport, sent };
}

function stubPersona(): ClarifierAgent {
  return {
    name: 'forjis-inspector',
    description: 'Clarifier persona',
    model: 'sonnet',
    tools: ['Read'],
    body: '# Clarifier body',
    sourcePath: '/fake/path.md',
  };
}

function buildPin(batchId: string, index: number): Pin {
  const pinIndex = String(index).padStart(2, '0');
  return {
    id: `pin-${batchId}-${pinIndex}`,
    platform: 'web',
    screen: 'home',
    target: {
      kind: 'element',
      source: { file: 'src/App.tsx', line: 10, col: 4 },
      selector: '#cta',
      componentName: 'CTA',
      bbox: { x: 0, y: 0, w: 10, h: 10 },
    },
    capture: {
      elementScreenshot: `.forjis/inspector/${batchId}/pin-${pinIndex}-element.png`,
      viewportScreenshot: `.forjis/inspector/${batchId}/pin-${pinIndex}-viewport.png`,
      computedStyles: `.forjis/inspector/${batchId}/pin-${pinIndex}-styles.json`,
      annotations: [],
    },
    comment: `pin ${pinIndex} comment`,
    createdAt: '2026-04-21T12:00:00.000Z',
    parentPinId: null,
  };
}

function buildBatch(
  batchId: string,
  count: number,
  parentBatchId: string | null = null,
): Batch {
  const pins: Pin[] = [];
  for (let i = 1; i <= count; i++) pins.push(buildPin(batchId, i));
  return {
    id: batchId,
    platform: 'web',
    screens: ['home'],
    pins,
    createdAt: '2026-04-21T12:00:00.000Z',
    parentBatchId,
    status: 'clarifying',
  };
}

function makeQuestion(id: string): ClarifyQuestion {
  return {
    id,
    text: `Question ${id}?`,
    options: [{ id: 'a', label: 'A', description: 'first' }],
    allowFreeText: true,
  };
}

function makeAnswer(questionId: string): ClarifyAnswer {
  return { questionId, optionId: 'a', freeText: null };
}

interface Harness {
  engine: FakeEngineWithSummary;
  service: InspectorServiceImpl;
  transport: InspectorTransport;
  sent: Array<{ clientId: string; msg: InspectorMessage }>;
  runner: InspectorClarifierRunner;
  tracker: TokenTracker;
  projectDir: string;
  stagingRoot: string;
  configDir: string;
}

async function buildHarness(): Promise<Harness> {
  const projectDir = await mkdtemp(join(tmpdir(), 'forjis-clarifier-failure-'));
  const stagingRoot = join(projectDir, '.forjis', 'inspector');
  const configDir = join(projectDir, '.forjis', 'config');
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });

  const engine = new FakeEngineWithSummary();
  const service = new InspectorServiceImpl({ projectDir, stagingRoot });
  const { transport, sent } = createFakeTransport();
  const tracker = new TokenTracker();

  const runner = new InspectorClarifierRunner({
    engine,
    service,
    transport,
    tokenTracker: tracker,
    personaLoader: () => stubPersona(),
    projectDir,
    configDir,
    stagingRoot,
    tokenBudget: null,
  });
  runner.start();

  return {
    engine,
    service,
    transport,
    sent,
    runner,
    tracker,
    projectDir,
    stagingRoot,
    configDir,
  };
}

/** Seed a batch inside the service and write a synthetic staging dir. */
async function seedBatch(
  h: Harness,
  batchId: string,
  pinCount: number,
  parentBatchId: string | null = null,
): Promise<Batch> {
  const batchDir = join(h.stagingRoot, batchId);
  await mkdir(batchDir, { recursive: true });
  for (let i = 1; i <= pinCount; i++) {
    const pinIndex = String(i).padStart(2, '0');
    await writeFile(
      join(batchDir, `pin-${pinIndex}-element.png`),
      Buffer.from([0x89, 0x50]),
    );
    await writeFile(
      join(batchDir, `pin-${pinIndex}-styles.json`),
      '{"color":"red"}',
    );
  }
  const batch = buildBatch(batchId, pinCount, parentBatchId);
  (h.service as unknown as { batches: Map<string, Batch> }).batches.set(
    batch.id,
    batch,
  );
  return batch;
}

/** Write the task's events.jsonl with a few valid entries. */
async function seedEventsLog(h: Harness, taskId: string): Promise<string> {
  const taskPath = join(h.projectDir, '.forjis', 'tasks', taskId);
  await mkdir(taskPath, { recursive: true });
  const lines = [
    { timestamp: 't1', type: 'assistant', role: 'orchestrator', content: 'hello' },
    { timestamp: 't2', type: 'result', role: 'orchestrator', content: 'world' },
  ];
  await writeFile(
    join(taskPath, 'events.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  return taskPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function cleanup(h: Harness): Promise<void> {
  await h.runner.stop();
  await rm(h.projectDir, { recursive: true, force: true });
}

// -- Tests ------------------------------------------------------------------

describe('InspectorClarifierRunner — failure path (live run)', () => {
  it('summarises and delivers task.status to the active run client', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'inspector-live-1';
      const batch = await seedBatch(h, batchId, 1);
      const taskPath = await seedEventsLog(h, batchId);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      // Drive a Q/A so the runner learns the client id.
      h.engine.emitAssistantJson({ type: 'question', question: makeQuestion('q-1') });
      await h.service.answerClarifyWithClient(batchId, makeAnswer('q-1'), 'client-live');
      await waitFor(() =>
        (h.runner as unknown as {
          runs: Map<string, { originatingClientId: string | null }>;
        }).runs.get(batchId)?.originatingClientId === 'client-live',
      );

      const payload: BatchFailedEventPayload = {
        batchId,
        taskId: batchId,
        taskPath,
        category: 'engine-error',
      };
      h.service.emitBatchFailed(payload);

      await waitFor(() =>
        h.sent.some((f) => f.msg.type === 'task.status' && f.clientId === 'client-live'),
      );

      const failFrames = h.sent.filter(
        (f) =>
          f.msg.type === 'task.status' &&
          (f.msg as { status: string }).status === 'failed',
      );
      expect(failFrames).toHaveLength(1);
      const msg = failFrames[0].msg as { summary?: string; status: string };
      expect(msg.status).toBe('failed');
      expect(typeof msg.summary).toBe('string');
      expect(msg.summary?.length).toBeGreaterThan(0);
      expect(msg.summary?.length).toBeLessThanOrEqual(160);

      // Engine invoked twice: once for clarify, once for the summarizer.
      expect(
        h.engine.invocations.filter((i) => i.mode === 'inspector-failure-summary'),
      ).toHaveLength(1);
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — failure path (post-finalize)', () => {
  it('routes to the remembered client id via recentBatchClients', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'inspector-finalized-1';
      const batch = await seedBatch(h, batchId, 1);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      // Drive Q/A + finalize to populate recentBatchClients.
      h.engine.emitAssistantJson({ type: 'question', question: makeQuestion('q-1') });
      await h.service.answerClarifyWithClient(batchId, makeAnswer('q-1'), 'client-final');
      await waitFor(() =>
        (h.runner as unknown as {
          runs: Map<string, { originatingClientId: string | null }>;
        }).runs.get(batchId)?.originatingClientId === 'client-final',
      );

      h.engine.emitAssistantJson({
        type: 'finalize',
        taskDir: `tasks/${batchId}`,
        taskMd: '# done\n',
        metadata: { source: 'inspector', batchId },
      });
      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));
      await waitFor(() => h.runner.activeRunCount() === 0);

      const taskPath = await seedEventsLog(h, batchId);
      h.service.emitBatchFailed({
        batchId,
        taskId: batchId,
        taskPath,
        category: 'engine-error',
      });

      await waitFor(() =>
        h.sent.some((f) => f.msg.type === 'task.status'),
      );
      const failFrame = h.sent.find(
        (f) =>
          f.msg.type === 'task.status' &&
          (f.msg as { status: string }).status === 'failed',
      );
      expect(failFrame?.clientId).toBe('client-final');
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — failure path (defence-in-depth)', () => {
  it('ignores non-inspector task ids without invoking the summarizer', async () => {
    const h = await buildHarness();
    try {
      // No prior batch — emit a failure for a non-inspector id.
      h.service.emitBatchFailed({
        batchId: 'task-cli-7',
        taskId: 'task-cli-7',
        taskPath: join(h.projectDir, '.forjis', 'tasks', 'task-cli-7'),
        category: 'engine-error',
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        h.engine.invocations.filter(
          (i) => i.mode === 'inspector-failure-summary',
        ),
      ).toHaveLength(0);
      expect(h.sent.filter((f) => f.msg.type === 'task.status')).toHaveLength(0);
    } finally {
      await cleanup(h);
    }
  });

  it('logs a warning and sends nothing when no client id is known', async () => {
    const h = await buildHarness();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.service.emitBatchFailed({
        batchId: 'inspector-unknown',
        taskId: 'inspector-unknown',
        taskPath: join(h.projectDir, '.forjis', 'tasks', 'inspector-unknown'),
        category: 'engine-error',
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(h.sent.filter((f) => f.msg.type === 'task.status')).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('no client id for failed batch'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — recentBatchClients FIFO cap', () => {
  it('retains only the most recent 50 entries after 60 finalises', async () => {
    const h = await buildHarness();
    try {
      const runner = h.runner as unknown as {
        recentBatchClients: Map<string, string>;
        rememberClient: (b: string, c: string) => void;
      };
      for (let i = 0; i < 60; i++) {
        runner.rememberClient(`inspector-b-${i}`, `client-${i}`);
      }
      expect(runner.recentBatchClients.size).toBe(50);
      // Oldest 10 evicted; first survivor is index 10.
      expect(runner.recentBatchClients.has('inspector-b-0')).toBe(false);
      expect(runner.recentBatchClients.has('inspector-b-9')).toBe(false);
      expect(runner.recentBatchClients.has('inspector-b-10')).toBe(true);
      expect(runner.recentBatchClients.has('inspector-b-59')).toBe(true);
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — parent.json failure fields passthrough', () => {
  it('forwards failureSummary and failedTaskPath verbatim into modeArgs.parentContext', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'inspector-reply-1';
      const parentBatchId = 'inspector-parent-1';

      const batchDir = join(h.stagingRoot, batchId);
      await mkdir(batchDir, { recursive: true });
      const parentPayload = {
        parentBatchId,
        parentPin: { id: 'pin-x' },
        parentTaskPath: 'tasks/inspector-parent-1',
        childBatchId: batchId,
        failureSummary: 'Orchestrator could not parse plan.',
        failedTaskPath: 'tasks/inspector-parent-1',
      };
      await writeFile(
        join(batchDir, 'parent.json'),
        `${JSON.stringify(parentPayload, null, 2)}\n`,
      );

      const batch = await seedBatch(h, batchId, 1, parentBatchId);
      h.service.emit('batch.submitted', { batch });

      await waitFor(() => h.engine.invocations.length === 1);
      const invocation = h.engine.invocations[0];
      expect(invocation.mode).toBe('inspector-clarify');

      const rawParentContext = invocation.modeArgs?.parentContext;
      expect(typeof rawParentContext).toBe('string');
      const parsed = JSON.parse(rawParentContext as string);
      expect(parsed.failureSummary).toBe('Orchestrator could not parse plan.');
      expect(parsed.failedTaskPath).toBe('tasks/inspector-parent-1');
      expect(parsed.parentBatchId).toBe(parentBatchId);
    } finally {
      await cleanup(h);
    }
  });
});
