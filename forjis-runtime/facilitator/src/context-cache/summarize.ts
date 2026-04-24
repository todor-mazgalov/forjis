/**
 * Single-file LLM summariser for the context-cache refresh pipeline.
 *
 * Exposes {@link summarizeFile} — one LLM call per file, one retry on
 * timeout or empty output, never throws. Callers (the refresh pipeline)
 * get either a short factual sentence or an empty string on failure.
 *
 * The summariser is engine-agnostic: callers inject `engineInvokeImpl`
 * when they already hold a `ForjisEngine`. In v1, no default engine is
 * auto-loaded — an absent `engineInvokeImpl` short-circuits to the
 * empty-summary path (logged). This keeps the CLI `forjis context
 * refresh` usable before a full engine wire-up lands, degrading
 * cleanly per FR-011.
 */

/** Hard ceiling on the returned summary character count. */
const SUMMARY_MAX_CHARS = 120;

/** Default LLM call timeout (milliseconds). */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Warning-line prefix shared with the rest of the context-cache module. */
const WARN_PREFIX = '[context-cache]:';

/**
 * Static system prompt used for every summarize call.
 *
 * Kept identical across a batch so an Anthropic prompt cache can hit on
 * the system slot (see design.md §D-6 summarize.ts rationale). No path
 * or file-content interpolation here.
 */
const SYSTEM_PROMPT = [
  'You summarize a single source file in one short factual sentence.',
  'Constraints:',
  '- Output MUST be at most 120 ASCII characters.',
  '- Output MUST be a single sentence with no line breaks and no markdown.',
  '- Phrasing MUST be factual ("does X"), not prescriptive ("should do X").',
  '- Do NOT restate the filename; describe what the file is/does.',
  '- Return only the sentence, no preamble, no quotes.',
].join('\n');

/** Inputs accepted by {@link summarizeFile}. */
export interface SummarizeInput {
  /** Project-relative POSIX path of the file being summarised. */
  path: string;
  /** Working-tree bytes, already verified to be under the size cap. */
  content: Buffer;
}

/** Return shape of {@link summarizeFile}. */
export interface SummarizeResult {
  /** Single sentence, ≤120 chars, factual, ASCII. Empty on failure. */
  summary: string;
}

/** Options accepted by {@link summarizeFile}. */
export interface SummarizeOptions {
  /** Timeout in ms for a single LLM call. Default: 20_000. */
  timeoutMs?: number;
  /**
   * Injection seam for tests and callers that already hold an engine.
   * When absent, `summarizeFile` short-circuits to `{ summary: '' }`.
   */
  engineInvokeImpl?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Logger for retry / failure lines. Default: console.warn. */
  warn?: (msg: string) => void;
}

/**
 * Summarises one file via a single LLM call.
 *
 * Retries once on timeout, thrown error, or empty completion. After the
 * second failure, returns `{ summary: '' }` so the refresh pipeline can
 * continue with other files. Defensively truncates output to 120 chars
 * and strips non-ASCII bytes.
 *
 * Never throws — callers can always assume a `SummarizeResult`.
 *
 * @param input - The file path + bytes to summarise.
 * @param opts - Optional timeout / logger / engine injection seam.
 * @returns `{ summary }` — empty string on repeated failure.
 */
export async function summarizeFile(
  input: SummarizeInput,
  opts?: SummarizeOptions,
): Promise<SummarizeResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  const engineInvoke = opts?.engineInvokeImpl;

  if (!engineInvoke) {
    warn(
      `${WARN_PREFIX} summarize skipped — no engine wired for "${input.path}"`
    );
    return { summary: '' };
  }

  const userPrompt = buildUserPrompt(input);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await withTimeout(
        engineInvoke(SYSTEM_PROMPT, userPrompt),
        timeoutMs,
      );
      const cleaned = sanitizeSummary(raw);
      if (cleaned.length > 0) {
        return { summary: cleaned };
      }
      warn(
        `${WARN_PREFIX} summarize empty result for "${input.path}" (attempt ${attempt})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(
        `${WARN_PREFIX} summarize failed for "${input.path}" (attempt ${attempt}): ${msg}`
      );
    }
  }

  return { summary: '' };
}

/**
 * Builds the user-slot prompt for one file.
 *
 * Keeps all dynamic content in this slot so the static system prompt
 * stays cache-eligible across a refresh batch.
 */
function buildUserPrompt(input: SummarizeInput): string {
  return (
    `Path: ${input.path}\n` +
    `---\n` +
    input.content.toString('utf-8') +
    `\n---\n` +
    `Summarize this file in one ASCII sentence, at most 120 characters.`
  );
}

/**
 * Strips non-ASCII bytes, collapses whitespace, and truncates to
 * {@link SUMMARY_MAX_CHARS}. Returns empty string when the sanitized
 * result is zero-length.
 */
function sanitizeSummary(raw: string): string {
  if (typeof raw !== 'string') return '';
  // Strip non-printable ASCII + collapse whitespace.
  const asciiOnly = raw.replace(/[^\x20-\x7E]/g, ' ');
  const collapsed = asciiOnly.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  return collapsed.length > SUMMARY_MAX_CHARS
    ? collapsed.slice(0, SUMMARY_MAX_CHARS)
    : collapsed;
}

/**
 * Races a promise against a timeout.
 *
 * Rejects with a dedicated `Error` when `promise` does not settle
 * within `ms`. The timer is `unref()`'d so a pending timeout does not
 * keep the event loop alive after the owning task has drained.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`summarize invocation timed out after ${ms}ms`));
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
