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
  private handler: ((clientId: string, msg: InspectorMessage) => unknown) | null = null;

  /** Registered disconnect handler, populated by {@link onDisconnect}. */
  private disconnectHandler: ((clientId: string) => void) | null = null;

  /** Every outbound frame recorded in call order. */
  public readonly sent: Array<{ clientId: string; msg: InspectorMessage }> = [];

  onConnect(): void {
    // No-op — unused by the pump.
  }

  onMessage(handler: (clientId: string, msg: InspectorMessage) => void): void {
    // Store with an `unknown` return type so `simulateInbound` can await a
    // promise returned by the pump's handler (test-only flushing hook —
    // production callers treat the handler as void-returning).
    this.handler = handler as (clientId: string, msg: InspectorMessage) => unknown;
  }

  onDisconnect(handler: (clientId: string) => void): void {
    this.disconnectHandler = handler;
  }

  send(clientId: string, msg: InspectorMessage): void {
    this.sent.push({ clientId, msg });
  }

  broadcast(): void {
    throw new Error('broadcast must not be called by the pump');
  }

  /**
   * Deliver an inbound frame without waiting for dispatch to settle.
   *
   * Returns the tail promise the pump returns so tests can choose to await
   * it or race another dispatch against it.
   *
   * @param clientId - Simulated originating client id.
   * @param msg - Message to deliver to the pump.
   */
  deliverInbound(clientId: string, msg: InspectorMessage): Promise<void> {
    if (this.handler === null) {
      throw new Error('onMessage handler was never registered');
    }
    const result = this.handler(clientId, msg);
    return result instanceof Promise ? (result as Promise<void>) : Promise.resolve();
  }

  /**
   * Deliver an inbound frame and wait for the pump's dispatch chain to settle.
   *
   * @param clientId - Simulated originating client id.
   * @param msg - Message to deliver to the pump.
   */
  async simulateInbound(clientId: string, msg: InspectorMessage): Promise<void> {
    await this.deliverInbound(clientId, msg);
  }

  /**
   * Invoke the registered disconnect handler, if any.
   *
   * @param clientId - Disconnected client id.
   */
  simulateDisconnect(clientId: string): void {
    if (this.disconnectHandler !== null) {
      this.disconnectHandler(clientId);
    }
  }
}

/**
 * Build a minimal inbound pin with wire-shape capture payloads:
 * a `data:image/png;base64,<body>` data URL for each screenshot (where
 * the decoded body begins with the PNG magic signature, as the server's
 * magic-byte guard requires) and a plain UTF-8 JSON string for
 * `computedStyles`. Matches `buildPin` in
 * `forjis-runtime/inspector/src/pipeline.ts`.
 */
function makePin(id: string): Pin {
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  const pngDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;
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
      elementScreenshot: pngDataUrl,
      viewportScreenshot: pngDataUrl,
      computedStyles: '{}',
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

  // ------------------------------------------------------------------
  // inspector-017-fix-2: per-client FIFO serialization
  // ------------------------------------------------------------------

  describe('per-client FIFO dispatch', () => {
    /**
     * Build a programmable {@link InspectorService} stub that records
     * invocation order and exposes manually-controlled completion for
     * `addPin` and `submitBatch` so tests can interleave frames.
     *
     * @param overrides - Optional partial overrides for stub methods.
     */
    function buildProgrammableService(): {
      service: InspectorService;
      callOrder: string[];
      pendingAddPins: Array<{ resolve: () => void; reject: (err: Error) => void }>;
      pendingSubmits: Array<{ resolve: () => void; reject: (err: Error) => void }>;
    } {
      const callOrder: string[] = [];
      const pendingAddPins: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const pendingSubmits: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const service: InspectorService = {
        createBatch: async () => {
          throw new Error('unused');
        },
        adoptExternalBatch: async (batchId: string, platform) => {
          callOrder.push(`adoptExternalBatch:${batchId}`);
          return {
            id: batchId,
            platform,
            screens: [],
            pins: [],
            createdAt: '2026-04-22T00:00:00.000Z',
            parentBatchId: null,
            status: 'queued',
          };
        },
        addPin: async (batchId: string) => {
          callOrder.push(`addPin:${batchId}`);
          return new Promise<void>((resolve, reject) => {
            pendingAddPins.push({ resolve, reject });
          });
        },
        submitBatch: async (batchId: string) => {
          callOrder.push(`submitBatch:${batchId}`);
          return new Promise<void>((resolve, reject) => {
            pendingSubmits.push({ resolve, reject });
          });
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
      return { service, callOrder, pendingAddPins, pendingSubmits };
    }

    it('serializes pin.create and batch.submit for the same client in FIFO order', async () => {
      // Regression for inspector-017: without per-client FIFO, `batch.submit`
      // raced ahead of the still-pending `addPin` from `pin.create`, and the
      // server replied `session.error INTERNAL Unknown batch id`.
      const stub = buildProgrammableService();
      const stubTransport = new FakeInspectorTransport();
      wireInspectorMessagePump(stubTransport, stub.service);

      const batchId = 'client-generated-fifo';
      const firstFrame = stubTransport.deliverInbound('client-1', {
        type: 'pin.create',
        batchId,
        pin: makePin('pin-fifo'),
      });
      const secondFrame = stubTransport.deliverInbound('client-1', {
        type: 'batch.submit',
        batchId,
      });

      // Let the first frame begin — it should reach `addPin` and stall there.
      // Drain microtasks until addPin has been invoked.
      for (let i = 0; i < 10 && stub.pendingAddPins.length === 0; i++) {
        await Promise.resolve();
      }
      expect(stub.callOrder).toEqual([
        `adoptExternalBatch:${batchId}`,
        `addPin:${batchId}`,
      ]);
      // `submitBatch` must NOT have been called yet — it is queued behind
      // the still-pending `addPin`.
      expect(stub.pendingSubmits).toHaveLength(0);
      // And the pump must not have surfaced any error frame.
      expect(stubTransport.sent).toEqual([]);

      // Resolve addPin → the pump sends pin.ack, then submitBatch runs.
      stub.pendingAddPins[0].resolve();
      await firstFrame;
      for (let i = 0; i < 10 && stub.pendingSubmits.length === 0; i++) {
        await Promise.resolve();
      }
      expect(stub.callOrder).toEqual([
        `adoptExternalBatch:${batchId}`,
        `addPin:${batchId}`,
        `submitBatch:${batchId}`,
      ]);

      // Resolve submitBatch → pump sends task.status.
      stub.pendingSubmits[0].resolve();
      await secondFrame;

      expect(stubTransport.sent).toEqual([
        { clientId: 'client-1', msg: { type: 'pin.ack', pinId: 'pin-fifo' } },
        {
          clientId: 'client-1',
          msg: { type: 'task.status', batchId, status: 'clarifying' },
        },
      ]);
      // Critically: no session.error was ever sent.
      expect(stubTransport.sent.some((f) => f.msg.type === 'session.error')).toBe(false);
    });

    it('does not block one client behind another client\'s in-flight frame', async () => {
      // Per-client FIFO: frames from different clientIds MUST be able to
      // overlap. A long `addPin` on client A must not delay a `pin.create`
      // on client B.
      const stub = buildProgrammableService();
      const stubTransport = new FakeInspectorTransport();
      wireInspectorMessagePump(stubTransport, stub.service);

      const clientAFrame = stubTransport.deliverInbound('client-A', {
        type: 'pin.create',
        batchId: 'batch-A',
        pin: makePin('pin-A'),
      });

      // Drain microtasks until client A reaches addPin and stalls.
      for (let i = 0; i < 10 && stub.pendingAddPins.length === 0; i++) {
        await Promise.resolve();
      }
      expect(stub.pendingAddPins).toHaveLength(1);
      expect(stub.callOrder).toEqual([
        'adoptExternalBatch:batch-A',
        'addPin:batch-A',
      ]);

      // Now client B sends a pin.create. It must proceed independently.
      const clientBFrame = stubTransport.deliverInbound('client-B', {
        type: 'pin.create',
        batchId: 'batch-B',
        pin: makePin('pin-B'),
      });

      for (let i = 0; i < 10 && stub.pendingAddPins.length < 2; i++) {
        await Promise.resolve();
      }

      // Client B must have reached addPin already, even though client A's
      // addPin is still pending.
      expect(stub.pendingAddPins).toHaveLength(2);
      expect(stub.callOrder).toEqual([
        'adoptExternalBatch:batch-A',
        'addPin:batch-A',
        'adoptExternalBatch:batch-B',
        'addPin:batch-B',
      ]);

      // Resolve in reverse order — client B completes before client A.
      stub.pendingAddPins[1].resolve();
      await clientBFrame;
      expect(stubTransport.sent).toEqual([
        { clientId: 'client-B', msg: { type: 'pin.ack', pinId: 'pin-B' } },
      ]);

      stub.pendingAddPins[0].resolve();
      await clientAFrame;
      expect(stubTransport.sent).toEqual([
        { clientId: 'client-B', msg: { type: 'pin.ack', pinId: 'pin-B' } },
        { clientId: 'client-A', msg: { type: 'pin.ack', pinId: 'pin-A' } },
      ]);
    });

    it('isolates per-frame errors: a rejected frame does not poison the next frame in the same client\'s chain', async () => {
      // The pump wraps each dispatch in try/catch + sendErrorFrame. The
      // chain tail stored in the per-client map must remain resolved so
      // the next frame dispatches normally.
      const stub = buildProgrammableService();
      const stubTransport = new FakeInspectorTransport();
      wireInspectorMessagePump(stubTransport, stub.service);

      const failingFrame = stubTransport.deliverInbound('client-err', {
        type: 'pin.create',
        batchId: 'batch-err',
        pin: makePin('pin-err'),
      });

      for (let i = 0; i < 10 && stub.pendingAddPins.length === 0; i++) {
        await Promise.resolve();
      }
      expect(stub.pendingAddPins).toHaveLength(1);

      const followUpFrame = stubTransport.deliverInbound('client-err', {
        type: 'batch.submit',
        batchId: 'batch-err',
      });

      // Reject the first frame — pump must translate into session.error.
      stub.pendingAddPins[0].reject(new Error('boom'));
      await failingFrame;

      // The second frame must still progress to submitBatch.
      for (let i = 0; i < 10 && stub.pendingSubmits.length === 0; i++) {
        await Promise.resolve();
      }
      expect(stub.pendingSubmits).toHaveLength(1);
      expect(stub.callOrder).toEqual([
        'adoptExternalBatch:batch-err',
        'addPin:batch-err',
        'submitBatch:batch-err',
      ]);

      stub.pendingSubmits[0].resolve();
      await followUpFrame;

      expect(stubTransport.sent).toEqual([
        {
          clientId: 'client-err',
          msg: { type: 'session.error', code: 'INTERNAL', message: 'boom' },
        },
        {
          clientId: 'client-err',
          msg: {
            type: 'task.status',
            batchId: 'batch-err',
            status: 'clarifying',
          },
        },
      ]);
    });

    it('clears the per-client chain entry on disconnect', async () => {
      // Disconnect cleanup prevents the map from growing unbounded across
      // reconnects. After onDisconnect fires, the next frame for that
      // client starts a fresh chain (observable only by not mis-ordering
      // with any stale state — we assert the handler is invoked and the
      // disconnect does not throw).
      const stub = buildProgrammableService();
      const stubTransport = new FakeInspectorTransport();
      wireInspectorMessagePump(stubTransport, stub.service);

      const frame = stubTransport.deliverInbound('client-dc', {
        type: 'pin.create',
        batchId: 'batch-dc',
        pin: makePin('pin-dc'),
      });
      for (let i = 0; i < 10 && stub.pendingAddPins.length < 1; i++) {
        await Promise.resolve();
      }
      expect(stub.pendingAddPins).toHaveLength(1);
      stub.pendingAddPins[0].resolve();
      await frame;

      // Simulate the client dropping its WebSocket.
      expect(() => stubTransport.simulateDisconnect('client-dc')).not.toThrow();

      // A fresh frame for the same clientId must still dispatch.
      const secondFrame = stubTransport.deliverInbound('client-dc', {
        type: 'pin.create',
        batchId: 'batch-dc-2',
        pin: makePin('pin-dc-2'),
      });
      for (let i = 0; i < 10 && stub.pendingAddPins.length < 2; i++) {
        await Promise.resolve();
      }
      expect(stub.pendingAddPins).toHaveLength(2);
      stub.pendingAddPins[1].resolve();
      await secondFrame;
      expect(stub.callOrder).toEqual([
        'adoptExternalBatch:batch-dc',
        'addPin:batch-dc',
        'adoptExternalBatch:batch-dc-2',
        'addPin:batch-dc-2',
      ]);
    });
  });
});
