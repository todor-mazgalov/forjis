/**
 * Runtime wiring for the Inspector clarifier subprocess.
 *
 * Exports {@link InspectorClarifierRunner}, which subscribes to
 * {@link InspectorServiceImpl}'s in-process event emitter, spawns the
 * clarifier persona as a long-lived engine subprocess when a batch is
 * submitted, bridges WebSocket chat traffic to and from the subprocess
 * stdio, enforces turn/token/abort guardrails, and finalises each
 * successful run as a `tasks/inspector-<slug>/` directory that the
 * existing {@link TaskQueue} watcher can ingest.
 *
 * The runner deliberately never constructs prompt text itself — the
 * orchestrator-side `forjis-inspector-clarify` command is the sole
 * prompt author (see
 * `forjis-runtime/orchestrator/.claude/commands/forjis-inspector-clarify.md`
 * and pillars/architecture.md). The runner only forwards raw pin data
 * plus the persona body through `modeArgs`.
 */

import { readFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  Batch,
  ClarifyAnswer,
  ClarifyQuestion,
  InspectorTransport,
} from '@forjis/shared';

import type {
  EngineInvokeOptions,
  EngineResult,
  ForjisEngine,
} from './engine.js';
import { EngineCapabilityError } from './errors.js';
import type { ClarifierAgent } from './inspector-agent-loader.js';
import {
  summarizeFailure,
  tailEventLog,
} from './inspector-failure-summarizer.js';
import { atomicWriteFile, ensureDir } from './state.js';
import type { TaskEvent } from './types.js';
import { killProcess, readPidSync } from './process-utils.js';
import type { TokenTracker } from './token-tracker.js';
import type {
  BatchFailedEventPayload,
  InspectorServiceImpl,
} from './web-services/inspector-service.js';

/** Default hard cap on outbound `clarify.question` events per run. */
const DEFAULT_MAX_TURNS = 10;

/**
 * Maximum number of `{ batchId: clientId }` entries retained in the
 * {@link InspectorClarifierRunner.recentBatchClients} FIFO map.
 *
 * Bounds memory growth for long-running dev sessions; 50 covers the
 * common case where an orchestrator run failure arrives within minutes
 * of the clarifier finalising.
 */
const RECENT_BATCH_CLIENTS_MAX = 50;

/**
 * Maximum number of log entries sampled from `events.jsonl` when
 * building a failure summary. Kept in sync with the summarizer module's
 * own cap so the two agree on the tail window.
 */
const FAILURE_TAIL_MAX_LINES = 500;

/**
 * Grace period between a `"budget.exceeded"` hint being injected and a
 * forced abort. The clarifier is expected to emit a terminal `finalize`
 * within this window; otherwise the runner tears the subprocess down
 * itself so the batch cannot hang.
 */
const BUDGET_GRACE_MS = 30_000;

/**
 * Synthetic user turn injected when the per-run turn cap is reached.
 *
 * The clarifier persona's "Termination" section documents this exact
 * string, so it must be kept in sync with
 * `forjis-runtime/facilitator/assets/forjis-inspector.md`.
 */
const TURN_LIMIT_HINT =
  'You have reached the turn limit. Emit finalize with best-effort ' +
  'assumptions in an ## Assumptions section.';

/**
 * Sentinel value that the clarifier persona treats as terminal per its
 * "Termination" contract. Documented in the persona body and the
 * `forjis-inspector-clarify` orchestrator command.
 */
const BUDGET_HINT = 'budget.exceeded';

/**
 * Sentinel {@link ClarifyAnswer.freeText} the client may send to force a
 * finalize-with-assumptions. Also documented in the persona contract.
 */
const ABORT_FREE_TEXT = '__abort__';

/** Reason codes recorded on {@link ActiveRun.terminalReason}. */
type TerminalReason = 'finalize' | 'abort' | 'budget' | 'turn-limit';

/**
 * Finalise payload emitted by the clarifier subprocess.
 *
 * Mirrors the JSON shape documented in
 * `forjis-runtime/facilitator/assets/forjis-inspector.md` "Output
 * contract". Fields are modelled as `unknown` inside {@link metadata}
 * because the clarifier's metadata shape may evolve independently of
 * the runner; the runner writes the object verbatim to
 * `metadata.json` rather than validating it.
 */
interface FinalizePayload {
  taskDir: string;
  taskMd: string;
  metadata: Record<string, unknown>;
}

/**
 * Question payload emitted by the clarifier subprocess.
 *
 * The nested `question` field matches the {@link ClarifyQuestion} type
 * from `@forjis/shared`; the outer envelope is the discriminated-union
 * wrapper the subprocess writes to stdout.
 */
interface QuestionPayload {
  question: ClarifyQuestion;
}

/** Per-turn record captured for later `chat-transcript.md` rendering. */
interface TranscriptEntry {
  question: ClarifyQuestion;
  answer: ClarifyAnswer | null;
}

/**
 * In-memory record describing a single clarifier subprocess's lifecycle.
 *
 * Kept inside the runner's `runs` map keyed by batch id. The entry is
 * removed once the batch either finalises or is aborted.
 */
interface ActiveRun {
  batchId: string;
  batch: Batch;
  originatingClientId: string | null;
  turnCount: number;
  terminalReason: TerminalReason | null;
  transcript: TranscriptEntry[];
  pendingQuestion: ClarifyQuestion | null;
  enginePromise: Promise<EngineResult>;
  budgetBreached: boolean;
  budgetTimer: NodeJS.Timeout | null;
  /** Answers buffered before the first assistant JSON event arrived. */
  pendingAnswerBuffer: Array<{ answer: ClarifyAnswer; clientId: string | null }>;
  firstAssistantSeen: boolean;
  firstEngineEventLogged: boolean;
  finalised: boolean;
}

/**
 * Signature for the function the runner uses to resolve the clarifier
 * persona at `beginRun` time.
 *
 * Matches `loadClarifierAgent(config?, configDir?)` from
 * {@link ./inspector-agent-loader.js} but typed here as a narrower
 * contract so callers can inject a test double.
 */
export type ClarifierPersonaLoader = (configDir: string) => ClarifierAgent;

/**
 * Options accepted by {@link InspectorClarifierRunner}'s constructor.
 *
 * Every field is required except `maxTurns`. Production wiring supplies
 * the project root, the staging directory, and the resolved config
 * directory from `@forjis/resolver` output; tests inject a `mkdtemp`
 * scratch space for each field so nothing leaks outside the test sandbox.
 */
export interface InspectorClarifierRunnerOptions {
  /** Engine used to spawn the clarifier subprocess. */
  engine: ForjisEngine;
  /** Service whose in-process events drive the runner. */
  service: InspectorServiceImpl;
  /** Transport used for outbound `clarify.question` and `batch.finalize` frames. */
  transport: InspectorTransport;
  /** Read-only handle used to read cumulative token usage. */
  tokenTracker: TokenTracker;
  /** Resolves the clarifier persona at `beginRun` time. */
  personaLoader: ClarifierPersonaLoader;
  /** Absolute project root (where `tasks/` lives). */
  projectDir: string;
  /** Absolute path to `.forjis/config/`. */
  configDir: string;
  /** Absolute path to `.forjis/inspector/` — the batch staging root. */
  stagingRoot: string;
  /**
   * Token-budget ceiling. `null` disables the budget guardrail entirely
   * (the runner matches production behaviour when no token-budget.yaml
   * exists).
   */
  tokenBudget: { maxTokens: number } | null;
  /** Hard cap on outbound question events per run. Default {@link DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
}

/**
 * Runtime coordinator that connects the Inspector service, the engine,
 * and the WebSocket transport into a working clarify-chat loop.
 *
 * Constructed once per facilitator process and kept alive for its
 * lifetime. Event subscriptions are registered inside {@link start} and
 * cleared inside {@link stop}; the runner is idempotent with respect to
 * both lifecycle calls.
 */
export class InspectorClarifierRunner {
  private readonly options: Required<Omit<InspectorClarifierRunnerOptions, 'tokenBudget' | 'maxTurns'>> & {
    tokenBudget: { maxTokens: number } | null;
    maxTurns: number;
  };
  private readonly runs = new Map<string, ActiveRun>();
  /**
   * Bounded FIFO map from `batchId` to the originating `clientId`.
   *
   * Populated at finalize time so failure events that arrive after the
   * clarifier subprocess has already torn down (the common case) can
   * still be routed back to the correct inspector client. Insertion
   * order matters — the oldest entry is evicted once the map size
   * exceeds {@link RECENT_BATCH_CLIENTS_MAX}.
   */
  private readonly recentBatchClients = new Map<string, string>();
  private started = false;
  private readonly onBatchSubmitted: (payload: { batch: Batch }) => void;
  private readonly onClarifyAnswer: (payload: {
    batchId: string;
    answer: ClarifyAnswer;
    clientId: string | null;
  }) => void;
  private readonly onBatchAbort: (payload: { batchId: string; clientId: string | null }) => void;
  private readonly onBatchFailed: (payload: BatchFailedEventPayload) => void;

  /**
   * Build a new runner.
   *
   * The constructor only captures references; no side effects occur
   * until {@link start} is called.
   *
   * @param options - Runner configuration.
   */
  constructor(options: InspectorClarifierRunnerOptions) {
    this.options = {
      engine: options.engine,
      service: options.service,
      transport: options.transport,
      tokenTracker: options.tokenTracker,
      personaLoader: options.personaLoader,
      projectDir: options.projectDir,
      configDir: options.configDir,
      stagingRoot: options.stagingRoot,
      tokenBudget: options.tokenBudget,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    };

    this.onBatchSubmitted = ({ batch }) => {
      this.beginRun(batch);
    };
    this.onClarifyAnswer = ({ batchId, answer, clientId }) => {
      this.forwardAnswer(batchId, answer, clientId).catch((err) => {
        this.handleAnswerError(batchId, clientId, err);
      });
    };
    this.onBatchAbort = ({ batchId, clientId }) => {
      this.abortRun(batchId, 'abort', clientId).catch((err) => {
        console.warn(
          `[inspector-clarifier-runner]: abort failed for "${batchId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    };
    this.onBatchFailed = (payload) => {
      void this.handleFailure(payload).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[inspector-clarifier-runner]: failure handler threw for "${payload.batchId}": ${message}`,
        );
      });
    };
  }

  /**
   * Register event subscriptions on the injected service.
   *
   * Idempotent: a second `start()` call is a no-op until {@link stop} is
   * called in between.
   */
  start(): void {
    if (this.started) return;
    const { service } = this.options;
    service.on('batch.submitted', this.onBatchSubmitted);
    service.on('clarify.answer', this.onClarifyAnswer);
    service.on('batch.abort', this.onBatchAbort);
    service.on('batch.failed', this.onBatchFailed);
    this.started = true;
  }

  /**
   * Remove event subscriptions and abort every live run.
   *
   * Each active run is aborted with the synthetic reason `"abort"` so
   * downstream tooling sees an ordinary inspector task directory with
   * an `## Assumptions` section.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    const { service } = this.options;
    service.off('batch.submitted', this.onBatchSubmitted);
    service.off('clarify.answer', this.onClarifyAnswer);
    service.off('batch.abort', this.onBatchAbort);
    service.off('batch.failed', this.onBatchFailed);
    this.started = false;

    const batchIds = Array.from(this.runs.keys());
    await Promise.all(
      batchIds.map((batchId) => this.abortRun(batchId, 'abort', null).catch(() => {
        /* best-effort */
      })),
    );
  }

  /**
   * Count of currently live subprocesses.
   *
   * @returns The number of entries in the active-run map.
   */
  activeRunCount(): number {
    return this.runs.size;
  }

  /**
   * Begin a new clarifier run for `batch`.
   *
   * Loads the persona, constructs `modeArgs`, and spawns the engine
   * subprocess via {@link ForjisEngine.invoke}. The resulting promise is
   * tracked inside the returned {@link ActiveRun} record; its resolution
   * or rejection is handled by {@link finishRun}.
   *
   * @param batch - The submitted batch (already in status `"clarifying"`).
   */
  private beginRun(batch: Batch): void {
    if (this.runs.has(batch.id)) return;

    const persona = this.options.personaLoader(this.options.configDir);
    const stagingDir = join(this.options.stagingRoot, batch.id);

    console.log(
      `[clarifier]: run ${batch.id} started (cwd=${stagingDir}, persona=${persona.name})`,
    );

    const run: ActiveRun = {
      batchId: batch.id,
      batch,
      originatingClientId: null,
      turnCount: 0,
      terminalReason: null,
      transcript: [],
      pendingQuestion: null,
      enginePromise: Promise.resolve({
        exitCode: 0,
        taskId: batch.id,
        stage: null,
      } satisfies EngineResult),
      budgetBreached: false,
      budgetTimer: null,
      pendingAnswerBuffer: [],
      firstAssistantSeen: false,
      firstEngineEventLogged: false,
      finalised: false,
    };

    this.runs.set(batch.id, run);

    this.loadParentContext(batch)
      .then((parentContext) => {
        const modeArgs: Record<string, unknown> = {
          batchId: batch.id,
          batchDir: stagingDir,
          pins: JSON.stringify(batch.pins),
          personaBody: persona.body,
          personaModel: persona.model,
          personaTools: persona.tools.join(','),
        };
        if (parentContext !== null) {
          modeArgs.parentContext = JSON.stringify(parentContext);
        }

        const invokeOptions: EngineInvokeOptions = {
          projectDir: this.options.projectDir,
          taskId: batch.id,
          taskDescription: `Inspector clarifier for batch ${batch.id}`,
          configDir: this.options.configDir,
          mode: 'inspector-clarify',
          modeArgs,
          dryRun: false,
          onEvent: (event) => this.ingestEngineEvent(batch.id, event),
        };

        run.enginePromise = this.options.engine.invoke(invokeOptions);
        void run.enginePromise
          .then((result) => this.finishRun(batch.id, result, null))
          .catch((err: unknown) => this.finishRun(batch.id, null, err));
      })
      .catch((err: unknown) => {
        this.runs.delete(batch.id);
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[inspector-clarifier-runner]: failed to start run for "${batch.id}": ${message}`,
        );
      });
  }

  /**
   * Resolve the parent-reply context for a batch, when present.
   *
   * Reads `<stagingRoot>/<batchId>/parent.json` and returns the parsed
   * object. Returns `null` for batches without `parentBatchId` or when
   * the file is missing or unreadable.
   *
   * The returned value is an opaque `Record<string, unknown>` — the
   * runner does not validate its shape. In particular, the optional
   * `failureSummary: string` and `failedTaskPath: string` fields added
   * by the inspector-failure-reply flow are forwarded verbatim into
   * `modeArgs.parentContext` so the clarifier persona can consume them
   * without any facilitator-side transformation.
   *
   * @param batch - Batch whose parent context should be loaded.
   * @returns The parsed parent context object, or `null`.
   */
  private async loadParentContext(batch: Batch): Promise<Record<string, unknown> | null> {
    if (batch.parentBatchId === null) return null;
    const parentPath = join(this.options.stagingRoot, batch.id, 'parent.json');
    try {
      const raw = await readFile(parentPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Process a stream-json event produced by the clarifier subprocess.
   *
   * Only assistant-text events are candidates; other event types are
   * ignored (tool_use, tool_result, result, system). Malformed JSON
   * lines are dropped silently with a diagnostic warning (matches the
   * clarifier persona's "Output contract").
   *
   * Emits an unconditional `[clarifier]: run <batchId> engine event
   * type=<type>` log for every inbound event — before the
   * assistant-only filter — so operators can observe whether the
   * subprocess is producing any stream events at all (the
   * inspector-019 failure mode was complete silence after the initial
   * spawn log).
   *
   * @param batchId - Identifier of the run the event belongs to.
   * @param event - Parsed stream event from the engine.
   */
  private ingestEngineEvent(batchId: string, event: TaskEvent): void {
    const run = this.runs.get(batchId);
    if (!run) return;
    console.log(
      `[clarifier]: run ${batchId} engine event type=${event.type}`,
    );
    if (!run.firstEngineEventLogged) {
      run.firstEngineEventLogged = true;
      console.log(
        `[clarifier]: run ${batchId} first engine event type=${event.type}`,
      );
    }
    if (event.type !== 'assistant') return;

    const text = extractAssistantText(event);
    if (text === null) return;

    console.log(
      `[clarifier]: run ${batchId} assistant-text bytes=${text.length} preview=${truncate(text, 80)}`,
    );

    const parsed = tryParseJson(text);
    if (parsed === null) {
      console.warn(
        `[inspector-clarifier-runner]: dropping malformed assistant line for "${batchId}": ${truncate(text, 200)}`,
      );
      return;
    }

    run.firstAssistantSeen = true;
    this.flushPendingAnswers(run);

    if (isQuestionPayload(parsed)) {
      this.handleQuestion(run, parsed.question);
      return;
    }

    if (isFinalizePayload(parsed)) {
      void this.handleFinalize(run, parsed).catch((err: unknown) => {
        this.emitSessionError(run, 'FINALIZE_FAILED', err);
      });
      return;
    }
  }

  /**
   * Enforce the turn-limit guardrail and forward valid questions to the
   * transport.
   *
   * Questions arriving after the turn cap or after a budget breach are
   * dropped. The first question that exceeds the cap triggers a
   * synthetic turn-limit user turn via
   * {@link ForjisEngine.onUserMessage}.
   *
   * @param run - Active run the question belongs to.
   * @param question - Parsed clarify question.
   */
  private handleQuestion(run: ActiveRun, question: ClarifyQuestion): void {
    if (run.budgetBreached || run.terminalReason === 'turn-limit') {
      return;
    }
    if (run.turnCount >= this.options.maxTurns) {
      run.terminalReason = 'turn-limit';
      this.injectUserMessage(run, TURN_LIMIT_HINT);
      return;
    }

    run.turnCount += 1;
    run.pendingQuestion = question;
    const clientId = run.originatingClientId;
    if (clientId !== null) {
      this.options.transport.send(clientId, {
        type: 'clarify.question',
        batchId: run.batchId,
        question,
      });
    }

    if (this.options.tokenBudget !== null) {
      const ratio = this.options.tokenTracker.getUsageRatio(
        this.options.tokenBudget.maxTokens,
      );
      if (ratio >= 1.0) {
        this.triggerBudgetBreach(run);
      }
    }
  }

  /**
   * Forward an inbound `clarify.answer` into the running subprocess.
   *
   * When the subprocess has not emitted its first assistant event yet
   * (the Claude CLI initialisation may still be in flight), the answer
   * is buffered and replayed once {@link ingestEngineEvent} sees the
   * first assistant turn. A `freeText === "__abort__"` answer triggers
   * the abort flow instead of being written to stdin.
   *
   * @param batchId - Identifier of the run the answer belongs to.
   * @param answer - Clarify answer payload.
   * @param clientId - Originating client id, or `null` for non-pump
   *   callers.
   */
  private async forwardAnswer(
    batchId: string,
    answer: ClarifyAnswer,
    clientId: string | null,
  ): Promise<void> {
    const run = this.runs.get(batchId);
    if (!run || run.finalised) return;

    if (clientId !== null && run.originatingClientId === null) {
      run.originatingClientId = clientId;
    }

    if (run.pendingQuestion !== null) {
      run.transcript.push({ question: run.pendingQuestion, answer });
      run.pendingQuestion = null;
    }

    if (answer.freeText === ABORT_FREE_TEXT) {
      await this.abortRun(batchId, 'abort', clientId);
      return;
    }

    if (!run.firstAssistantSeen) {
      run.pendingAnswerBuffer.push({ answer, clientId });
      return;
    }

    await this.injectUserMessageAsync(run, JSON.stringify(answer));
  }

  /**
   * Flush answers buffered while waiting for the subprocess's first
   * assistant event.
   *
   * Called by {@link ingestEngineEvent} once a valid JSON assistant
   * turn has arrived. The subprocess is guaranteed to have consumed its
   * initial prompt by that point.
   *
   * @param run - Active run whose buffer to drain.
   */
  private flushPendingAnswers(run: ActiveRun): void {
    if (run.pendingAnswerBuffer.length === 0) return;
    const buffered = run.pendingAnswerBuffer.splice(0, run.pendingAnswerBuffer.length);
    for (const { answer } of buffered) {
      void this.injectUserMessageAsync(run, JSON.stringify(answer));
    }
  }

  /**
   * Synchronous fire-and-forget wrapper around
   * {@link ForjisEngine.onUserMessage}.
   *
   * Used by the turn-limit and budget hints that run from synchronous
   * callbacks; rejections are logged and surfaced via
   * `session.error { code: "ENGINE_UNSUPPORTED" }` to the originating
   * client.
   *
   * @param run - Active run the message targets.
   * @param text - Text payload to append as a user turn.
   */
  private injectUserMessage(run: ActiveRun, text: string): void {
    void this.injectUserMessageAsync(run, text).catch((err) => {
      this.handleAnswerError(run.batchId, run.originatingClientId, err);
    });
  }

  /**
   * Async wrapper around {@link ForjisEngine.onUserMessage} that
   * validates engine capability and surfaces a descriptive error when
   * the adapter omits the method.
   *
   * @param run - Active run the message targets.
   * @param text - Text payload to append as a user turn.
   */
  private async injectUserMessageAsync(run: ActiveRun, text: string): Promise<void> {
    const { engine } = this.options;
    if (typeof engine.onUserMessage !== 'function') {
      throw new EngineCapabilityError(
        engine.name,
        'onUserMessage',
        `cannot inject clarify answer into batch "${run.batchId}"`,
      );
    }
    await engine.onUserMessage(run.batchId, text);
  }

  /**
   * Translate an {@link EngineCapabilityError} raised while forwarding
   * an answer into a `session.error` frame on the originating client.
   *
   * Other error types are logged but not echoed; non-capability errors
   * typically indicate a bug in the engine adapter itself and should
   * surface in the server logs rather than as a user-facing message.
   *
   * @param batchId - Identifier of the run that raised the error.
   * @param clientId - Client id to address, or `null` when the runner
   *   cannot route the frame.
   * @param err - The caught error.
   */
  private handleAnswerError(
    batchId: string,
    clientId: string | null,
    err: unknown,
  ): void {
    if (err instanceof EngineCapabilityError) {
      if (clientId !== null) {
        this.options.transport.send(clientId, {
          type: 'session.error',
          code: 'ENGINE_UNSUPPORTED',
          message: err.message,
        });
      }
      // Engine can't accept the answer — nothing else to do; the run
      // will either finalise on its own or be aborted by the caller.
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[inspector-clarifier-runner]: answer injection failed for "${batchId}": ${message}`,
    );
  }

  /**
   * Mark the run as budget-breached and schedule a forced abort when
   * the subprocess does not finalise within {@link BUDGET_GRACE_MS}.
   *
   * @param run - Active run to mark.
   */
  private triggerBudgetBreach(run: ActiveRun): void {
    if (run.budgetBreached) return;
    run.budgetBreached = true;
    run.terminalReason = 'budget';
    this.injectUserMessage(run, BUDGET_HINT);

    run.budgetTimer = setTimeout(() => {
      void this.abortRun(run.batchId, 'budget', run.originatingClientId).catch(() => {
        /* best-effort */
      });
    }, BUDGET_GRACE_MS);
    if (typeof run.budgetTimer.unref === 'function') {
      run.budgetTimer.unref();
    }
  }

  /**
   * Finalise the batch by writing the task directory, moving staged
   * pin files, emitting a `batch.finalize` frame, and deleting the
   * staging directory.
   *
   * Follows the seven-step flow documented in design.md §D9. Any error
   * during steps 1–4 aborts the finalise; the staging directory is left
   * intact so the caller can retry.
   *
   * @param run - Active run to finalise.
   * @param payload - The `finalize` payload from the subprocess.
   */
  private async handleFinalize(run: ActiveRun, payload: FinalizePayload): Promise<void> {
    if (run.finalised) return;
    if (run.terminalReason === null) {
      run.terminalReason = 'finalize';
    }

    const { projectDir, stagingRoot, transport } = this.options;
    const targetDir = join(projectDir, payload.taskDir);
    console.log(
      `[clarifier]: run ${run.batchId} finalize taskDir=${targetDir}`,
    );
    await ensureDir(targetDir);

    await atomicWriteFile(join(targetDir, 'TASK.md'), payload.taskMd);
    await atomicWriteFile(
      join(targetDir, 'metadata.json'),
      `${JSON.stringify(payload.metadata, null, 2)}\n`,
    );

    const stagingDir = join(stagingRoot, run.batchId);
    await this.movePinFiles(stagingDir, targetDir);

    await atomicWriteFile(
      join(targetDir, 'chat-transcript.md'),
      renderTranscript(run.batchId, run.transcript, run.terminalReason ?? 'finalize'),
    );

    if (run.originatingClientId !== null) {
      transport.send(run.originatingClientId, {
        type: 'batch.finalize',
        batchId: run.batchId,
        taskPath: payload.taskDir,
      });
      this.rememberClient(run.batchId, run.originatingClientId);
    }

    await rm(stagingDir, { recursive: true, force: true });

    run.finalised = true;
    if (run.budgetTimer) {
      clearTimeout(run.budgetTimer);
      run.budgetTimer = null;
    }
    this.runs.delete(run.batchId);
  }

  /**
   * Store a `batchId → clientId` mapping with FIFO eviction.
   *
   * Keeps the most recent {@link RECENT_BATCH_CLIENTS_MAX} entries. When
   * a new entry would push the map past the cap, the oldest entry (the
   * first key in insertion order) is evicted. Re-inserting an existing
   * key refreshes its position to the end of the insertion order.
   *
   * @param batchId - Identifier the failure event will carry.
   * @param clientId - Originating inspector client identifier.
   */
  private rememberClient(batchId: string, clientId: string): void {
    if (this.recentBatchClients.has(batchId)) {
      this.recentBatchClients.delete(batchId);
    }
    this.recentBatchClients.set(batchId, clientId);
    while (this.recentBatchClients.size > RECENT_BATCH_CLIENTS_MAX) {
      const firstKey = this.recentBatchClients.keys().next().value;
      if (firstKey === undefined) break;
      this.recentBatchClients.delete(firstKey);
    }
  }

  /**
   * Handle a `batch.failed` event for an inspector-sourced task.
   *
   * Resolves the originating client, tails `events.jsonl`, asks
   * {@link summarizeFailure} for a bounded reason string, and sends a
   * `task.status { status: 'failed', summary }` transport frame to that
   * client. Never throws; all error paths log exactly one
   * `[inspector-clarifier-runner]:` warning and return.
   *
   * @param payload - Failure-event payload from `InspectorServiceImpl`.
   */
  private async handleFailure(payload: BatchFailedEventPayload): Promise<void> {
    if (!payload.taskId.startsWith('inspector-')) {
      return;
    }
    const clientId =
      this.runs.get(payload.batchId)?.originatingClientId ??
      this.recentBatchClients.get(payload.batchId) ??
      null;
    if (clientId === null) {
      console.warn(
        `[inspector-clarifier-runner]: no client id for failed batch "${payload.batchId}"`,
      );
      return;
    }

    try {
      const events = await tailEventLog(
        join(payload.taskPath, 'events.jsonl'),
        FAILURE_TAIL_MAX_LINES,
      );
      const summary = await summarizeFailure({
        batchId: payload.batchId,
        taskId: payload.taskId,
        taskPath: payload.taskPath,
        category: payload.category,
        events,
        engine: this.options.engine,
        projectDir: this.options.projectDir,
        configDir: this.options.configDir,
        tokenTracker: this.options.tokenTracker,
      });
      this.options.transport.send(clientId, {
        type: 'task.status',
        batchId: payload.batchId,
        status: 'failed',
        summary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[inspector-clarifier-runner]: failed to deliver failure summary for "${payload.batchId}": ${message}`,
      );
    }
  }

  /**
   * Move every `pin-NN-*.png` and `pin-NN-*.json` entry from the
   * staging dir into the target task dir. Non-matching entries
   * (for example `parent.json`) are left behind so the staging dir is
   * safe to delete in bulk afterwards.
   *
   * @param stagingDir - Source directory (the batch's staging folder).
   * @param targetDir - Destination directory (the new task folder).
   */
  private async movePinFiles(stagingDir: string, targetDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(stagingDir);
    } catch {
      return;
    }
    const pattern = /^pin-\d+-.+\.(png|json)$/;
    for (const entry of entries) {
      if (!pattern.test(entry)) continue;
      await rename(join(stagingDir, entry), join(targetDir, entry));
    }
  }

  /**
   * Abort the clarifier subprocess for a batch and synthesise a
   * finalise-with-assumptions payload so downstream tooling sees a
   * well-formed task directory regardless of the abort trigger.
   *
   * @param batchId - Identifier of the run to abort.
   * @param reason - Why the run is being aborted. Recorded in the
   *   transcript footer.
   * @param clientId - Originating client id (may be `null`).
   */
  private async abortRun(
    batchId: string,
    reason: TerminalReason,
    clientId: string | null,
  ): Promise<void> {
    const run = this.runs.get(batchId);
    if (!run || run.finalised) return;
    if (run.originatingClientId === null && clientId !== null) {
      run.originatingClientId = clientId;
    }
    console.log(`[clarifier]: run ${batchId} abort reason=${reason}`);
    run.terminalReason = reason;

    const pid = readPidSync(this.options.projectDir, batchId);
    if (pid !== null) {
      killProcess(pid);
    }

    const payload = this.buildAbortFinalizePayload(run);
    await this.handleFinalize(run, payload);
  }

  /**
   * Build the synthetic `finalize` payload used by {@link abortRun}.
   *
   * Matches the clarifier's documented shape so the downstream watcher
   * can ingest the directory identically whether abort was
   * user-initiated, triggered by a budget breach, or raised by the
   * runner when the subprocess hung.
   *
   * @param run - Active run whose transcript feeds the payload.
   * @returns A finalise payload ready to hand to {@link handleFinalize}.
   */
  private buildAbortFinalizePayload(run: ActiveRun): FinalizePayload {
    const slug = `abort-${run.batchId}`;
    const taskDir = `tasks/inspector-${slug}`;
    const assumptions = renderAssumptions(run.transcript);
    const taskMd =
      `# Inspector ${slug}\n\n` +
      `Batch "${run.batchId}" terminated without a user-initiated finalize ` +
      `(reason: ${run.terminalReason ?? 'abort'}).\n\n` +
      `## Acceptance\n\n- Reviewer inspects the staged pins and updates ` +
      `this file before dispatch.\n\n## Assumptions\n\n${assumptions}\n`;
    const metadata: Record<string, unknown> = {
      source: 'inspector',
      batchId: run.batchId,
      parentBatchId: run.batch.parentBatchId,
      platform: run.batch.platform,
      screens: run.batch.screens,
      pinCount: run.batch.pins.length,
      protocolVersion: 'forjis-inspector/1.0',
      terminationReason: run.terminalReason ?? 'abort',
    };
    return { taskDir, taskMd, metadata };
  }

  /**
   * Tidy up an active run once its engine subprocess settles.
   *
   * A successful exit that never produced a `finalize` payload is
   * treated as a late abort; a rejected engine promise surfaces a
   * `session.error { code: "CLARIFIER_FAILED" }` frame to the client
   * and deletes the active-run entry without finalising.
   *
   * @param batchId - Identifier of the run to finish.
   * @param _result - Successful engine result, or `null` when the
   *   engine rejected.
   * @param err - Engine rejection error, or `null` on success.
   */
  private finishRun(
    batchId: string,
    _result: EngineResult | null,
    err: unknown,
  ): void {
    const run = this.runs.get(batchId);
    if (!run) return;
    if (run.finalised) {
      this.runs.delete(batchId);
      return;
    }

    if (err !== null) {
      this.emitSessionError(run, 'CLARIFIER_FAILED', err);
      if (run.budgetTimer) {
        clearTimeout(run.budgetTimer);
        run.budgetTimer = null;
      }
      this.runs.delete(batchId);
      return;
    }

    // The engine exited cleanly but we never observed a finalize.
    // Record a terminal abort so the run can still be torn down.
    void this.abortRun(batchId, 'abort', run.originatingClientId).catch(() => {
      /* best-effort */
    });
  }

  /**
   * Emit a `session.error` frame to the originating client.
   *
   * Silently drops the frame when the originating client is unknown
   * (nothing the runner can usefully do about it at that point).
   *
   * @param run - Active run carrying the client id.
   * @param code - Error code written on the frame (for example
   *   `"FINALIZE_FAILED"`).
   * @param err - Caught error whose message is forwarded to the client.
   */
  private emitSessionError(run: ActiveRun, code: string, err: unknown): void {
    const clientId = run.originatingClientId;
    if (clientId === null) return;
    const message = err instanceof Error ? err.message : String(err);
    this.options.transport.send(clientId, {
      type: 'session.error',
      code,
      message,
    });
  }
}

// -- Internal helpers -------------------------------------------------------

/**
 * Extract the raw assistant text from a {@link TaskEvent} emitted by
 * the Claude adapter.
 *
 * Production path: the Claude adapter writes the full, untruncated
 * assistant text into `event.payload` (see
 * `claude-engine.ts::enrichEventPayload`). We prefer that value because
 * `event.content` is a display-oriented preview capped at 200
 * characters, which is too short for a clarifier `question` or
 * `finalize` JSON line.
 *
 * Fallback path: when a caller (for example a unit test) only populates
 * `event.content` with the legacy `[THINK] <text>...` preview, strip
 * the prefix and the trailing ellipsis so the JSON parser sees the
 * payload verbatim.
 *
 * @param event - TaskEvent produced by the engine.
 * @returns The raw text body, or `null` when the event carries no text.
 */
function extractAssistantText(event: TaskEvent): string | null {
  if (typeof event.payload === 'string' && event.payload.length > 0) {
    return event.payload;
  }
  const content = event.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  const prefix = '[THINK] ';
  if (!content.startsWith(prefix)) return null;
  const stripped = content.slice(prefix.length);
  // The adapter appends a literal '...' truncation marker; remove it
  // before JSON parsing so the payload round-trips cleanly.
  return stripped.endsWith('...') ? stripped.slice(0, -3) : stripped;
}

/**
 * Parse JSON without throwing.
 *
 * @param text - Candidate JSON string.
 * @returns The parsed value, or `null` when the input is not valid JSON.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Narrow an unknown value to a {@link QuestionPayload}.
 *
 * @param value - Parsed JSON payload.
 * @returns `true` when the value carries a shape matching the
 *   `{"type":"question","question":ClarifyQuestion}` wrapper.
 */
function isQuestionPayload(value: unknown): value is { type: 'question' } & QuestionPayload {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec['type'] !== 'question') return false;
  const question = rec['question'];
  if (question === null || typeof question !== 'object') return false;
  const q = question as Record<string, unknown>;
  return (
    typeof q['id'] === 'string' &&
    typeof q['text'] === 'string' &&
    Array.isArray(q['options']) &&
    typeof q['allowFreeText'] === 'boolean'
  );
}

/**
 * Narrow an unknown value to a {@link FinalizePayload}.
 *
 * @param value - Parsed JSON payload.
 * @returns `true` when the value matches the
 *   `{"type":"finalize",taskDir,taskMd,metadata}` shape.
 */
function isFinalizePayload(value: unknown): value is { type: 'finalize' } & FinalizePayload {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec['type'] !== 'finalize') return false;
  return (
    typeof rec['taskDir'] === 'string' &&
    typeof rec['taskMd'] === 'string' &&
    typeof rec['metadata'] === 'object' &&
    rec['metadata'] !== null
  );
}

/**
 * Render a chat transcript as markdown for the task directory.
 *
 * @param batchId - Identifier of the batch the transcript describes.
 * @param transcript - Ordered turns captured during the run.
 * @param reason - Terminal reason recorded in the footer.
 * @returns The markdown transcript body.
 */
function renderTranscript(
  batchId: string,
  transcript: TranscriptEntry[],
  reason: TerminalReason,
): string {
  const lines: string[] = [`# Inspector clarify transcript — ${batchId}`, ''];
  transcript.forEach((entry, index) => {
    lines.push(`## Turn ${index + 1}`);
    lines.push(`**Q:** ${entry.question.text}`);
    for (const option of entry.question.options) {
      lines.push(`- [${option.id}] ${option.label}: ${option.description}`);
    }
    if (entry.answer) {
      const optionId = entry.answer.optionId ?? 'null';
      const freeText = entry.answer.freeText ?? 'null';
      lines.push(`**A:** optionId=${optionId}, freeText=${freeText}`);
    } else {
      lines.push('**A:** <none>');
    }
    lines.push('');
  });
  lines.push('---');
  lines.push(`Termination: ${reason}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Render a fallback `## Assumptions` body for abort-generated task
 * files. When the transcript is empty the body documents that no
 * developer input was captured; otherwise it lists each recorded
 * question with the chosen answer (or `<no answer>` when none was
 * provided).
 *
 * @param transcript - Turns captured before the abort trigger.
 * @returns Markdown body for the `## Assumptions` section.
 */
function renderAssumptions(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) {
    return '- No developer input was captured before the abort signal.';
  }
  return transcript
    .map((entry) => {
      const answer = entry.answer;
      if (!answer) {
        return `- Q: ${entry.question.text} — no answer was captured.`;
      }
      const choice = answer.optionId ?? answer.freeText ?? '<empty>';
      return `- Q: ${entry.question.text} — captured answer: ${choice}.`;
    })
    .join('\n');
}

/**
 * Truncate `text` to at most `limit` characters, appending an ellipsis
 * when the input is longer.
 *
 * @param text - Raw input.
 * @param limit - Maximum length of the returned string (including the
 *   ellipsis marker when applied).
 * @returns The truncated string.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}
