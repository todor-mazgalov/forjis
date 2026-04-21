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
    const batch: Batch = {
      id: generateBatchId(),
      platform,
      screens: [],
      pins: [],
      createdAt: new Date().toISOString(),
      parentBatchId: null,
      status: 'queued',
    };

    await ensureDir(join(this.stagingRoot, batch.id));
    this.batches.set(batch.id, batch);
    return batch;
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

    for (const other of this.batches.values()) {
      if (other.id === batch.id) continue;
      if (other.status === 'clarifying' || other.status === 'running') {
        throw new ConcurrentBatchError(batch.id, other.id);
      }
    }

    batch.status = 'clarifying';
    this.emit('batch.submitted', { batch });
  }

  /**
   * Forward a clarify-chat answer to any in-process subscriber.
   *
   * v1 performs no state mutation — task 005's clarifier orchestrator
   * subscribes to the `clarify.answer` event and drives the subprocess from
   * there. This method never throws.
   *
   * @param batchId - Identifier of the batch being clarified.
   * @param answer - Answer to the most recent {@link ../../shared/src/inspector-types.ts:ClarifyQuestion}.
   */
  async answerClarify(batchId: string, answer: ClarifyAnswer): Promise<void> {
    this.emit('clarify.answer', { batchId, answer });
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
   * @param parentPinId - Identifier of the pin being replied to.
   * @param pin - New pin carrying the reply. `capture.*` fields MUST be base64.
   * @param comment - Comment text attached to the reply pin.
   * @throws When the parent pin or its owning batch cannot be resolved.
   */
  async replyToPin(parentPinId: string, pin: Pin, comment: string): Promise<void> {
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
    await this.writeParentJson(childBatch.id, parentPin, parentBatch.id);

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
    const childBatch: Batch = {
      id: generateBatchId(),
      platform: parentBatch.platform,
      screens: [],
      pins: [],
      createdAt: new Date().toISOString(),
      parentBatchId: parentBatch.id,
      status: 'queued',
    };

    await ensureDir(join(this.stagingRoot, childBatch.id));
    this.batches.set(childBatch.id, childBatch);
    return childBatch;
  }

  /**
   * Write the `parent.json` descriptor into a child batch's staging directory.
   *
   * The `parentTaskPath` field is reserved for task 005+ (once the clarifier
   * writes `tasks/inspector-...` directories, the reply's parent.json can
   * record that path). In v1 it is always `null`.
   *
   * @param childBatchId - Identifier of the child batch whose directory
   *   receives the file.
   * @param parentPin - Snapshot of the parent pin.
   * @param parentBatchId - Identifier of the parent batch.
   */
  private async writeParentJson(
    childBatchId: string,
    parentPin: Pin,
    parentBatchId: string,
  ): Promise<void> {
    const parentJsonPath = join(this.stagingRoot, childBatchId, 'parent.json');
    const payload = {
      parentPin,
      parentBatchId,
      parentTaskPath: null,
      childBatchId,
    };
    await atomicWriteFile(parentJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
