/**
 * Forjis Inspector v1.0 wire-protocol type declarations.
 *
 * This module FREEZES the v1.0 Inspector protocol. Every shape defined here is
 * part of the public contract between `@forjis/shared` and its five consumers
 * (facilitator, web dashboard, Vite plugin, SwiftUI SDK, Compose SDK). Any
 * breaking edit — renaming a field, removing a union member, widening a type,
 * or changing nullability — requires a coordinated multi-SDK release and a new
 * `PROTOCOL_VERSION` literal.
 *
 * No runtime code other than the `PROTOCOL_VERSION` constant lives here; every
 * other export is a type-only declaration erased at compile time.
 */

/**
 * Frozen v1.0 protocol identifier.
 *
 * The value is branded with `as const` so the resulting type narrows to the
 * literal `"forjis-inspector/1.0"`. Consumers can import it as both a value
 * (for `session.ack` payloads) and a type (`ProtocolVersion`).
 */
export const PROTOCOL_VERSION = 'forjis-inspector/1.0' as const;

/**
 * Literal type alias for {@link PROTOCOL_VERSION}.
 *
 * Use this when typing fields that carry the protocol identifier (for example
 * `session.ack.protocolVersion`) so the compiler rejects any other string.
 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Closed set of Inspector platform identifiers.
 *
 * Every SDK surface reports itself with exactly one of these literals during
 * `session.join`. Adding a new target platform is a breaking change.
 */
export type Platform = 'web' | 'compose' | 'swiftui';

/**
 * Lifecycle states of a pin batch as it moves through the Inspector pipeline.
 *
 * `queued` → batch is open and accepting pins.
 * `clarifying` → facilitator is asking clarify-chat questions.
 * `finalized` → clarify complete; batch is handed off to the runtime.
 * `running` → runtime is executing the resulting task.
 * `done` → runtime completed successfully.
 * `failed` → runtime completed with an error.
 */
export type BatchStatus =
  | 'queued'
  | 'clarifying'
  | 'finalized'
  | 'running'
  | 'done'
  | 'failed';

/**
 * Source-location pointer captured alongside a pin when the SDK can resolve
 * the originating file (typically via a Vite plugin or compiler integration).
 */
export interface PinSource {
  /** Absolute or workspace-relative path to the source file. */
  file: string;
  /** 1-based line number within {@link file}. */
  line: number;
  /** 1-based column number within {@link line}. */
  col: number;
}

/**
 * Axis-aligned bounding box in screen (pixel) coordinates.
 *
 * The origin is the top-left of the viewport. Widths and heights are positive.
 */
export interface Bbox {
  /** Left edge in pixels. */
  x: number;
  /** Top edge in pixels. */
  y: number;
  /** Width in pixels. */
  w: number;
  /** Height in pixels. */
  h: number;
}

/**
 * A single user-drawn overlay attached to a pin capture.
 *
 * `text` is only present when {@link Annotation.kind} is `"text"`, but it is
 * declared optional so the type remains a single interface for the whole
 * closed set of annotation kinds.
 */
export interface Annotation {
  /** Drawing primitive the annotation represents. */
  kind: 'box' | 'arrow' | 'text';
  /** Bounding box the annotation occupies in viewport pixels. */
  bbox: Bbox;
  /** Optional label; populated for `kind: "text"` annotations. */
  text?: string;
}

/**
 * Target descriptor for a pin — the element, region, or multi-selection that
 * the user pinned.
 */
export interface PinTarget {
  /** Whether the pin targets a single element, a free-form region, or multiple elements. */
  kind: 'element' | 'region' | 'multi';
  /** Resolved source pointer, or `null` when the SDK could not resolve it. */
  source: PinSource | null;
  /** DOM selector, platform-specific accessibility path, or region identifier. */
  selector: string;
  /** Human-readable component name, or `null` when unavailable. */
  componentName: string | null;
  /** Bounding box of the target in viewport pixels. */
  bbox: Bbox;
}

/**
 * Captured visual and styling data attached to a pin.
 *
 * Screenshots and computed styles are stored as opaque strings (data URLs or
 * runtime-defined references) so the wire format stays JSON-native.
 */
export interface PinCapture {
  /** Cropped screenshot of the target, as an opaque string reference. */
  elementScreenshot: string;
  /** Full viewport screenshot, as an opaque string reference. */
  viewportScreenshot: string;
  /** Serialized computed style block for the target. */
  computedStyles: string;
  /** User-drawn annotations overlaid on the element screenshot. */
  annotations: Annotation[];
}

/**
 * A single Inspector pin.
 *
 * Every field is wire-native (string, number, boolean, nullable primitive, or
 * arrays / objects of the same) so that a `Pin` round-trips losslessly through
 * `JSON.stringify` + `JSON.parse`.
 */
export interface Pin {
  /** Stable identifier assigned by the facilitator. */
  id: string;
  /** Platform the pin was captured from. */
  platform: Platform;
  /** Logical screen name, or `null` when the SDK does not report one. */
  screen: string | null;
  /** Target descriptor (element, region, or multi). */
  target: PinTarget;
  /** Captured visuals and styles. */
  capture: PinCapture;
  /** User-authored comment attached to the pin. */
  comment: string;
  /** ISO-8601 timestamp marking when the pin was created. */
  createdAt: string;
  /** Parent pin identifier when this pin is a reply; `null` for root pins. */
  parentPinId: string | null;
  /**
   * Grouping identifier shared by pins that were collected under one comment
   * via the SDK's "Add another pin" flow. `null` for solo pins. Pins that
   * carry the same non-null `commentGroupId` share comment text and
   * annotations but have distinct `target` / `capture` / `id` values.
   *
   * Additive extension added in task inspector-010. Because the change is
   * additive, `PROTOCOL_VERSION` remains `"forjis-inspector/1.0"`.
   */
  commentGroupId: string | null;
}

/**
 * A batch groups pins captured in a single Inspector session before they are
 * submitted to the runtime as a task.
 */
export interface Batch {
  /** Stable identifier assigned by the facilitator. */
  id: string;
  /** Platform that produced the batch. */
  platform: Platform;
  /** Logical screen names covered by the batch. */
  screens: string[];
  /** Pins currently attached to the batch. */
  pins: Pin[];
  /** ISO-8601 timestamp marking when the batch was created. */
  createdAt: string;
  /** Parent batch identifier when this batch is an iteration; `null` otherwise. */
  parentBatchId: string | null;
  /** Lifecycle state of the batch. */
  status: BatchStatus;
}

/**
 * A single selectable option in a clarify-chat question.
 */
export interface ClarifyOption {
  /** Stable identifier for the option. */
  id: string;
  /** Short, human-readable label. */
  label: string;
  /** Longer explanatory description shown alongside the label. */
  description: string;
}

/**
 * A clarify-chat question sent from the facilitator to the SDK so the user can
 * disambiguate intent before the batch is finalized.
 */
export interface ClarifyQuestion {
  /** Stable identifier for the question. */
  id: string;
  /** Question text shown to the user. */
  text: string;
  /** Closed-set options offered to the user. */
  options: ClarifyOption[];
  /** Whether the user may also provide a free-text answer. */
  allowFreeText: boolean;
}

/**
 * A user-supplied answer to a {@link ClarifyQuestion}.
 *
 * Exactly one of `optionId` and `freeText` is expected to be non-null, but the
 * type admits both being populated (to represent a selected option plus a
 * free-text clarification) or both being null in error paths. Wire-level
 * runtime validation is deferred to the transport layer.
 */
export interface ClarifyAnswer {
  /** Identifier of the question being answered. */
  questionId: string;
  /** Selected option identifier, or `null` when the user answered free-text only. */
  optionId: string | null;
  /** Free-text answer, or `null` when the user answered by option only. */
  freeText: string | null;
}

/**
 * The full Inspector v1.0 wire-message union.
 *
 * Every on-the-wire message is exactly one of the twelve members below,
 * discriminated by the `type` literal. Consumers MUST pattern-match with a
 * `switch (msg.type)` followed by a `never`-assignment to guarantee
 * compile-time exhaustiveness.
 *
 * The `batch.abort` member is a strictly additive extension added in task
 * inspector-005: it gives clients an explicit abort path for the clarifier
 * subprocess. Because the change is additive, `PROTOCOL_VERSION` remains
 * `"forjis-inspector/1.0"`.
 */
export type InspectorMessage =
  | { type: 'session.join'; token: string; platform: Platform; clientId: string }
  | { type: 'session.ack'; sessionId: string; protocolVersion: ProtocolVersion }
  | { type: 'session.error'; code: string; message: string }
  | { type: 'pin.create'; batchId: string; pin: Pin }
  | { type: 'pin.ack'; pinId: string }
  | { type: 'batch.submit'; batchId: string }
  | { type: 'clarify.question'; batchId: string; question: ClarifyQuestion }
  | { type: 'clarify.answer'; batchId: string; answer: ClarifyAnswer }
  | { type: 'batch.finalize'; batchId: string; taskPath: string }
  | { type: 'task.status'; batchId: string; status: BatchStatus; summary?: string }
  | {
      type: 'reply.create';
      parentPinId: string;
      pin: Pin;
      comment: string;
      /**
       * Summary of the failed parent task, forwarded verbatim into the child
       * batch's `parent.json` so the clarifier persona can cite the original
       * failure reason when drafting a follow-up task. Populated only when
       * the reply originated from a failure card (inspector-013); omitted
       * for ordinary replies.
       */
      failureSummary?: string;
      /**
       * Project-relative path of the failed parent task directory, forwarded
       * verbatim into the child batch's `parent.json` so the clarifier
       * persona can link to the upstream `events.jsonl` / `TASK.md` for
       * context. Populated only when the reply originated from a failure
       * card (inspector-013); omitted for ordinary replies.
       */
      failedTaskPath?: string;
    }
  | { type: 'batch.abort'; batchId: string };

/**
 * Compile-time exhaustiveness helper for {@link InspectorMessage}.
 *
 * Call this from the `default` branch of a `switch (msg.type)` to force the
 * TypeScript compiler to fail whenever a new message type is added without a
 * matching case. The runtime body throws so that an unexpected message type
 * produced by a buggy transport surfaces at runtime instead of silently
 * succeeding.
 *
 * @param value - The message that failed to match any case; typed `never` so
 *   the compiler rejects any other call site.
 * @throws {Error} Always. The message includes the unexpected value for
 *   diagnostics.
 */
export function assertNeverInspectorMessage(value: never): never {
  throw new Error(
    `Unhandled InspectorMessage: ${JSON.stringify(value)}`,
  );
}
