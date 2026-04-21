/**
 * Forjis Inspector v1.0 service and transport interfaces.
 *
 * Declares the two abstract contracts that cross the Inspector package
 * boundary:
 *
 * - {@link InspectorService} is implemented by the facilitator. It owns batch
 *   and pin lifecycle and persists state. Every method is asynchronous.
 * - {@link InspectorTransport} is implemented by each SDK (web, Compose,
 *   SwiftUI). It is the synchronous WebSocket plumbing layer that delivers
 *   {@link InspectorMessage} values to and from clients.
 *
 * These interfaces carry no default implementation so that `@forjis/shared`
 * stays a zero-dependency, zero-runtime-code package.
 */

import type {
  Batch,
  ClarifyAnswer,
  InspectorMessage,
  Pin,
  Platform,
} from './inspector-types.js';

/**
 * Facilitator-side contract for the Inspector batch and pin lifecycle.
 *
 * Concrete implementations live in `forjis-runtime/facilitator` (inspector-003
 * and later). Test doubles provide in-memory fakes.
 */
export interface InspectorService {
  /**
   * Create a fresh batch for the given platform.
   *
   * The returned {@link Batch} has a generated `id`, empty `pins`, empty
   * `screens`, `parentBatchId: null`, `status: "queued"`, and a
   * `createdAt` timestamp set to `new Date().toISOString()`.
   *
   * @param platform - Platform that initiated the batch.
   * @returns The newly created batch.
   */
  createBatch(platform: Platform): Promise<Batch>;

  /**
   * Append a pin to an existing batch.
   *
   * @param batchId - Identifier of the target batch.
   * @param pin - Pin to append.
   * @throws When the batch does not exist, or is not in status `"queued"`.
   */
  addPin(batchId: string, pin: Pin): Promise<void>;

  /**
   * Submit a batch for clarification or finalization.
   *
   * Transitions the batch from `"queued"` to `"clarifying"` (or directly to
   * `"finalized"` when no clarify is needed — the concrete rule lives in the
   * facilitator implementation).
   *
   * @param batchId - Identifier of the batch to submit.
   */
  submitBatch(batchId: string): Promise<void>;

  /**
   * Record a clarify-chat answer against a batch.
   *
   * May transition the batch to `"finalized"` once all open questions are
   * answered.
   *
   * @param batchId - Identifier of the batch being clarified.
   * @param answer - Answer to a previously-sent {@link ClarifyQuestion}.
   */
  answerClarify(batchId: string, answer: ClarifyAnswer): Promise<void>;

  /**
   * Create a follow-up pin that replies to an existing pin.
   *
   * The new pin is linked to its parent via `pin.parentPinId = parentPinId`
   * inside an iteration batch, and the supplied comment is attached to the
   * new pin.
   *
   * @param parentPinId - Identifier of the pin being replied to.
   * @param pin - New pin carrying the reply.
   * @param comment - Comment text attached to the reply pin.
   */
  replyToPin(parentPinId: string, pin: Pin, comment: string): Promise<void>;

  /**
   * Look up a batch by identifier.
   *
   * @param batchId - Identifier to look up.
   * @returns The batch, or `null` when no batch with that identifier exists.
   */
  getBatch(batchId: string): Promise<Batch | null>;

  /**
   * List every known batch.
   *
   * @returns All batches currently tracked by the facilitator.
   */
  listBatches(): Promise<Batch[]>;
}

/**
 * SDK-side contract for the Inspector WebSocket transport.
 *
 * Handler registration is synchronous and must be idempotent within a single
 * transport instance. Send operations are synchronous from the caller's point
 * of view; the underlying WebSocket may buffer internally.
 */
export interface InspectorTransport {
  /**
   * Register a handler invoked whenever a new Inspector client connects.
   *
   * @param handler - Callback receiving the new client's identifier.
   */
  onConnect(handler: (clientId: string) => void): void;

  /**
   * Register a handler invoked whenever an Inspector message arrives.
   *
   * @param handler - Callback receiving the originating client identifier
   *   and the parsed {@link InspectorMessage}.
   */
  onMessage(
    handler: (clientId: string, msg: InspectorMessage) => void,
  ): void;

  /**
   * Register a handler invoked whenever an Inspector client disconnects.
   *
   * @param handler - Callback receiving the disconnected client's identifier.
   */
  onDisconnect(handler: (clientId: string) => void): void;

  /**
   * Send a message to a single connected client.
   *
   * @param clientId - Target client identifier.
   * @param msg - Message to deliver.
   */
  send(clientId: string, msg: InspectorMessage): void;

  /**
   * Broadcast a message to every connected client.
   *
   * @param msg - Message to deliver to every client.
   */
  broadcast(msg: InspectorMessage): void;
}
