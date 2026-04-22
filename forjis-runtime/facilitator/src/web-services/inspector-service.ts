/**
 * Facilitator-side implementation of the frozen Inspector v1.0 lifecycle.
 *
 * Owns the in-memory `Map<string, Batch>` that tracks every batch observed
 * during a single `forjis dev` session, decodes inbound base64 capture
 * payloads to per-batch staging directories under
 * `<projectDir>/.forjis/inspector/<batchId>/`, and rewrites the three
 * `capture.*` fields on each stored {@link Pin} to project-relative
 * forward-slash paths. Raises in-process lifecycle events
 * (`batch.submitted`, `clarify.answer`, `pin.added`, `task.status`) so
 * downstream consumers (the clarifier orchestrator added in task 005) can
 * subscribe without a circular import.
 *
 * This module only holds business logic — wire framing lives in
 * {@link ../web-services/inspector-message-pump.ts} and atomic file I/O
 * routes through {@link ../state.ts}. No persistence across restarts: the
 * registry dies with the process (explicit v1 non-goal).
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join, relative, sep } from 'node:path';

import type {
  Batch,
  ClarifyAnswer,
  InspectorService,
  Pin,
  Platform,
} from '@forjis/shared';

import { atomicWriteFile, atomicWriteFileBinary, ensureDir } from '../state.js';

/**
 * Options accepted by {@link InspectorServiceImpl}'s constructor.
 *
 * Callers MUST pass both fields explicitly; no default is applied inside the
 * class so unit tests cannot accidentally pollute the repository's
 * `.forjis/inspector/` directory when they forget an override.
 */
export interface InspectorServiceOptions {
  /** Absolute project root used to compute project-relative capture paths. */
  projectDir: string;
  /**
   * Absolute directory that hosts every `<batchId>/` staging subdirectory.
   *
   * Production callers compute this as `join(projectDir, '.forjis', 'inspector')`.
   * Tests MUST point this at a `mkdtemp` location to stay out of the repo tree.
   */
  stagingRoot: string;
}

/**
 * Domain error raised by {@link InspectorServiceImpl.submitBatch} when a
 * second batch is submitted while another batch is already `"clarifying"`
 * or `"running"`.
 *
 * The conflicting batch id is attached as a non-enumerable readonly field so
 * default `console.error(err)` and `util.inspect(err)` output do not echo it.
 * The {@link Error.message} text deliberately names only the attempted batch
 * id (the client already knows which batch it tried to submit) so the error
 * surface is identical to {@link ../session-token.ts:SessionTokenAlreadyRegisteredError}.
 */
export class ConcurrentBatchError extends Error {
  /**
   * Identifier of the batch that was already running when the collision was
   * detected. Stored non-enumerably; not included in the message text.
   */
  public readonly conflictingBatchId!: string;

  /**
   * Construct a `ConcurrentBatchError`.
   *
   * @param attemptedBatchId - Batch whose submit was rejected.
   * @param conflictingBatchId - Batch that was already in flight. Stored as
   *   a non-enumerable readonly field so it never appears in default error
   *   output.
   */
  constructor(attemptedBatchId: string, conflictingBatchId: string) {
    super(`Cannot submit batch "${attemptedBatchId}" while another batch is in progress.`);
    this.name = 'ConcurrentBatchError';
    Object.defineProperty(this, 'conflictingBatchId', {
      value: conflictingBatchId,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/**
 * Reserved characters that MUST NOT appear in a batch identifier.
 *
 * `:` and `@` are reserved by the Inspector wire protocol for future
 * namespacing / addressing use; newline and tab are reserved because batch
 * identifiers are interpolated into log lines and terminal output where
 * whitespace control characters would corrupt the surrounding stream.
 */
const RESERVED_BATCH_ID_CHARS: readonly string[] = [':', '@', '\n', '\t'];

/**
 * Domain error raised by {@link InspectorServiceImpl.adoptExternalBatch} when
 * the caller-supplied identifier is empty or contains a reserved character.
 *
 * The offending identifier is attached as a non-enumerable readonly field so
 * default `console.error(err)` and `util.inspect(err)` output do not echo
 * the raw client-supplied string.
 */
export class InvalidBatchIdError extends Error {
  /**
   * The rejected client-supplied batch identifier. Stored non-enumerably;
   * not included in the message text.
   */
  public readonly attemptedBatchId!: string;

  /**
   * Construct an `InvalidBatchIdError`.
   *
   * @param attemptedBatchId - Rejected identifier. Stored as a
   *   non-enumerable readonly field so it never appears in default error
   *   output.
   * @param reason - Human-readable explanation of the rejection (e.g.
   *   "empty" or "contains reserved character ':'").
   */
  constructor(attemptedBatchId: string, reason: string) {
    super(`Invalid batch id: ${reason}.`);
    this.name = 'InvalidBatchIdError';
    Object.defineProperty(this, 'attemptedBatchId', {
      value: attemptedBatchId,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/**
 * Allocate a new batch identifier.
 *
 * Format `batch-<ms-epoch>-<4-byte-hex>`. Mirrors `generateTaskId()` from
 * `task-queue.ts`: sortable by creation time, human-scannable in `ls` output,
 * and safe as a filesystem directory name on every supported platform.
 *
 * @returns A fresh batch identifier.
 */
function generateBatchId(): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString('hex');
  return `batch-${timestamp}-${random}`;
}

/**
 * Render the per-batch pin index as a zero-padded decimal string.
 *
 * Pins 1–99 pad to two digits (`"01"`, `"02"`, …, `"99"`). At pin 100 and
 * beyond the natural width takes over (`"100"`, `"101"`, …), keeping
 * `ls`-sorted directory listings monotonic while matching the spec example
 * `pin-01-element.png`.
 *
 * @param n - 1-based pin index.
 * @returns The padded string form of `n`.
 */
function renderPinIndex(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Convert an absolute path inside the project root to a project-relative
 * string with forward-slash separators.
 *
 * Used exclusively for pin `capture.*` rewrites where both `projectDir` and
 * the absolute path are constructed from trusted pieces (project root,
 * staging root, generated batch id, generated pin filename). No traversal
 * rejection is needed because the inputs are not user-controlled — the only
 * transform applied is the Windows-friendly `sep → '/'` normalisation from
 * {@link ../web-services/manifest-recorder.ts:toProjectRelative}.
 *
 * @param projectDir - Absolute project root.
 * @param absolutePath - Absolute path under the project root.
 * @returns Project-relative path with forward-slash separators.
 */
function toProjectRelativeForwardSlash(projectDir: string, absolutePath: string): string {
  return relative(projectDir, absolutePath).split(sep).join('/');
}

/**
 * Discriminator used by {@link BatchFailedEventPayload} to disambiguate the
 * three facilitator-side failure sources in `forjis-runtime/facilitator/src/commands/run.ts`.
 *
 * - `'engine-error'`     — catch-all for any throw inside the run-loop body (engine rejection,
 *                          outcome-assessor rejection, user `batch.abort` during a post-finalize run).
 * - `'no-pipeline-state'` — orchestrator returned `exit 0` without writing `pipeline-state.yaml`.
 * - `'shutdown'`          — SIGINT/SIGTERM cleanup transitioned a running task to `failed`.
 */
export type FailureCategory = 'engine-error' | 'no-pipeline-state' | 'shutdown';

/**
 * Payload delivered with the in-process `batch.failed` event.
 *
 * The `batchId` and `taskId` fields are the same value for v1 (inspector tasks
 * are named after the batch-derived slug), but both are kept in the contract so
 * downstream subscribers have clear semantic handles.
 */
export interface BatchFailedEventPayload {
  /** Identifier of the batch whose downstream task failed. */
  batchId: string;
  /** Task identifier (starts with the literal prefix `inspector-`). */
  taskId: string;
  /** Absolute path to `.forjis/tasks/<taskId>`. */
  taskPath: string;
  /** Failure category recorded at the originating call site. */
  category: FailureCategory;
}

/**
 * Facilitator implementation of {@link InspectorService}.
 *
 * Extends {@link EventEmitter} directly so consumers can use standard
 * `service.on(name, handler)` / `service.off(...)` subscriptions. The event
 * catalogue is:
 *
 * | Event name        | Payload                                                     |
 * | ----------------- | ----------------------------------------------------------- |
 * | `batch.submitted` | `{ batch: Batch }`                                          |
 * | `clarify.answer`  | `{ batchId: string; answer: ClarifyAnswer }`                |
 * | `pin.added`       | `{ batchId: string; pin: Pin }` (post-rewrite stored pin)   |
 * | `task.status`     | `{ batchId: string; status: BatchStatus; summary?: string }` |
 * | `batch.failed`    | {@link BatchFailedEventPayload}                             |
 *
 * Every batch is kept in-memory only; nothing is persisted across restarts.
 */
export class InspectorServiceImpl extends EventEmitter implements InspectorService {
  /** Absolute project root used for project-relative capture paths. */
  private readonly projectDir: string;

  /** Absolute root that hosts every per-batch staging directory. */
  private readonly stagingRoot: string;

  /** In-memory registry of every batch observed during this process's lifetime. */
  private readonly batches = new Map<string, Batch>();

  /** Reverse index from `pin.id` to the owning `batch.id` for O(1) reply lookup. */
  private readonly pinIndex = new Map<string, string>();

  /**
   * Construct a new `InspectorServiceImpl`.
   *
   * @param options - Configuration. `stagingRoot` MUST be supplied explicitly
   *   (no default applied) so tests cannot accidentally write under the
   *   repository's `.forjis/inspector/`.
   */
  constructor(options: InspectorServiceOptions) {
    super();
    this.projectDir = options.projectDir;
    this.stagingRoot = options.stagingRoot;
  }

  /**
   * Create a fresh batch for the given platform.
   *
   * Allocates a new identifier, initialises the {@link Batch} record with
   * `status: "queued"`, empty `pins`/`screens`, `parentBatchId: null`, and a
   * `createdAt` timestamp, ensures the staging directory exists on disk, and
   * registers the batch in the in-memory map before resolving.
   *
   * @param platform - Platform that initiated the batch.
   * @returns The newly created {@link Batch}.
   */
  async createBatch(platform: Platform): Promise<Batch> {
    return this.createBatchRecord(generateBatchId(), platform, null);
  }

  /**
   * Adopt a caller-supplied batch identifier as a fresh batch.
   *
   * Validates the identifier (empty + reserved-character rejection)
   * before touching the filesystem. When a batch with `batchId` already
   * exists, returns a deep-cloned snapshot so callers cannot mutate the
   * service's internal state — matching {@link getBatch} semantics. When
   * the identifier is new, enforces the same concurrent-batch guard as
   * {@link submitBatch} against every other registered batch and then
   * delegates to the shared {@link createBatchRecord} helper.
   *
   * @param batchId - Caller-supplied batch identifier.
   * @param platform - Platform that initiated the batch.
   * @returns The adopted or newly created batch.
   * @throws {InvalidBatchIdError} When `batchId` is empty or contains a
   *   reserved character (`:`, `@`, newline, tab).
   * @throws {ConcurrentBatchError} When another batch is already
   *   `"clarifying"` or `"running"`.
   */
  async adoptExternalBatch(batchId: string, platform: Platform): Promise<Batch> {
    this.assertValidBatchId(batchId);

    const existing = this.batches.get(batchId);
    if (existing !== undefined) {
      return structuredClone(existing);
    }

    this.assertNoConcurrentBatch(batchId);
    return this.createBatchRecord(batchId, platform, null);
  }

  /**
   * Append a pin to an existing batch.
   *
   * Decodes the three `capture.*` base64 fields to disk under the batch's
   * staging directory, rewrites each field on an internal clone of the pin
   * to the corresponding project-relative forward-slash path, appends the
   * clone to `batch.pins`, deduplicates `pin.screen` onto `batch.screens`,
   * updates the pin-id reverse index, and emits `pin.added`.
   *
   * The caller-supplied `pin` object is never mutated (a shallow spread
   * produces the stored copy).
   *
   * @param batchId - Identifier of the target batch.
   * @param pin - Pin to append. `capture.*` fields MUST be base64 strings.
   * @throws When the batch does not exist or is not in status `"queued"`.
   */
  async addPin(batchId: string, pin: Pin): Promise<void> {
    const batch = this.requireQueuedBatch(batchId);
    const storedPin = await this.persistPinAndRewriteCapture(batch, pin);

    batch.pins.push(storedPin);
    if (pin.screen !== null && !batch.screens.includes(pin.screen)) {
      batch.screens.push(pin.screen);
    }
    this.pinIndex.set(storedPin.id, batch.id);

    this.emit('pin.added', { batchId: batch.id, pin: storedPin });
  }

  /**
   * Submit a batch for clarification.
   *
   * Performs a synchronous concurrent-batch guard against every other batch
   * in the registry: if any other batch is already `"clarifying"` or
   * `"running"`, throws {@link ConcurrentBatchError} without mutating state.
   * Otherwise flips the target batch's status to `"clarifying"` and emits
   * `batch.submitted` carrying the batch reference.
   *
   * @param batchId - Identifier of the batch to submit.
   * @throws When the batch does not exist.
   * @throws {ConcurrentBatchError} When another batch is `"clarifying"` or
   *   `"running"`.
   */
  async submitBatch(batchId: string): Promise<void> {
    const batch = this.requireBatch(batchId);
    this.assertNoConcurrentBatch(batch.id);

    batch.status = 'clarifying';
    this.emit('batch.submitted', { batch });
  }

  /**
   * Forward a clarify-chat answer to any in-process subscriber.
   *
   * Public interface path — kept for backward compatibility with
   * non-pump callers. Delegates to {@link answerClarifyWithClient} with
   * `clientId: null` so the emitted event carries the same shape
   * regardless of call site.
   *
   * @param batchId - Identifier of the batch being clarified.
   * @param answer - Answer to the most recent {@link ../../shared/src/inspector-types.ts:ClarifyQuestion}.
   */
  async answerClarify(batchId: string, answer: ClarifyAnswer): Promise<void> {
    await this.answerClarifyWithClient(batchId, answer, null);
  }

  /**
   * Internal path used by the message pump to thread the originating
   * client id through to the `clarify.answer` event so the clarifier
   * runner can address the same client with the next `clarify.question`
   * frame.
   *
   * The public {@link InspectorService} interface is deliberately NOT
   * widened — `clientId` is a facilitator-internal routing concern.
   *
   * @param batchId - Identifier of the batch being clarified.
   * @param answer - Answer to the most recent question.
   * @param clientId - Originating client identifier, or `null` when the
   *   call came from a non-pump caller (tests, scripted drivers).
   */
  async answerClarifyWithClient(
    batchId: string,
    answer: ClarifyAnswer,
    clientId: string | null,
  ): Promise<void> {
    this.emit('clarify.answer', { batchId, answer, clientId });
  }

  /**
   * Request termination of the clarifier subprocess for a batch.
   *
   * Emits `batch.abort` so the clarifier runner can tear down the
   * running subprocess and finalise with assumptions. This method is
   * facilitator-internal and is NOT part of the shared
   * {@link InspectorService} interface.
   *
   * @param batchId - Identifier of the batch to abort.
   * @param clientId - Originating client identifier, or `null` when
   *   the call came from a non-pump caller.
   */
  async abortBatch(batchId: string, clientId: string | null): Promise<void> {
    this.emit('batch.abort', { batchId, clientId });
  }

  /**
   * Notify in-process subscribers that an inspector-sourced task has
   * transitioned to `failed`.
   *
   * Fire-and-forget: emits the {@link BatchFailedEventPayload} on the
   * internal emitter and does not mutate any registry state. Callers
   * (currently only the facilitator's run-loop failure dispatcher)
   * MUST gate emission on `taskId.startsWith('inspector-')` so
   * non-inspector task failures stay on the run-loop's original path.
   *
   * @param payload - Typed failure-event payload.
   */
  emitBatchFailed(payload: BatchFailedEventPayload): void {
    this.emit('batch.failed', payload);
  }

  /**
   * Create a follow-up pin that replies to an existing pin.
   *
   * Resolves the parent pin's owning batch via the pin-id reverse index,
   * allocates a fresh child batch with `parentBatchId` set to the parent's
   * id, writes `parent.json` to the child's staging directory, then persists
   * the reply pin through the same capture-rewrite path as {@link addPin}
   * (with `parentPinId` and `comment` attached to the stored pin).
   *
   * When the inbound `reply.create` frame carries `failureSummary` and/or
   * `failedTaskPath` (inspector-013), those fields are forwarded into
   * `parent.json` so {@link InspectorClarifierRunner.loadParentContext}
   * can hand them to the clarifier persona via `modeArgs.parentContext`.
   *
   * @param parentPinId - Identifier of the pin being replied to.
   * @param pin - New pin carrying the reply. `capture.*` fields MUST be base64.
   * @param comment - Comment text attached to the reply pin.
   * @param failureSummary - Summary of the failed parent task, or
   *   `null` / `undefined` when the reply is not failure-scoped.
   * @param failedTaskPath - Project-relative path of the failed parent
   *   task directory, or `null` / `undefined` when the reply is not
   *   failure-scoped.
   * @throws When the parent pin or its owning batch cannot be resolved.
   */
  async replyToPin(
    parentPinId: string,
    pin: Pin,
    comment: string,
    failureSummary?: string | null,
    failedTaskPath?: string | null,
  ): Promise<void> {
    const parentBatchId = this.pinIndex.get(parentPinId);
    if (parentBatchId === undefined) {
      throw new Error(`Unknown parent pin id "${parentPinId}".`);
    }

    const parentBatch = this.batches.get(parentBatchId);
    if (parentBatch === undefined) {
      throw new Error(
        `Parent batch "${parentBatchId}" for pin "${parentPinId}" is not registered.`,
      );
    }

    const parentPin = parentBatch.pins.find(candidate => candidate.id === parentPinId);
    if (parentPin === undefined) {
      throw new Error(
        `Parent pin "${parentPinId}" is missing from batch "${parentBatch.id}".`,
      );
    }

    const childBatch = await this.createChildBatch(parentBatch);
    await this.writeParentJson(
      childBatch.id,
      parentPin,
      parentBatch.id,
      failureSummary ?? null,
      failedTaskPath ?? null,
    );

    const replyPin: Pin = {
      ...pin,
      parentPinId,
      comment,
    };

    await this.addPin(childBatch.id, replyPin);
  }

  /**
   * Look up a batch by identifier.
   *
   * Returns a deep copy (via `structuredClone`) so callers cannot mutate the
   * service's internal state by modifying the returned object.
   *
   * @param batchId - Identifier to look up.
   * @returns The batch snapshot, or `null` when no batch with that id exists.
   */
  async getBatch(batchId: string): Promise<Batch | null> {
    const batch = this.batches.get(batchId);
    return batch === undefined ? null : structuredClone(batch);
  }

  /**
   * List every known batch.
   *
   * Returns an array of deep copies so callers cannot mutate the service's
   * internal state.
   *
   * @returns All batches currently tracked by the service.
   */
  async listBatches(): Promise<Batch[]> {
    return [...this.batches.values()].map(batch => structuredClone(batch));
  }

  /**
   * Resolve a batch by id or throw when missing.
   *
   * @param batchId - Identifier to look up.
   * @returns The live batch reference.
   * @throws When no batch with the supplied id exists.
   */
  private requireBatch(batchId: string): Batch {
    const batch = this.batches.get(batchId);
    if (batch === undefined) {
      throw new Error(`Unknown batch id "${batchId}".`);
    }
    return batch;
  }

  /**
   * Resolve a batch by id, asserting it is still accepting pins.
   *
   * @param batchId - Identifier to look up.
   * @returns The live batch reference.
   * @throws When the batch does not exist or is not in status `"queued"`.
   */
  private requireQueuedBatch(batchId: string): Batch {
    const batch = this.requireBatch(batchId);
    if (batch.status !== 'queued') {
      throw new Error(
        `Batch "${batchId}" is in status "${batch.status}" and no longer accepts pins.`,
      );
    }
    return batch;
  }

  /**
   * Decode the three `capture.*` base64 fields of an inbound pin to disk and
   * produce a new {@link Pin} with those fields replaced by project-relative
   * forward-slash paths.
   *
   * Never mutates the input `pin`.
   *
   * @param batch - Batch the pin belongs to; its staging directory and the
   *   current `pins.length` determine the on-disk filenames.
   * @param pin - Inbound pin whose `capture.*` fields are base64 strings.
   * @returns A new pin whose `capture.*` fields are project-relative paths.
   */
  private async persistPinAndRewriteCapture(batch: Batch, pin: Pin): Promise<Pin> {
    const batchDir = join(this.stagingRoot, batch.id);
    const pinIndex = renderPinIndex(batch.pins.length + 1);

    const elementPath = join(batchDir, `pin-${pinIndex}-element.png`);
    const viewportPath = join(batchDir, `pin-${pinIndex}-viewport.png`);
    const stylesPath = join(batchDir, `pin-${pinIndex}-styles.json`);

    await atomicWriteFileBinary(elementPath, Buffer.from(pin.capture.elementScreenshot, 'base64'));
    await atomicWriteFileBinary(viewportPath, Buffer.from(pin.capture.viewportScreenshot, 'base64'));
    await atomicWriteFileBinary(stylesPath, Buffer.from(pin.capture.computedStyles, 'base64'));

    return {
      ...pin,
      capture: {
        ...pin.capture,
        elementScreenshot: toProjectRelativeForwardSlash(this.projectDir, elementPath),
        viewportScreenshot: toProjectRelativeForwardSlash(this.projectDir, viewportPath),
        computedStyles: toProjectRelativeForwardSlash(this.projectDir, stylesPath),
      },
    };
  }

  /**
   * Allocate and register a child batch that inherits the parent's platform
   * and records `parentBatchId` for traceability.
   *
   * @param parentBatch - Parent batch whose platform and id are copied.
   * @returns The newly created child batch (already in-registry).
   */
  private async createChildBatch(parentBatch: Batch): Promise<Batch> {
    return this.createBatchRecord(
      generateBatchId(),
      parentBatch.platform,
      parentBatch.id,
    );
  }

  /**
   * Shared batch-construction logic used by {@link createBatch},
   * {@link adoptExternalBatch}, and {@link createChildBatch}.
   *
   * Builds the {@link Batch} record with `status: "queued"`, empty
   * `pins`/`screens`, the supplied `parentBatchId`, and a `createdAt`
   * timestamp, ensures the staging directory exists on disk, and
   * registers the batch in the in-memory map before resolving.
   *
   * @param id - Identifier to assign to the new batch.
   * @param platform - Platform that initiated the batch.
   * @param parentBatchId - Parent batch identifier for iteration batches,
   *   or `null` for top-level batches.
   * @returns The newly created batch (live reference).
   */
  private async createBatchRecord(
    id: string,
    platform: Platform,
    parentBatchId: string | null,
  ): Promise<Batch> {
    const batch: Batch = {
      id,
      platform,
      screens: [],
      pins: [],
      createdAt: new Date().toISOString(),
      parentBatchId,
      status: 'queued',
    };

    await ensureDir(join(this.stagingRoot, batch.id));
    this.batches.set(batch.id, batch);
    return batch;
  }

  /**
   * Validate a caller-supplied batch identifier.
   *
   * Rejects empty identifiers and identifiers that contain any character
   * from {@link RESERVED_BATCH_ID_CHARS}. Called BEFORE any filesystem
   * state is created so a rejected id leaves no trace on disk.
   *
   * @param batchId - Caller-supplied identifier to validate.
   * @throws {InvalidBatchIdError} When the identifier is empty or
   *   contains a reserved character.
   */
  private assertValidBatchId(batchId: string): void {
    if (batchId.length === 0) {
      throw new InvalidBatchIdError(batchId, 'empty');
    }
    for (const reserved of RESERVED_BATCH_ID_CHARS) {
      if (batchId.includes(reserved)) {
        const rendered = JSON.stringify(reserved);
        throw new InvalidBatchIdError(batchId, `contains reserved character ${rendered}`);
      }
    }
  }

  /**
   * Assert that no other registered batch is already in a non-queued
   * state that would block the supplied batch from starting work.
   *
   * Shared by {@link submitBatch} and {@link adoptExternalBatch} so both
   * entry points apply the exact same guard.
   *
   * @param attemptedBatchId - Identifier whose admission is being
   *   checked.
   * @throws {ConcurrentBatchError} When another batch is `"clarifying"`
   *   or `"running"`.
   */
  private assertNoConcurrentBatch(attemptedBatchId: string): void {
    for (const other of this.batches.values()) {
      if (other.id === attemptedBatchId) continue;
      if (other.status === 'clarifying' || other.status === 'running') {
        throw new ConcurrentBatchError(attemptedBatchId, other.id);
      }
    }
  }

  /**
   * Write the `parent.json` descriptor into a child batch's staging directory.
   *
   * The `parentTaskPath` field is reserved for task 005+ (once the clarifier
   * writes `tasks/inspector-...` directories, the reply's parent.json can
   * record that path). In v1 it is always `null`.
   *
   * When the reply originated from a failure card (inspector-013), the
   * optional `failureSummary` / `failedTaskPath` arguments are persisted
   * alongside the other parent-linkage fields so the clarifier runner's
   * {@link InspectorClarifierRunner.loadParentContext} step can forward
   * them verbatim into `modeArgs.parentContext`. When `null`, the fields
   * are still emitted (as `null`) to keep the on-disk schema stable.
   *
   * @param childBatchId - Identifier of the child batch whose directory
   *   receives the file.
   * @param parentPin - Snapshot of the parent pin.
   * @param parentBatchId - Identifier of the parent batch.
   * @param failureSummary - Summary of the failed parent task, or `null`
   *   when the reply is not failure-scoped.
   * @param failedTaskPath - Project-relative path of the failed parent
   *   task directory, or `null` when the reply is not failure-scoped.
   */
  private async writeParentJson(
    childBatchId: string,
    parentPin: Pin,
    parentBatchId: string,
    failureSummary: string | null = null,
    failedTaskPath: string | null = null,
  ): Promise<void> {
    const parentJsonPath = join(this.stagingRoot, childBatchId, 'parent.json');
    const payload = {
      parentPin,
      parentBatchId,
      parentTaskPath: null,
      childBatchId,
      failureSummary,
      failedTaskPath,
    };
    await atomicWriteFile(parentJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
