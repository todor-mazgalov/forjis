/**
 * Unit tests for wireInspectorMessagePump (inspector-003).
 *
 * Validates FR-005, FR-007, and FR-008 of the
 * `inspector-003-inspector-service` spec: correct dispatch of every inbound
 * client-to-server frame, `pin.ack` / `task.status` unicast acks on success,
 * `session.error { CONCURRENT_BATCH }` translation from ConcurrentBatchError,
 * `session.error { INTERNAL }` translation from unrelated exceptions, and
 * the "drop server-to-client frames silently" rule.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  InspectorMessage,
  InspectorService,
  InspectorTransport,
  Pin,
} from '@forjis/shared';

import { InspectorServiceImpl } from '../inspector-service.js';
import { wireInspectorMessagePump } from '../inspector-message-pump.js';

/**
 * Minimal fake {@link InspectorTransport} for unit tests.
 *
 * Captures the registered `onMessage` handler, records every outbound
 * `send` call for later assertion, and exposes a synchronous
 * {@link simulateInbound} helper that invokes the handler as the real
 * WebSocket layer would. `broadcast`, `onConnect`, and `onDisconnect` are
 * intentional no-ops — the pump under test must never touch them.
 */
class FakeInspectorTransport implements InspectorTransport {
  /** Registered inbound message handler, populated by {@link onMessage}. */
  private handler: ((clientId: string, msg: InspectorMessage) => void) | null = null;

  /** Every outbound frame recorded in call order. */
  public readonly sent: Array<{ clientId: string; msg: InspectorMessage }> = [];

  onConnect(): void {
    // No-op — unused by the pump.
  }

  onMessage(handler: (clientId: string, msg: InspectorMessage) => void): void {
    this.handler = handler;
  }

  onDisconnect(): void {
    // No-op — unused by the pump.
  }

  send(clientId: string, msg: InspectorMessage): void {
    this.sent.push({ clientId, msg });
  }

  broadcast(): void {
    throw new Error('broadcast must not be called by the pump');
  }

  /**
   * Deliver an inbound frame and wait for the pump's async handler to settle.
   *
   * @param clientId - Simulated originating client id.
   * @param msg - Message to deliver to the pump.
   */
  async simulateInbound(clientId: string, msg: InspectorMessage): Promise<void> {
    if (this.handler === null) {
      throw new Error('onMessage handler was never registered');
    }
    // The pump's handler is async; await a microtask tick to let its
    // promise chain finish before tests assert on `sent`.
    await this.handler(clientId, msg);
  }
}

/** Build a minimal inbound pin with base64 capture payloads. */
function makePin(id: string): Pin {
  const zero = Buffer.from([0]).toString('base64');
  return {
    id,
    platform: 'web',
    screen: '/login',
    target: {
      kind: 'element',
      source: null,
      selector: `#${id}`,
      componentName: null,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    },
    capture: {
      elementScreenshot: zero,
      viewportScreenshot: zero,
      computedStyles: zero,
      annotations: [],
    },
    comment: '',
    createdAt: '2026-04-21T00:00:00.000Z',
    parentPinId: null,
  };
}

describe('wireInspectorMessagePump', () => {
  let tmpProjectDir: string;
  let stagingRoot: string;
  let service: InspectorServiceImpl;
  let transport: FakeInspectorTransport;

  beforeEach(async () => {
    tmpProjectDir = await mkdtemp(join(tmpdir(), 'forjis-inspector-pump-'));
    stagingRoot = join(tmpProjectDir, '.forjis', 'inspector');
    service = new InspectorServiceImpl({ projectDir: tmpProjectDir, stagingRoot });
    transport = new FakeInspectorTransport();
    wireInspectorMessagePump(transport, service);
  });

  afterEach(async () => {
    await rm(tmpProjectDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // FR-007
  // ------------------------------------------------------------------

  it('auto-adopts a never-seen batchId on pin.create and sends pin.ack', async () => {
    // inspector-016 regression: the browser SDK generates `batchId`
    // client-side on the first captured pin. Before this fix, the pump
    // called `addPin` directly, which threw `Unknown batch id`. The pump
    // now adopts lazily, so a `pin.create` with a fresh id MUST succeed.
    const pin = makePin('first-pin');

    await transport.simulateInbound('client-1', {
      type: 'pin.create',
      batchId: 'client-generated-A',
      pin,
    });

    expect(transport.sent).toEqual([
      { clientId: 'client-1', msg: { type: 'pin.ack', pinId: 'first-pin' } },
    ]);

    const stored = await service.getBatch('client-generated-A');
    expect(stored).not.toBeNull();
    expect(stored?.pins).toHaveLength(1);
    expect(stored?.pins[0].id).toBe('first-pin');
    expect(stored?.platform).toBe('web');
  });

  it('rejects pin.create with session.error { CONCURRENT_BATCH } while another batch is clarifying', async () => {
    // inspector-016 guardrail: adoption inherits the concurrent-batch
    // guard, so a second, never-seen batchId arriving as a `pin.create`
    // while batch A is still clarifying must surface CONCURRENT_BATCH
    // and must NOT silently adopt.
    const firstBatch = await service.createBatch('web');
    await service.submitBatch(firstBatch.id);

    await transport.simulateInbound('client-2', {
      type: 'pin.create',
      batchId: 'new-client-batch',
      pin: makePin('pin-blocked'),
    });

    expect(transport.sent).toHaveLength(1);
    const frame = transport.sent[0];
    expect(frame.clientId).toBe('client-2');
    expect(frame.msg.type).toBe('session.error');
    if (frame.msg.type === 'session.error') {
      expect(frame.msg.code).toBe('CONCURRENT_BATCH');
    }

    // No silent adoption: the rejected batchId MUST NOT appear in the
    // service registry.
    const leaked = await service.getBatch('new-client-batch');
    expect(leaked).toBeNull();
  });

  it('dispatches pin.create to addPin and sends pin.ack to the originating client', async () => {
    const batch = await service.createBatch('web');
    const pin = makePin('pin-x');

    await transport.simulateInbound('client-1', {
      type: 'pin.create',
      batchId: batch.id,
      pin,
    });

    expect(transport.sent).toEqual([
      { clientId: 'client-1', msg: { type: 'pin.ack', pinId: 'pin-x' } },
    ]);

    const stored = await service.getBatch(batch.id);
    expect(stored?.pins).toHaveLength(1);
    expect(stored?.pins[0].id).toBe('pin-x');
  });

  it('dispatches batch.submit and sends task.status { clarifying } to the originating client', async () => {
    const batch = await service.createBatch('web');
    await service.addPin(batch.id, makePin('pin-x'));

    await transport.simulateInbound('client-1', {
      type: 'batch.submit',
      batchId: batch.id,
    });

    expect(transport.sent).toEqual([
      {
        clientId: 'client-1',
        msg: { type: 'task.status', batchId: batch.id, status: 'clarifying' },
      },
    ]);
  });

  it('dispatches clarify.answer without sending any outbound frame', async () => {
    const batch = await service.createBatch('web');

    await transport.simulateInbound('client-1', {
      type: 'clarify.answer',
      batchId: batch.id,
      answer: { questionId: 'q1', optionId: 'a', freeText: null },
    });

    expect(transport.sent).toEqual([]);
  });

  it('dispatches reply.create to replyToPin and sends pin.ack to the originating client', async () => {
    const parentBatch = await service.createBatch('web');
    const parentPin = makePin('parent');
    await service.addPin(parentBatch.id, parentPin);

    await transport.simulateInbound('client-1', {
      type: 'reply.create',
      parentPinId: parentPin.id,
      pin: makePin('reply'),
      comment: 'nit',
    });

    expect(transport.sent).toEqual([
      { clientId: 'client-1', msg: { type: 'pin.ack', pinId: 'reply' } },
    ]);
  });

  it('drops inbound server-to-client frames silently', async () => {
    const batch = await service.createBatch('web');

    await transport.simulateInbound('client-1', {
      type: 'task.status',
      batchId: batch.id,
      status: 'running',
    });
    await transport.simulateInbound('client-1', {
      type: 'pin.ack',
      pinId: 'stray',
    });
    await transport.simulateInbound('client-1', {
      type: 'session.ack',
      sessionId: 'x',
      protocolVersion: 'forjis-inspector/1.0',
    });
    await transport.simulateInbound('client-1', {
      type: 'session.error',
      code: 'x',
      message: 'y',
    });
    await transport.simulateInbound('client-1', {
      type: 'clarify.question',
      batchId: batch.id,
      question: { id: 'q', text: 't', options: [], allowFreeText: false },
    });
    await transport.simulateInbound('client-1', {
      type: 'batch.finalize',
      batchId: batch.id,
      taskPath: 'tasks/foo',
    });

    expect(transport.sent).toEqual([]);

    const stored = await service.getBatch(batch.id);
    expect(stored?.status).toBe('queued');
    expect(stored?.pins).toEqual([]);
  });

  // ------------------------------------------------------------------
  // FR-005 + FR-008
  // ------------------------------------------------------------------

  it('translates ConcurrentBatchError to session.error { CONCURRENT_BATCH }', async () => {
    const first = await service.createBatch('web');
    const second = await service.createBatch('web');

    await transport.simulateInbound('client-1', {
      type: 'batch.submit',
      batchId: first.id,
    });
    // Clear the success ack for the first submit so we only inspect the second.
    transport.sent.length = 0;

    await transport.simulateInbound('client-2', {
      type: 'batch.submit',
      batchId: second.id,
    });

    expect(transport.sent).toHaveLength(1);
    const frame = transport.sent[0];
    expect(frame.clientId).toBe('client-2');
    expect(frame.msg.type).toBe('session.error');
    if (frame.msg.type === 'session.error') {
      expect(frame.msg.code).toBe('CONCURRENT_BATCH');
      expect(typeof frame.msg.message).toBe('string');
      expect(frame.msg.message.length).toBeGreaterThan(0);
    }
  });

  it('translates arbitrary service exceptions to session.error { INTERNAL }', async () => {
    // Stub service whose addPin always throws a plain Error.
    const stubService: InspectorService = {
      createBatch: async () => {
        throw new Error('unused');
      },
      adoptExternalBatch: async () => {
        // Resolve so the pump proceeds to `addPin`, which is the throw
        // path this test exercises.
        return {
          id: 'b1',
          platform: 'web',
          screens: [],
          pins: [],
          createdAt: '2026-04-22T00:00:00.000Z',
          parentBatchId: null,
          status: 'queued',
        };
      },
      addPin: async () => {
        throw new Error('boom');
      },
      submitBatch: async () => {
        throw new Error('unused');
      },
      answerClarify: async () => {
        throw new Error('unused');
      },
      replyToPin: async () => {
        throw new Error('unused');
      },
      getBatch: async () => null,
      listBatches: async () => [],
    };

    const stubTransport = new FakeInspectorTransport();
    wireInspectorMessagePump(stubTransport, stubService);

    await stubTransport.simulateInbound('client-1', {
      type: 'pin.create',
      batchId: 'b1',
      pin: makePin('pin-err'),
    });

    expect(stubTransport.sent).toEqual([
      {
        clientId: 'client-1',
        msg: { type: 'session.error', code: 'INTERNAL', message: 'boom' },
      },
    ]);
  });

  it('does not rethrow exceptions thrown by the service', async () => {
    const first = await service.createBatch('web');
    const second = await service.createBatch('web');

    await transport.simulateInbound('client-1', {
      type: 'batch.submit',
      batchId: first.id,
    });

    // A throw from simulateInbound would surface as an unhandled rejection.
    await expect(
      transport.simulateInbound('client-2', {
        type: 'batch.submit',
        batchId: second.id,
      }),
    ).resolves.toBeUndefined();
  });
});
