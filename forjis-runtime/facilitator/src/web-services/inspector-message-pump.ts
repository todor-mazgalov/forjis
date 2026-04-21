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

import type { InspectorMessage, InspectorService, InspectorTransport } from '@forjis/shared';
import { assertNeverInspectorMessage } from '@forjis/shared';

import { ConcurrentBatchError } from './inspector-service.js';

/**
 * Wire an {@link InspectorService} to an {@link InspectorTransport}.
 *
 * Registers exactly one `onMessage` handler on the transport. Inbound client-
 * to-server frames are dispatched per {@link InspectorMessage} type:
 *
 * | Inbound `type`   | Service call                                   | Outbound on success                                                    |
 * | ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
 * | `pin.create`     | `addPin(batchId, pin)`                         | `{ type: "pin.ack", pinId }`                                           |
 * | `batch.submit`   | `submitBatch(batchId)`                         | `{ type: "task.status", batchId, status: "clarifying" }`               |
 * | `clarify.answer` | `answerClarify(batchId, answer)`               | none                                                                   |
 * | `reply.create`   | `replyToPin(parentPinId, pin, comment)`        | `{ type: "pin.ack", pinId }`                                           |
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
  switch (msg.type) {
    case 'pin.create':
      await service.addPin(msg.batchId, msg.pin);
      transport.send(clientId, { type: 'pin.ack', pinId: msg.pin.id });
      return;
    case 'batch.submit':
      await service.submitBatch(msg.batchId);
      transport.send(clientId, {
        type: 'task.status',
        batchId: msg.batchId,
        status: 'clarifying',
      });
      return;
    case 'clarify.answer':
      await service.answerClarify(msg.batchId, msg.answer);
      return;
    case 'reply.create':
      await service.replyToPin(msg.parentPinId, msg.pin, msg.comment);
      transport.send(clientId, { type: 'pin.ack', pinId: msg.pin.id });
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
