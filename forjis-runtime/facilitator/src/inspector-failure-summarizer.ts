/**
 * Single-turn LLM summarizer for inspector-task failures.
 *
 * Exposes {@link summarizeFailure}, a pure async function that turns
 * the tail of `.forjis/tasks/<taskId>/events.jsonl` into a ≤160-char
 * single-line reason string suitable for the
 * `task.status { status: 'failed', summary }` transport frame delivered
 * by {@link InspectorClarifierRunner} to the originating inspector
 * client.
 *
 * Design constraints (see
 * `openspec/changes/inspector-013-failure-surface/design.md` §D4,
 * §D7):
 *
 * - Exactly one engine invocation per call; no retries on any failure.
 * - Output is hard-capped at 1000 generated tokens (prompt-embedded
 *   instruction because the engine interface has no dedicated
 *   `maxOutputTokens` knob today). Post-trim enforces the 160-char
 *   ceiling regardless of how the model responds.
 * - 30-second wall-clock timeout via `Promise.race`; on timeout, throw
 *   and fall back.
 * - Never throws: on engine error, empty completion, empty event input,
 *   or timeout, resolves to a category-keyed static fallback string.
 * - Token usage is recorded on the injected {@link TokenTracker} only
 *   when the engine reports a non-empty `usage` object; fallback paths
 *   do not touch the tracker.
 *
 * The module also exposes {@link tailEventLog}, a streaming reverse-tail
 * helper over a newline-delimited log file. Co-located here because the
 * summarizer is the only consumer in v1.
 */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import type {
  EngineInvokeOptions,
  EngineResult,
  ForjisEngine,
} from './engine.js';
import type { TokenTracker } from './token-tracker.js';
import type { TaskEvent } from './types.js';
import type { FailureCategory } from './web-services/inspector-service.js';

/** Maximum number of generated tokens requested from the engine. */
const MAX_OUTPUT_TOKENS = 1000;

/** Target upper bound on the rendered prompt excerpt size (UTF-16 chars). */
const MAX_PROMPT_CHARS = 16 * 1024;

/** Hard ceiling on the number of event-log entries rendered into the prompt. */
const MAX_EVENTS_IN_PROMPT = 500;

/** Maximum characters in the final returned summary string. */
const SUMMARY_MAX_CHARS = 160;

/** Lower bound of the word-boundary search window before the hard cut. */
const SUMMARY_WORD_BOUNDARY_MIN = 140;

/** Wall-clock timeout for the single engine invocation. */
const ENGINE_TIMEOUT_MS = 30_000;

/** Fixed chunk size used by the reverse-streaming tail reader. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** Hard ceiling on the hard-cut fallback of raw engine output before post-trim. */
const RAW_OUTPUT_HARD_CAP_CHARS = 4000;

/**
 * Static fallback strings indexed by {@link FailureCategory}.
 *
 * Each fallback is a single line of ≤160 characters. The extra
 * `missing-log` key covers the "events.jsonl empty or unreadable"
 * branch that short-circuits before any engine call.
 */
const FALLBACK_STRINGS: Record<FailureCategory | 'missing-log', string> = {
  'engine-error':
    'Task failed during the orchestrator run. Check the dashboard events for details.',
  'no-pipeline-state': 'Orchestrator exited without producing a pipeline plan.',
  shutdown: 'Task interrupted during facilitator shutdown.',
  'missing-log': 'Task failed — no event log available.',
};

/**
 * Inputs accepted by {@link summarizeFailure}.
 *
 * `events` can be either a parsed array (the runner passes a
 * {@link tailEventLog} result) or a pre-rendered string (tests pass the
 * raw log text to skip the tailer entirely).
 */
export interface SummarizeFailureInput {
  /** Batch identifier the failing task was derived from. */
  batchId: string;
  /** Task identifier (always starts with `inspector-`). */
  taskId: string;
  /** Absolute path to `.forjis/tasks/<taskId>`. */
  taskPath: string;
  /** Failure category recorded at the originating run-loop call site. */
  category: FailureCategory;
  /**
   * Tail of `events.jsonl`. An empty array triggers the missing-log
   * fallback without any engine invocation. A string is treated as an
   * already-rendered excerpt (used in tests).
   */
  events: readonly TaskEvent[] | string;
  /** Engine used to produce the summary. */
  engine: ForjisEngine;
  /** Absolute project root. */
  projectDir: string;
  /** Absolute path to `.forjis/config/`. */
  configDir: string;
  /** Tracker that receives usage when the engine reports a non-empty `usage`. */
  tokenTracker: TokenTracker;
}

/** Alias documenting the summarizer's output contract. */
export type SummarizeFailureOutput = string;

/**
 * Produce a ≤160-character single-line failure summary for an inspector
 * task.
 *
 * Never throws. On engine error, empty completion, empty input, or
 * timeout, resolves to a category-keyed static fallback.
 *
 * @param input - Summarizer inputs.
 * @returns A non-empty, newline-free summary string of at most 160 chars.
 */
export async function summarizeFailure(
  input: SummarizeFailureInput,
): Promise<SummarizeFailureOutput> {
  const rendered = renderEventExcerpt(input.events);
  if (rendered.length === 0) {
    return FALLBACK_STRINGS['missing-log'];
  }

  const prompt = buildPrompt(input.category, rendered);

  const engineResult = await invokeEngineGuarded(input, prompt);
  if (engineResult === null) {
    return FALLBACK_STRINGS[input.category];
  }

  const trimmed = postTrim(engineResult.text);
  if (trimmed.length === 0) {
    return FALLBACK_STRINGS[input.category];
  }

  recordUsageIfPresent(input.tokenTracker, engineResult.usage, input.taskId);
  return trimmed;
}

// -- Prompt construction ----------------------------------------------------

/**
 * Build the inline prompt handed to the engine.
 *
 * Keeps the prompt under ten lines; no markdown, no persona file, no
 * system-prompt fragment. The `excerpt` is the whitespace-safe text of
 * the rendered event tail.
 *
 * @param category - Failure category recorded at the call site.
 * @param excerpt - Rendered tail of `events.jsonl`.
 * @returns Prompt string ready for `engine.invoke(..., { mode, modeArgs })`.
 */
function buildPrompt(category: FailureCategory, excerpt: string): string {
  return (
    `A Forjis orchestrator run failed.\n` +
    `Category: ${category}\n` +
    `Produce ONE short plain-text reason (max 160 chars), no markdown, no quotes, no newlines.\n` +
    `Focus on the most specific cause discoverable in the log excerpt below.\n` +
    `Do not exceed ${MAX_OUTPUT_TOKENS} output tokens.\n` +
    `---\n${excerpt}\n---\n`
  );
}

/**
 * Render a readable excerpt from parsed events or a raw string.
 *
 * String inputs pass through a character cap. Array inputs are trimmed
 * to the last {@link MAX_EVENTS_IN_PROMPT} entries, rendered one line
 * per event, then character-capped at {@link MAX_PROMPT_CHARS}.
 *
 * @param events - Events array or pre-rendered string.
 * @returns Excerpt text, possibly empty.
 */
function renderEventExcerpt(events: readonly TaskEvent[] | string): string {
  if (typeof events === 'string') {
    return capChars(events, MAX_PROMPT_CHARS);
  }
  if (events.length === 0) {
    return '';
  }
  const tail =
    events.length > MAX_EVENTS_IN_PROMPT
      ? events.slice(events.length - MAX_EVENTS_IN_PROMPT)
      : events;
  const lines = tail.map(renderEventLine);
  const joined = lines.join('\n');
  return capChars(joined, MAX_PROMPT_CHARS);
}

/**
 * Render a single TaskEvent as a compact one-line string.
 *
 * Never throws. The rendering is best-effort and deliberately
 * lossy — the LLM only needs enough signal to pick out the failing
 * tool/role pair.
 *
 * @param event - A {@link TaskEvent}.
 * @returns A single-line rendered string.
 */
function renderEventLine(event: TaskEvent): string {
  const ts = typeof event.timestamp === 'string' ? event.timestamp : '';
  const role = typeof event.role === 'string' ? event.role : '';
  const type = typeof event.type === 'string' ? event.type : '';
  const content = typeof event.content === 'string' ? event.content : '';
  const singleLine = content.replace(/\s+/g, ' ').trim();
  return `${ts} ${role} ${type} ${singleLine}`.trim();
}

/**
 * Character-cap a string.
 *
 * Returns the input unchanged when it is already within bounds.
 *
 * @param text - Input string.
 * @param max - Maximum character count.
 * @returns The capped string.
 */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

// -- Engine invocation ------------------------------------------------------

/**
 * Internal shape collected from the engine stream.
 *
 * `text` accumulates every assistant-content fragment. `usage` carries
 * the engine's reported token totals when available.
 */
interface EngineOutcome {
  text: string;
  usage: EngineResult['usage'];
}

/**
 * Invoke the engine under a timeout, capturing assistant text chunks.
 *
 * Returns `null` on any thrown error, timeout, or empty completion.
 * Every error path logs exactly one `[inspector-failure-summarizer]:`
 * warning line.
 *
 * @param input - Original summarizer inputs.
 * @param prompt - Fully rendered prompt string.
 * @returns Engine outcome, or `null` when the fallback must fire.
 */
async function invokeEngineGuarded(
  input: SummarizeFailureInput,
  prompt: string,
): Promise<EngineOutcome | null> {
  try {
    const outcome = await withTimeout(runEngine(input, prompt), ENGINE_TIMEOUT_MS);
    if (outcome.text.trim().length === 0) {
      logWarning(`engine returned empty completion for task "${input.taskId}"`);
      return null;
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning(`engine invocation failed for task "${input.taskId}": ${message}`);
    return null;
  }
}

/**
 * Drive one engine invocation and collect assistant output + usage.
 *
 * Uses the `'inspector-failure-summary'` mode so an engine adapter can
 * branch on the mode name if it needs a shorter system-prompt variant.
 *
 * @param input - Original summarizer inputs.
 * @param prompt - Fully rendered prompt string.
 * @returns Collected engine outcome.
 */
async function runEngine(
  input: SummarizeFailureInput,
  prompt: string,
): Promise<EngineOutcome> {
  let collected = '';
  const invokeOptions: EngineInvokeOptions = {
    projectDir: input.projectDir,
    taskId: input.taskId,
    taskDescription: `Inspector failure summary for ${input.taskId}`,
    configDir: input.configDir,
    mode: 'inspector-failure-summary',
    modeArgs: {
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    dryRun: false,
    onEvent: (event) => {
      if (event.type !== 'assistant') return;
      const content = typeof event.content === 'string' ? event.content : '';
      if (content.length === 0) return;
      // Interim guard until EngineInvokeOptions gains a first-class
      // maxOutputTokens field: cap the raw stream length so the
      // post-trim step never has to reduce an unbounded buffer.
      if (collected.length >= RAW_OUTPUT_HARD_CAP_CHARS) return;
      collected += content;
    },
  };

  const result = await input.engine.invoke(invokeOptions);
  return { text: collected, usage: result.usage };
}

/**
 * Race a promise against a timeout.
 *
 * Rejects with a dedicated timeout `Error` when `promise` does not
 * settle within `ms`. The timer is `unref()`'d so a pending timeout
 * does not keep the Node event loop alive.
 *
 * @param promise - Promise to race.
 * @param ms - Timeout in milliseconds.
 * @returns The resolved value of `promise`.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`engine invocation timed out after ${ms}ms`));
    }, ms);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

// -- Output trimming --------------------------------------------------------

/**
 * Normalise and trim the raw model output to the contract shape.
 *
 * Collapses all whitespace (including newlines) to single spaces,
 * strips surrounding whitespace, then truncates to at most
 * {@link SUMMARY_MAX_CHARS} characters, preferring a word boundary when
 * one exists within `[SUMMARY_WORD_BOUNDARY_MIN, SUMMARY_MAX_CHARS]`.
 *
 * @param raw - Raw model output.
 * @returns The cleaned summary.
 */
function postTrim(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) {
    return collapsed;
  }
  const head = collapsed.slice(0, SUMMARY_MAX_CHARS);
  const boundary = head.lastIndexOf(' ');
  if (boundary >= SUMMARY_WORD_BOUNDARY_MIN) {
    return head.slice(0, boundary);
  }
  return head;
}

// -- Token accounting -------------------------------------------------------

/**
 * Record token usage on the injected tracker when the engine reports it.
 *
 * @param tokenTracker - Tracker injected by the caller.
 * @param usage - Optional usage payload from {@link EngineResult}.
 * @param taskId - Task identifier used as the tracker tag.
 */
function recordUsageIfPresent(
  tokenTracker: TokenTracker,
  usage: EngineResult['usage'],
  taskId: string,
): void {
  if (!usage) return;
  tokenTracker.recordUsage(usage.inputTokens, usage.outputTokens, taskId);
}

// -- Streaming reverse tail reader for events.jsonl -------------------------

/**
 * Read the last `maxLines` newline-terminated JSON records from a file.
 *
 * Opens the file, seeks to the end, and reads {@link TAIL_CHUNK_BYTES}
 * backwards until `maxLines` newlines have been collected or the head
 * is reached. Lines that fail `JSON.parse` are silently dropped. When
 * the head was not reached, the first (leading) partial line is
 * discarded to avoid returning truncated JSON.
 *
 * Returns an empty array on any read error (missing file, permission
 * denied, etc.). Never throws.
 *
 * @param absolutePath - Absolute path of the `events.jsonl` file.
 * @param maxLines - Maximum number of lines to return.
 * @returns The parsed tail in chronological order.
 */
export async function tailEventLog(
  absolutePath: string,
  maxLines: number,
): Promise<readonly TaskEvent[]> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(absolutePath, 'r');
    const stats = await handle.stat();
    const fileSize = Number(stats.size);
    if (fileSize === 0 || maxLines <= 0) {
      return [];
    }
    const { tail, headReached } = await readTailChunks(handle, fileSize, maxLines);
    return parseTailBuffer(tail, maxLines, headReached);
  } catch {
    return [];
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* best-effort close */
      }
    }
  }
}

/**
 * Read backwards in fixed chunks until `maxLines` newlines are found
 * or the start of the file is reached.
 *
 * @param handle - Open file handle.
 * @param fileSize - Total file size in bytes.
 * @param maxLines - Number of newlines to accumulate before stopping.
 * @returns Concatenated tail buffer and whether the head was reached.
 */
async function readTailChunks(
  handle: FileHandle,
  fileSize: number,
  maxLines: number,
): Promise<{ tail: Buffer; headReached: boolean }> {
  let position = fileSize;
  const collected: Buffer[] = [];
  let newlineCount = 0;

  while (position > 0 && newlineCount <= maxLines) {
    const readSize = Math.min(TAIL_CHUNK_BYTES, position);
    const start = position - readSize;
    const chunk = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(chunk, 0, readSize, start);
    const slice = chunk.subarray(0, bytesRead);
    collected.unshift(Buffer.from(slice));
    position = start;
    for (const byte of slice) {
      if (byte === 0x0a) newlineCount += 1;
    }
  }

  return { tail: Buffer.concat(collected), headReached: position === 0 };
}

/**
 * Parse the concatenated tail buffer into `TaskEvent` objects.
 *
 * Discards the leading partial line when the head was not reached,
 * drops JSON parse failures silently, and keeps only the last
 * `maxLines` entries.
 *
 * @param tail - Tail buffer produced by {@link readTailChunks}.
 * @param maxLines - Hard cap on returned entries.
 * @param headReached - Whether the first byte of the file is included.
 * @returns Parsed events in chronological order.
 */
function parseTailBuffer(
  tail: Buffer,
  maxLines: number,
  headReached: boolean,
): readonly TaskEvent[] {
  const text = tail.toString('utf-8');
  const rawLines = text.split('\n');
  // Drop the trailing element produced by a terminating newline.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  // Discard the leading partial line when we didn't reach the file head.
  const lines = headReached ? rawLines : rawLines.slice(1);
  const selected =
    lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  const events: TaskEvent[] = [];
  for (const line of selected) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTaskEventShape(parsed)) {
        events.push(parsed);
      }
    } catch {
      /* drop malformed lines silently */
    }
  }
  return events;
}

/**
 * Runtime shape check for {@link TaskEvent}.
 *
 * Only requires the minimal fields the renderer reads; extra fields are
 * passed through unchanged.
 *
 * @param value - Parsed JSON value.
 * @returns `true` when the value is structurally compatible with {@link TaskEvent}.
 */
function isTaskEventShape(value: unknown): value is TaskEvent {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec['timestamp'] === 'string' &&
    typeof rec['type'] === 'string' &&
    typeof rec['role'] === 'string' &&
    typeof rec['content'] === 'string'
  );
}

// -- Logging ----------------------------------------------------------------

/**
 * Emit a single-line diagnostic to stderr prefixed with the module tag.
 *
 * Keeping this small helper in one place guarantees the tag is
 * consistent across fallback paths.
 *
 * @param message - Human-readable diagnostic.
 */
function logWarning(message: string): void {
  console.warn(`[inspector-failure-summarizer]: ${message}`);
}
