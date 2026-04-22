/**
 * Wire-framing layer that connects an {@link InspectorTransport} to an
 * {@link InspectorService}.
 *
 * Subscribes once to `transport.onMessage`, dispatches each inbound
 * {@link InspectorMessage} to the matching service method, and translates
 * service results + thrown domain errors into outbound wire frames. Every
 * outbound frame is unicast to the originating client via
 * `transport.send(clientId, msg)` — the pump never calls
 * `transport.broadcast`.
 *
 * Business logic lives in {@link ./inspector-service.ts}; this module only
 * handles wire protocol concerns.
 */

import type { ClarifyAnswer, InspectorMessage, InspectorService, InspectorTransport } from '@forjis/shared';
import { assertNeverInspectorMessage } from '@forjis/shared';

import { ConcurrentBatchError } from './inspector-service.js';

/**
 * Subset of `InspectorServiceImpl` the pump needs for routing that the
 * shared {@link InspectorService} interface does not expose.
 *
 * The pump receives the public `InspectorService` type but routes both
 * `clarify.answer` and `batch.abort` through these facilitator-internal
 * methods when they are present. Structural typing keeps the public
 * wire-protocol interface clean while letting the pump forward the
 * originating client id to the runner.
 */
interface ClientAwareInspectorService extends InspectorService {
  answerClarifyWithClient?(
    batchId: string,
    answer: ClarifyAnswer,
    clientId: string | null,
  ): Promise<void>;
  abortBatch?(batchId: string, clientId: string | null): Promise<void>;
}

/**
 * Wire an {@link InspectorService} to an {@link InspectorTransport}.
 *
 * Registers exactly one `onMessage` handler on the transport. Inbound client-
 * to-server frames are dispatched per {@link InspectorMessage} type:
 *
 * | Inbound `type`   | Service call                                              | Outbound on success                                                    |
 * | ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
 * | `pin.create`     | `addPin(batchId, pin)`                                    | `{ type: "pin.ack", pinId }`                                           |
 * | `batch.submit`   | `submitBatch(batchId)`                                    | `{ type: "task.status", batchId, status: "clarifying" }`               |
 * | `clarify.answer` | `answerClarifyWithClient(batchId, answer, clientId)`      | none                                                                   |
 * | `reply.create`   | `replyToPin(parentPinId, pin, comment)`                   | `{ type: "pin.ack", pinId }`                                           |
 * | `batch.abort`    | `abortBatch(batchId, clientId)`                           | none (runner emits `batch.finalize` when the clarifier exits)          |
 *
 * Server-to-client frame types (`session.ack`, `session.error`, `pin.ack`,
 * `clarify.question`, `batch.finalize`, `task.status`) arriving inbound are
 * dropped silently — they are not legal client-initiated messages.
 * `session.join` is filtered upstream by the transport but is handled
 * defensively here for exhaustiveness. Service exceptions are translated:
 * {@link ConcurrentBatchError} → `session.error { code: "CONCURRENT_BATCH" }`,
 * every other `Error` → `session.error { code: "INTERNAL" }`. The pump
 * NEVER rethrows and NEVER calls `transport.broadcast`.
 *
 * @param transport - The {@link InspectorTransport} carrying inbound/outbound
 *   Inspector messages.
 * @param service - The {@link InspectorService} implementation that owns
 *   batch and pin lifecycle state.
 */
export function wireInspectorMessagePump(
  transport: InspectorTransport,
  service: InspectorService,
): void {
  transport.onMessage(async (clientId, msg) => {
    try {
      await dispatchInboundMessage(transport, service, clientId, msg);
    } catch (err) {
      sendErrorFrame(transport, clientId, err);
    }
  });
}

/**
 * Route a single inbound {@link InspectorMessage} to the service and send the
 * corresponding ack frame on success.
 *
 * @param transport - Transport used to send outbound frames.
 * @param service - Service that owns lifecycle state.
 * @param clientId - Originating client identifier for the ack target.
 * @param msg - Inbound Inspector message.
 */
async function dispatchInboundMessage(
  transport: InspectorTransport,
  service: InspectorService,
  clientId: string,
  msg: InspectorMessage,
): Promise<void> {
  const aware = service as ClientAwareInspectorService;
  switch (msg.type) {
    case 'pin.create': {
      // The browser SDK generates `batchId` client-side on the first
      // captured pin — the server never saw a `batch.create` frame for
      // it. Adopt the client-supplied id lazily so the subsequent
      // `addPin` call has a registered batch to attach to. Adoption is
      // idempotent, so follow-up pins that reuse the same id do not
      // trigger any state churn. Adoption also enforces the concurrent-
      // batch guard, so a `pin.create` that would open a second batch
      // while another is still clarifying / running surfaces a typed
      // `ConcurrentBatchError` that the shared catch translates into
      // `session.error { CONCURRENT_BATCH }`.
      const existing = await service.getBatch(msg.batchId);
      if (existing === null) {
        await service.adoptExternalBatch(msg.batchId, msg.pin.platform);
      }
      await service.addPin(msg.batchId, msg.pin);
      transport.send(clientId, { type: 'pin.ack', pinId: msg.pin.id });
      return;
    }
    case 'batch.submit':
      await service.submitBatch(msg.batchId);
      transport.send(clientId, {
        type: 'task.status',
        batchId: msg.batchId,
        status: 'clarifying',
      });
      return;
    case 'clarify.answer':
      if (typeof aware.answerClarifyWithClient === 'function') {
        await aware.answerClarifyWithClient(msg.batchId, msg.answer, clientId);
      } else {
        await service.answerClarify(msg.batchId, msg.answer);
      }
      return;
    case 'reply.create':
      await service.replyToPin(
        msg.parentPinId,
        msg.pin,
        msg.comment,
        msg.failureSummary,
        msg.failedTaskPath,
      );
      transport.send(clientId, { type: 'pin.ack', pinId: msg.pin.id });
      return;
    case 'batch.abort':
      if (typeof aware.abortBatch === 'function') {
        await aware.abortBatch(msg.batchId, clientId);
      }
      // When the service does not implement abortBatch (for example a
      // stub used in a test that does not exercise abort), drop the
      // frame silently — the public interface does not carry an abort
      // method, so the caller is responsible for wiring one if needed.
      return;
    case 'session.join':
    case 'session.ack':
    case 'session.error':
    case 'pin.ack':
    case 'clarify.question':
    case 'batch.finalize':
    case 'task.status':
      // Server-to-client frames (plus the pre-join `session.join` which the
      // transport filters upstream) are not legal inbound payloads. Drop
      // silently rather than surfacing an error to the client.
      return;
    default:
      assertNeverInspectorMessage(msg);
  }
}

/**
 * Translate a caught error into an outbound `session.error` frame.
 *
 * @param transport - Transport used to send the frame.
 * @param clientId - Client that triggered the failed dispatch.
 * @param err - Unknown caught value (usually an {@link Error}).
 */
function sendErrorFrame(
  transport: InspectorTransport,
  clientId: string,
  err: unknown,
): void {
  if (err instanceof ConcurrentBatchError) {
    transport.send(clientId, {
      type: 'session.error',
      code: 'CONCURRENT_BATCH',
      message: err.message,
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  transport.send(clientId, {
    type: 'session.error',
    code: 'INTERNAL',
    message,
  });
}
