/**
 * Supplementary backend tests for {@link InspectorClarifierRunner} that
 * cover scenarios specified in `specs/inspector-clarifier-orchestration/spec.md`
 * which are not already exercised by the primary test file.
 *
 * Each test uses the same fake-engine / fake-transport harness pattern as
 * `inspector-clarifier-runner.test.ts` but isolates a single spec
 * scenario. Nothing here spawns a real subprocess or touches the
 * network.
 *
 * Scenarios covered:
 *
 * - Parent context is forwarded via modeArgs when parent.json exists for
 *   a reply batch (spec: "Runner subscribes to batch submission" →
 *   "Parent context is forwarded").
 * - A `clarify.answer` arriving after the run has finalised is silently
 *   dropped rather than raising (spec: "Runner forwards clarify answers
 *   to the subprocess" → "Answer arrives after finalize").
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
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
 * Scriptable fake engine mirroring the one used by the primary test file.
 */
class FakeForjisEngine implements ForjisEngine {
  readonly name = 'fake';
  readonly invocations: EngineInvokeOptions[] = [];
  readonly injections: Array<{ taskId: string; text: string }> = [];
  private resolveInvoke: ((result: EngineResult) => void) | null = null;

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
    this.injections.push({ taskId, text });
    return Promise.resolve();
  }

  /** Emit a stream-json assistant turn carrying the supplied JSON payload. */
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

function buildPin(batchId: string, index: number, parentPinId: string | null = null): Pin {
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
    parentPinId,
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
    options: [
      { id: 'a', label: 'Option A', description: 'First choice' },
      { id: 'b', label: 'Option B', description: 'Second choice' },
    ],
    allowFreeText: true,
  };
}

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
  projectDir: string;
  stagingRoot: string;
  configDir: string;
}

async function buildHarness(): Promise<Harness> {
  const projectDir = await mkdtemp(join(tmpdir(), 'forjis-clarifier-scenarios-'));
  const stagingRoot = join(projectDir, '.forjis', 'inspector');
  const configDir = join(projectDir, '.forjis', 'config');
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });

  const engine = new FakeForjisEngine();
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

  return { engine, service, transport, sent, runner, projectDir, stagingRoot, configDir };
}

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
    await writeFile(join(batchDir, `pin-${pinIndex}-element.png`), Buffer.from([0x89, 0x50]));
    await writeFile(join(batchDir, `pin-${pinIndex}-styles.json`), '{"color":"red"}');
  }
  const batch = buildBatch(batchId, pinCount, parentBatchId);
  (h.service as unknown as { batches: Map<string, Batch> }).batches.set(batch.id, batch);
  return batch;
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

describe('InspectorClarifierRunner — parent context forwarding', () => {
  it('includes parsed parentContext in modeArgs when parent.json exists', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-with-parent';
      const parentBatchId = 'batch-parent-7';

      // Stage the parent.json payload the facilitator would have
      // written inside the child batch's staging directory via
      // `InspectorServiceImpl.replyToPin`.
      const batchDir = join(h.stagingRoot, batchId);
      await mkdir(batchDir, { recursive: true });
      const parentPayload = {
        parentBatchId,
        parentPin: { id: 'pin-x' },
        parentTaskPath: null,
        childBatchId: batchId,
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

      // The runner stringifies the parent context object before
      // inserting it into modeArgs.
      const rawParentContext = invocation.modeArgs?.parentContext;
      expect(typeof rawParentContext).toBe('string');
      const parsed = JSON.parse(rawParentContext as string);
      expect(parsed.parentBatchId).toBe(parentBatchId);
      expect(parsed.parentPin.id).toBe('pin-x');
    } finally {
      await cleanup(h);
    }
  });

  it('omits parentContext when the batch has no parent', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-no-parent';
      const batch = await seedBatch(h, batchId, 1);
      h.service.emit('batch.submitted', { batch });

      await waitFor(() => h.engine.invocations.length === 1);
      const invocation = h.engine.invocations[0];
      expect(invocation.modeArgs?.parentContext).toBeUndefined();
    } finally {
      await cleanup(h);
    }
  });
});

describe('InspectorClarifierRunner — answer after finalize', () => {
  it('silently drops clarify.answer after the run has finalised', async () => {
    const h = await buildHarness();
    try {
      const batchId = 'batch-late-answer';
      const batch = await seedBatch(h, batchId, 1);

      h.service.emit('batch.submitted', { batch });
      await waitFor(() => h.engine.invocations.length === 1);

      // Drive one Q/A cycle so the originating client is recorded.
      h.engine.emitAssistantJson({ type: 'question', question: makeQuestion('q-1') });
      await h.service.answerClarifyWithClient(batchId, makeAnswer('q-1'), 'client-late');
      await waitFor(() => h.engine.injections.length === 1);

      // Terminate via finalize.
      h.engine.emitAssistantJson({
        type: 'finalize',
        taskDir: 'tasks/inspector-late',
        taskMd: '# Inspector late\n\nBody.\n',
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
      await waitFor(() => h.runner.activeRunCount() === 0);

      const injectionsBefore = h.engine.injections.length;

      // Deliver a late answer. The runner must not throw, not inject,
      // and not re-emit a finalize frame.
      await expect(
        h.service.answerClarifyWithClient(batchId, makeAnswer('q-1'), 'client-late'),
      ).resolves.toBeUndefined();

      await new Promise((resolve) => setImmediate(resolve));

      expect(h.engine.injections.length).toBe(injectionsBefore);
      const finalizeFrames = h.sent.filter((f) => f.msg.type === 'batch.finalize');
      expect(finalizeFrames).toHaveLength(1);
    } finally {
      await cleanup(h);
    }
  });
});
