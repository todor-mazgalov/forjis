/**
 * Unit tests for {@link InspectorClarifierRunner}.
 *
 * Scenarios covered:
 *
 * - Happy-path submit → question → answer → finalize flow.
 * - Turn-limit guardrail: 10 questions, then synthetic hint, then
 *   finalize proceeds.
 * - Abort via `freeText === "__abort__"` sentinel.
 * - Abort via the `batch.abort` inspector message.
 * - Engine-capability error surfaced as
 *   `session.error { code: "ENGINE_UNSUPPORTED" }`.
 * - Malformed assistant JSON is dropped, valid questions still flow.
 * - Token-budget breach injects the `"budget.exceeded"` hint and drops
 *   further questions.
 *
 * Each test uses a {@link FakeForjisEngine} that records the engine
 * invocation options and exposes an `emitAssistantJson` hook so the
 * test can script the subprocess's stream-json output without spawning
 * a real Claude CLI.
 */

import { mkdtemp, rm, writeFile, readFile, stat, readdir, mkdir } from 'node:fs/promises';
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
import { InspectorServiceImpl } from '../web-services/inspector-service.js';
import { TokenTracker } from '../token-tracker.js';
import type { TaskEvent } from '../types.js';

// -- Fakes ------------------------------------------------------------------

/**
 * Captures the arguments passed to {@link InspectorTransport.send}.
 * Exposes a `sent` array the test can assert against.
 */
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

/**
 * Scriptable fake engine.
 *
 * `invoke` records the options and exposes an `emitAssistantJson`
 * method the test calls to simulate the subprocess emitting a
 * `{"type":"question"|"finalize", ...}` line on stdout. `onUserMessage`
 * records each injection in `injections`.
 *
 * The engine's invoke promise never resolves on its own — tests call
 * `finishInvoke()` to simulate the subprocess exiting cleanly.
 */
class FakeForjisEngine implements ForjisEngine {
  readonly name = 'fake';
  readonly invocations: EngineInvokeOptions[] = [];
  readonly injections: Array<{ taskId: string; text: string }> = [];
  private resolveInvoke: ((result: EngineResult) => void) | null = null;
  supportOnUserMessage = true;

  async checkPrerequisites(): Promise<string> {
    return 'ok';
  }

  invoke(options: EngineInvokeOptions): Promise<EngineResult> {
    this.invocations.push(options);
    return new Promise<EngineResult>((resolve) => {
      this.resolveInvoke = resolve;
    });
  }

  async cleanup(): Promise<void> {
    /* no-op */
  }

  async prompt(): Promise<string> {
    return '';
  }

  onUserMessage(taskId: string, text: string): Promise<void> {
    if (!this.supportOnUserMessage) {
      throw new Error('onUserMessage not implemented by fake');
    }
    this.injections.push({ taskId, text });
    return Promise.resolve();
  }

  /**
   * Simulate the subprocess emitting a stream-json assistant turn
   * carrying the supplied JSON payload.
   *
   * The adapter's real `formatEvent` produces `[THINK] <text>...`, so
   * we mirror that shape exactly to exercise the runner's parser.
   *
   * @param payload - JSON payload the clarifier would have emitted.
   */
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

  /** Resolve the pending `invoke` promise as a successful subprocess exit. */
  finishInvoke(): void {
    if (this.resolveInvoke) {
      const options = this.invocations[this.invocations.length - 1];
      this.resolveInvoke({ exitCode: 0, taskId: options?.taskId ?? '', stage: null });
      this.resolveInvoke = null;
    }
  }
}

/**
 * Stubbed clarifier persona used by every test. The body is tiny so
 * the test can assert it is forwarded verbatim in `modeArgs`.
 */
function stubPersona(): ClarifierAgent {
  return {
    name: 'forjis-inspector',
    description: 'Clarifier persona',
    model: 'sonnet',
    tools: ['Read', 'Write', 'Glob'],
    body: '# Clarifier body',
    sourcePath: '/fake/path.md',
  };
}

/**
 * Build a pin that mirrors the shape the facilitator would persist for
 * a client-submitted capture. Rewritten `capture.*` fields point at
 * the staged files inside the batch dir.
 */
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

/**
 * Build a fully-populated batch in status `clarifying`, with `count`
 * pins attached. Matches the in-memory shape `InspectorServiceImpl`
 * would produce after `submitBatch`.
 */
function buildBatch(batchId: string, count: number): Batch {
  const pins: Pin[] = [];
  for (let i = 1; i <= count; i++) {
    pins.push(buildPin(batchId, i));
  }
  return {
    id: batchId,
    platform: 'web',
    screens: ['home'],
    pins,
    createdAt: '2026-04-21T12:00:00.000Z',
    parentBatchId: null,
    status: 'clarifying',
  };
}

/** Canonical clarify question used by multiple tests. */
function makeQuestion(id: string): ClarifyQuestion {
  return {
    id,
    text: `Question ${id}?`,
    options: [
      { id: 'a', label: 'Option A', description: 'First choice' },
      { id: 'b', label: 'Option B', description: 'Second choice' },
    ],
    allowFreeText: true,
  };
}

/** Canonical clarify answer used by multiple tests. */
function makeAnswer(questionId: string, freeText: string | null = null): ClarifyAnswer {
  return {
    questionId,
    optionId: freeText === null ? 'a' : null,
    freeText,
  };
}

interface Harness {
  engine: FakeForjisEngine;
  service: InspectorServiceImpl;
  transport: InspectorTransport;
  sent: Array<{ clientId: string; msg: InspectorMessage }>;
  runner: InspectorClarifierRunner;
  tracker: TokenTracker;
  projectDir: string;
  stagingRoot: string;
  configDir: string;
}

/** Build a harness and seed the filesystem layout under a fresh tmpdir. */
async function buildHarness(options: {
  tokenBudget?: { maxTokens: number } | null;
  maxTurns?: number;
  preloadTokens?: number;
} = {}): Promise<Harness> {
  const projectDir = await mkdtemp(join(tmpdir(), 'forjis-clarifier-runner-'));
  const stagingRoot = join(projectDir, '.forjis', 'inspector');
  const configDir = join(projectDir, '.forjis', 'config');
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });

  const engine = new FakeForjisEngine();
  const service = new InspectorServiceImpl({ projectDir, stagingRoot });
  const { transport, sent } = createFakeTransport();
  const tracker = new TokenTracker();
  if (options.preloadTokens && options.preloadTokens > 0) {
    tracker.recordUsage(options.preloadTokens, 0);
  }

  const runner = new InspectorClarifierRunner({
    engine,
    service,
    transport,
    tokenTracker: tracker,
    personaLoader: () => stubPersona(),
    projectDir,
    configDir,
    stagingRoot,
    tokenBudget: options.tokenBudget === undefined ? null : options.tokenBudget,
    maxTurns: options.maxTurns,
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

/**
 * Stage a batch inside the service's in-memory map so `submitBatch`
 * has something to emit for. Writes the pin files to disk so the
 * finalise flow can rename them into the task directory.
 *
 * @param h - Harness.
 * @param batchId - Identifier used for both the staging dir and the
 *   batch record.
 * @param pinCount - Number of pins to seed.
 * @returns The seeded batch record.
 */
async function seedBatch(h: Harness, batchId: string, pinCount: number): Promise<Batch> {
  const batchDir = join(h.stagingRoot, batchId);
  await mkdir(batchDir, { recursive: true });
  for (let i = 1; i <= pinCount; i++) {
    const pinIndex = String(i).padStart(2, '0');
    await writeFile(join(batchDir, `pin-${pinIndex}-element.png`), Buffer.from([0x89, 0x50]));
    await writeFile(join(batchDir, `pin-${pinIndex}-styles.json`), '{"color":"red"}');
  }
  const batch = buildBatch(batchId, pinCount);
  // Inject directly into the service's registry so we can skip the
  // full client roundtrip while still exercising the event emitter
  // path the runner subscribes to.
  (h.service as unknown as { batches: Map<string, Batch> }).batches.set(batch.id, batch);
  return batch;
}

/**
 * Waits until `predicate` returns true or a small timeout elapses.
 *
 * Runner work happens across several microtask turns (engine invoke
 * resolution, buffered-answer flushes), so tests need a short poll
 * loop rather than a single `await`.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function cleanup(h: Harness): Promise<void> {
  await h.runner.stop();
  await rm(h.projectDir, { recursive: true, force: true });
}

// -- Tests ------------------------------------------------------------------

describe('InspectorClarifierRunner — happy path', () => {
  it('submits a 2-pin batch and finalises via one Q/A exchange', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-happy-1';
      const batch = await seedBatch(h, batchId, 2);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      const invocation = h.engine.invocations[0];
      expect(invocation.mode).toBe('inspector-clarify');
      const pinsArg = invocation.modeArgs?.pins;
      expect(typeof pinsArg).toBe('string');
      expect(JSON.parse(pinsArg as string)).toHaveLength(2);
      expect(invocation.taskId).toBe(batchId);

      const question = makeQuestion('q-1');
      h.engine.emitAssistantJson({ type: 'question', question });

      // Let the runner's sync processing settle; no client id is known
      // yet, so no `clarify.question` frame should have been sent.
      await new Promise((resolve) => setImmediate(resolve));
      const earlyQuestionFrames = h.sent.filter((f) => f.msg.type === 'clarify.question');
      expect(earlyQuestionFrames).toHaveLength(0);

      const answer = makeAnswer('q-1');
      await h.service.answerClarifyWithClient(batchId, answer, 'client-1');
      await waitFor(() => h.engine.injections.length === 1);
      expect(h.engine.injections[0].taskId).toBe(batchId);
      expect(JSON.parse(h.engine.injections[0].text)).toEqual(answer);

      // Second question so we can confirm the originating client is
      // used once the runner learns of it.
      const question2 = makeQuestion('q-2');
      h.engine.emitAssistantJson({ type: 'question', question: question2 });
      await waitFor(() => h.sent.some((f) => f.msg.type === 'clarify.question'));
      const secondRoundFrames = h.sent.filter((f) => f.msg.type === 'clarify.question');
      expect(secondRoundFrames).toHaveLength(1);
      expect(secondRoundFrames[0].clientId).toBe('client-1');

      h.engine.emitAssistantJson({
        type: 'finalize',
        taskDir: 'tasks/inspector-happy',
        taskMd: '# Inspector happy\n\nBody.\n',
        metadata: {
          source: 'inspector',
          batchId,
          parentBatchId: null,
          platform: 'web',
          screens: ['home'],
          pinCount: 2,
          protocolVersion: 'forjis-inspector/1.0',
        },
      });

      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));

      const taskDir = join(h.projectDir, 'tasks/inspector-happy');
      const taskMd = await readFile(join(taskDir, 'TASK.md'), 'utf-8');
      expect(taskMd).toContain('Inspector happy');

      const metadataText = await readFile(join(taskDir, 'metadata.json'), 'utf-8');
      expect(JSON.parse(metadataText).source).toBe('inspector');

      const transcript = await readFile(join(taskDir, 'chat-transcript.md'), 'utf-8');
      expect(transcript).toContain('Question q-1?');
      expect(transcript).toContain('optionId=a');

      const pinStat = await stat(join(taskDir, 'pin-01-element.png'));
      expect(pinStat.isFile()).toBe(true);

      const finalizeFrames = h.sent.filter((f) => f.msg.type === 'batch.finalize');
      expect(finalizeFrames).toHaveLength(1);

      await expect(stat(join(h.stagingRoot, batchId))).rejects.toThrow();
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — turn limit', () => {
  it('injects a synthetic hint after maxTurns questions, then finalises', async () => {
    const h = await buildHarness({ maxTurns: 3 });
    try {
      const batchId = 'batch-turn-limit';
      const batch = await seedBatch(h, batchId, 1);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      for (let i = 1; i <= 3; i++) {
        h.engine.emitAssistantJson({
          type: 'question',
          question: makeQuestion(`q-${i}`),
        });
        await h.service.answerClarifyWithClient(
          batchId,
          makeAnswer(`q-${i}`),
          'client-1',
        );
        await waitFor(() => h.engine.injections.length === i);
      }

      // Fourth question should trigger the turn-limit hint instead of
      // being forwarded to the transport.
      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-4'),
      });
      await waitFor(
        () =>
          h.engine.injections.some((inj) => inj.text.includes('turn limit')),
        1000,
      );
      const limitInjection = h.engine.injections.find((inj) =>
        inj.text.includes('turn limit'),
      );
      expect(limitInjection?.taskId).toBe(batchId);

      h.engine.emitAssistantJson({
        type: 'finalize',
        taskDir: 'tasks/inspector-turn-limit',
        taskMd: '# Inspector turn-limit\n\n## Assumptions\n\n- best-effort.\n',
        metadata: {
          source: 'inspector',
          batchId,
          parentBatchId: null,
          platform: 'web',
          screens: ['home'],
          pinCount: 1,
          protocolVersion: 'forjis-inspector/1.0',
        },
      });

      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));

      const taskMd = await readFile(
        join(h.projectDir, 'tasks/inspector-turn-limit/TASK.md'),
        'utf-8',
      );
      expect(taskMd).toContain('## Assumptions');
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — abort via sentinel', () => {
  it('aborts, writes an ## Assumptions task file, and emits batch.finalize', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-abort-sentinel';
      const batch = await seedBatch(h, batchId, 1);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-1'),
      });

      await h.service.answerClarifyWithClient(
        batchId,
        makeAnswer('q-1', '__abort__'),
        'client-1',
      );

      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));

      const finalizeFrame = h.sent.find((f) => f.msg.type === 'batch.finalize');
      expect(finalizeFrame?.clientId).toBe('client-1');

      const taskPath = (finalizeFrame!.msg as { taskPath: string }).taskPath;
      const taskMd = await readFile(
        join(h.projectDir, taskPath, 'TASK.md'),
        'utf-8',
      );
      expect(taskMd).toContain('## Assumptions');
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — abort via batch.abort message', () => {
  it('terminates the run and finalises with assumptions', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-abort-message';
      const batch = await seedBatch(h, batchId, 1);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-1'),
      });
      // Answer so the runner learns the client id.
      await h.service.answerClarifyWithClient(batchId, makeAnswer('q-1'), 'client-9');
      await waitFor(() => h.engine.injections.length === 1);

      await h.service.abortBatch(batchId, 'client-9');

      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));
      const finalizeFrame = h.sent.find((f) => f.msg.type === 'batch.finalize');
      expect(finalizeFrame?.clientId).toBe('client-9');

      const taskPath = (finalizeFrame!.msg as { taskPath: string }).taskPath;
      const taskMd = await readFile(
        join(h.projectDir, taskPath, 'TASK.md'),
        'utf-8',
      );
      expect(taskMd).toContain('## Assumptions');
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — engine capability error', () => {
  it('emits ENGINE_UNSUPPORTED when the engine lacks onUserMessage', async () => {
    // Build a custom harness wired to a minimal engine that never
    // implements `onUserMessage`. Matches the failure mode an engine
    // adapter would exhibit if it forgot the capability.
    const projectDir = await mkdtemp(join(tmpdir(), 'forjis-cap-'));
    const stagingRoot = join(projectDir, '.forjis', 'inspector');
    const configDir = join(projectDir, '.forjis', 'config');
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(configDir, { recursive: true });

    const engineInvocations: EngineInvokeOptions[] = [];
    let capturedOnEvent: ((event: TaskEvent) => void) | undefined;

    const minimalEngine: ForjisEngine = {
      name: 'minimal',
      checkPrerequisites: async () => 'ok',
      invoke: (options) => {
        engineInvocations.push(options);
        capturedOnEvent = options.onEvent;
        return new Promise<EngineResult>(() => {
          /* never resolves — mimics an alive subprocess */
        });
      },
      cleanup: async () => {},
      prompt: async () => '',
    };

    const service = new InspectorServiceImpl({ projectDir, stagingRoot });
    const { transport, sent } = createFakeTransport();
    const tracker = new TokenTracker();
    const runner = new InspectorClarifierRunner({
      engine: minimalEngine,
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

    try {
      const batchId = 'batch-unsupported';
      const batchDir = join(stagingRoot, batchId);
      await mkdir(batchDir, { recursive: true });
      const batch = buildBatch(batchId, 1);
      (service as unknown as { batches: Map<string, Batch> }).batches.set(batch.id, batch);

      service.emit('batch.submitted', { batch });
      await waitFor(() => engineInvocations.length === 1);

      // Emit a question so the runner knows the subprocess is alive,
      // then deliver an answer — that is when injection is attempted.
      capturedOnEvent?.({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        role: 'orchestrator',
        content: `[THINK] ${JSON.stringify({
          type: 'question',
          question: makeQuestion('q-1'),
        })}...`,
      });
      await service.answerClarifyWithClient(
        batchId,
        makeAnswer('q-1'),
        'client-u',
      );

      await waitFor(() =>
        sent.some(
          (f) =>
            f.msg.type === 'session.error' &&
            (f.msg as { code: string }).code === 'ENGINE_UNSUPPORTED',
        ),
      );
    } finally {
      await runner.stop();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe('InspectorClarifierRunner — malformed stdout', () => {
  it('drops malformed lines but still forwards valid questions', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-malformed';
      const batch = await seedBatch(h, batchId, 1);
      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      const invocation = h.engine.invocations[0];
      // Inject a raw non-JSON line via the engine's onEvent callback.
      invocation.onEvent?.({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        role: 'orchestrator',
        content: '[THINK] not-json at all...',
      });

      // The runner must still accept subsequent valid questions.
      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-1'),
      });
      await h.service.answerClarifyWithClient(batchId, makeAnswer('q-1'), 'c');
      await waitFor(() => h.engine.injections.length === 1);

      // The subprocess was never killed.
      expect(h.runner.activeRunCount()).toBe(1);
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — budget breach', () => {
  it('injects budget.exceeded after a question when the tracker is over budget', async () => {
    const h = await buildHarness({
      tokenBudget: { maxTokens: 100 },
      preloadTokens: 200,
    });
    try {
      const batchId = 'batch-budget';
      const batch = await seedBatch(h, batchId, 1);
      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-1'),
      });
      await waitFor(() =>
        h.engine.injections.some((inj) => inj.text === 'budget.exceeded'),
      );

      // A second question should be suppressed after the budget breach.
      const injectionsBefore = h.engine.injections.length;
      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-2'),
      });
      // Give the runner a turn to process.
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.engine.injections.length).toBe(injectionsBefore);

      // Clean up by aborting so the budget timer doesn't linger.
      await h.service.abortBatch(batchId, 'client-b');
      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — lifecycle', () => {
  it('is idempotent across start / stop cycles', async () => {
    const h = await buildHarness();
    try {
      h.runner.start();
      h.runner.start();
      expect(h.runner.activeRunCount()).toBe(0);
      await h.runner.stop();
      await h.runner.stop();
      expect(h.runner.activeRunCount()).toBe(0);
    } finally {
      // buildHarness already called start(); cleanup handles the rest.
      await rm(h.projectDir, { recursive: true, force: true });
    }
  });
});

describe('InspectorClarifierRunner — engine completion without finalize', () => {
  it('synthesises an abort task when the subprocess exits cleanly mid-run', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-engine-exit';
      const batch = await seedBatch(h, batchId, 1);
      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      // Emit one question + answer so the runner knows the client id.
      h.engine.emitAssistantJson({
        type: 'question',
        question: makeQuestion('q-1'),
      });
      await h.service.answerClarifyWithClient(
        batchId,
        makeAnswer('q-1'),
        'client-e',
      );
      await waitFor(() => h.engine.injections.length === 1);

      // Subprocess exits cleanly without ever emitting finalize.
      h.engine.finishInvoke();

      await waitFor(() => h.sent.some((f) => f.msg.type === 'batch.finalize'));
      await waitFor(() => h.runner.activeRunCount() === 0);
      expect(h.runner.activeRunCount()).toBe(0);
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — full-sized assistant payload', () => {
  it('ingests an untruncated assistant JSON line delivered via event.payload', async () => {
    // Regression coverage for inspector-018-fix-3. The Claude adapter
    // caps `event.content` at 200 characters for terminal display, so
    // any realistic clarify question or finalize payload is truncated
    // past that boundary. The fix writes the untruncated text into
    // `event.payload`; this test exercises that exact shape against
    // the runner's `ingestEngineEvent` path.
    const h = await buildHarness();
    try {
      const batchId = 'batch-full-payload';
      const batch = await seedBatch(h, batchId, 1);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      const invocation = h.engine.invocations[0];
      expect(invocation.onEvent).toBeDefined();

      const question: ClarifyQuestion = {
        id: 'q-full',
        // Long enough that the `[THINK] ` + text + `...` preview is
        // truncated well before the JSON closing brace.
        text: `Full-sized question body ${'x'.repeat(500)}?`,
        options: [
          { id: 'a', label: 'Option A', description: 'A'.repeat(200) },
          { id: 'b', label: 'Option B', description: 'B'.repeat(200) },
        ],
        allowFreeText: true,
      };
      const fullJson = JSON.stringify({ type: 'question', question });
      expect(fullJson.length).toBeGreaterThan(200);
      const truncatedPreview = `[THINK] ${fullJson.slice(0, 200)}...`;

      // Answer early so the runner learns the client id — before the
      // first assistant event arrives the answer should be buffered.
      await h.service.answerClarifyWithClient(
        batchId,
        makeAnswer('q-full'),
        'client-full',
      );
      // No engine injection yet — the buffer is waiting on the first
      // assistant-text event to flush.
      expect(h.engine.injections).toHaveLength(0);

      invocation.onEvent!({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        role: 'orchestrator',
        content: truncatedPreview,
        payload: fullJson,
      });

      // The runner must have parsed the JSON (via payload), forwarded
      // the question to the transport, and flushed the buffered answer.
      await waitFor(() => h.sent.some((f) => f.msg.type === 'clarify.question'));
      const questionFrame = h.sent.find((f) => f.msg.type === 'clarify.question');
      expect(questionFrame).toBeDefined();
      expect(questionFrame!.clientId).toBe('client-full');
      expect(
        (questionFrame!.msg as { question: ClarifyQuestion }).question.text,
      ).toBe(question.text);

      await waitFor(() => h.engine.injections.length === 1);
      expect(h.engine.injections[0].taskId).toBe(batchId);
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — initial user turn delivered to engine', () => {
  it('passes batchId and the full pin array through modeArgs on engine.invoke', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-initial-turn';
      const batch = await seedBatch(h, batchId, 3);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      const invocation = h.engine.invocations[0];
      expect(invocation.mode).toBe('inspector-clarify');
      expect(invocation.taskId).toBe(batchId);

      const modeArgs = invocation.modeArgs;
      expect(modeArgs).toBeDefined();
      expect(modeArgs!.batchId).toBe(batchId);

      // batchDir points at the staging dir so the orchestrator command
      // can read the staged pins via `Read`/`Glob`.
      expect(typeof modeArgs!.batchDir).toBe('string');
      expect(modeArgs!.batchDir).toBe(join(h.stagingRoot, batchId));

      // pins is JSON-stringified; parsing must yield the three pins
      // the batch was seeded with and each pin must retain its id.
      const pinsArg = modeArgs!.pins;
      expect(typeof pinsArg).toBe('string');
      const pins = JSON.parse(pinsArg as string) as Array<{ id: string }>;
      expect(pins).toHaveLength(3);
      expect(pins[0].id).toBe(`pin-${batchId}-01`);
      expect(pins[2].id).toBe(`pin-${batchId}-03`);

      // Persona body is forwarded verbatim so the orchestrator command
      // can render it as the system prompt.
      expect(modeArgs!.personaBody).toBe('# Clarifier body');
    } finally {
      await cleanup(h);
    }
  });
});
