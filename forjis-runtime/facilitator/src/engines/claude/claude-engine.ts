/**
 * Claude engine implementation for @forjis/facilitator.
 *
 * Implements the ForjisEngine interface using the Claude Code CLI.
 * Handles subprocess spawning, stream-json parsing, token usage tracking,
 * and TASK.md generation. Configuration file generation has been delegated
 * to @forjis/resolver; this engine reads resolved config from .forjis/config/.
 */

import {
  ChildProcessByStdio,
  spawn,
  spawnSync,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  EngineInvokeOptions,
  EngineResult,
  ForjisEngine,
} from '../../engine.js';
import {
  CliError,
  EngineCapabilityError,
  EngineInvocationError,
  EngineTimeoutError,
} from '../../errors.js';
import { atomicWriteFile, ensureDir } from '../../state.js';
import type { InvocationContext, TaskEvent } from '../../types.js';
import { PromptOptions } from '../../types.js';

import * as readline from 'readline';

/** Default silence watchdog threshold: 30 minutes of no stream events. */
const DEFAULT_SILENCE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Claude Code engine implementation.
 *
 * Uses the `claude` CLI binary to execute pipeline tasks. Spawns
 * `claude --print -p /forjis ...` during invoke, with the orchestrator
 * directory as cwd so Claude Code discovers .claude/commands/ and .claude/skills/.
 * Config files are read from .forjis/config/ (written by @forjis/resolver).
 */
export class ClaudeEngine implements ForjisEngine {
  /** Engine identifier. */
  readonly name = 'claude';
  readonly MAX_EVENTS = 3;

  /**
   * Default silence-watchdog threshold in milliseconds. Used when no per-call
   * override is supplied via PromptOptions.silenceTimeoutMs. Tests may set
   * this to a small value to exercise the watchdog path quickly.
   */
  silenceTimeoutMs: number = DEFAULT_SILENCE_TIMEOUT_MS;

  /**
   * Live subprocess handles keyed by `taskId`. Populated inside
   * {@link prompt} when `options.id` is set and cleaned up on the
   * subprocess's `close` or `error` callback. Enables
   * {@link onUserMessage} to address the correct running child when
   * multiple clarifier subprocesses are spawned concurrently.
   */
  private readonly activeChildren = new Map<
    string,
    ChildProcessByStdio<Writable, Readable, Readable>
  >();

  /**
   * Protected seam used by `prompt()` to spawn the underlying child process.
   *
   * Forwards directly to `child_process.spawn` in production. Exposed as a
   * method so unit tests can subclass ClaudeEngine and substitute a fake
   * ChildProcess to exercise the silence-watchdog and exit paths without
   * requiring a real `claude` binary on PATH.
   *
   * @param command - The command to execute.
   * @param args - Command-line arguments.
   * @param opts - Spawn options (stdio, cwd, shell, etc.).
   * @returns The spawned ChildProcess.
   */
  protected spawnChild(
    command: string,
    args: string[],
    opts: SpawnOptionsWithoutStdio,
  ): ChildProcessByStdio<Writable, Readable, Readable> {
    return spawn(command, args, opts) as ChildProcessByStdio<
      Writable,
      Readable,
      Readable
    >;
  }

  /**
   * Verify that the claude CLI is installed and accessible on PATH.
   *
   * Spawns `claude --version` as a subprocess. If the binary is not found
   * or exits non-zero, throws EngineNotFoundError.
   *
   * @throws {EngineNotFoundError} If the claude CLI is not available.
   */
  async checkPrerequisites(): Promise<string> {
    console.log('[engine]: checking claude CLI prerequisites...');
    const options = new PromptOptions();
    options.id = 'prerequisites';
    return this.prompt('--version', options);
  }

  /**
   * Invoke the Claude CLI to run the pipeline for a single task.
   *
   * Writes TASK.md, then spawns the `claude` subprocess with the
   * orchestrator directory as cwd so that Claude Code discovers
   * .claude/commands/ and .claude/skills/.
   *
   * In dry-run mode, logs the intended action and returns without spawning.
   *
   * @param options - All per-task context needed for invocation.
   * @returns EngineResult with exit code and task metadata.
   * @throws {EngineInvocationError} On non-zero exit or spawn failure.
   */
  async invoke(options: EngineInvokeOptions): Promise<EngineResult> {
    if (options.dryRun) {
      console.log(`[dry-run] Would invoke engine for task "${options.taskId}"`);
      console.log(`[dry-run] Project: ${options.projectDir}`);
      console.log(`[dry-run] Config dir: ${options.configDir}`);
      return { exitCode: 0, taskId: options.taskId, stage: null };
    }

    const ctx: InvocationContext = {
      invocationInputTokens: 0,
      invocationOutputTokens: 0,
      invocationCostUsd: 0,
      roleTokens: new Map(),
      currentRole: null,
      lineBuffer: '',
      eventLog: [],
      toolIdToName: new Map(),
    };

    const taskDir = join(options.projectDir, '.forjis', 'tasks', options.taskId);
    await ensureDir(taskDir);

    const taskMdContent = buildTaskMd(options.taskId, options.taskDescription);
    await atomicWriteFile(join(taskDir, 'TASK.md'), taskMdContent);

    const orchestratorDir = this.getOrchestratorDir();
    console.log(`[engine]: spawning claude subprocess for task "${options.taskId}" (cwd: ${orchestratorDir})`);
    await this.spawnClaude(
      ctx,
      options.projectDir,
      options.taskId,
      options.taskDescription,
      options.configDir,
      options.mode,
      options.modeArgs,
      options.onEvent,
    );

    const perRole: Record<string, { inputTokens: number; outputTokens: number }> = {};
    for (const [role, tokens] of ctx.roleTokens) {
      perRole[role] = { inputTokens: tokens.input, outputTokens: tokens.output };
    }

    return {
      exitCode: 0,
      taskId: options.taskId,
      stage: null,
      usage: {
        inputTokens: ctx.invocationInputTokens,
        outputTokens: ctx.invocationOutputTokens,
        cost: ctx.invocationCostUsd > 0 ? ctx.invocationCostUsd : undefined,
        perRole: Object.keys(perRole).length > 0 ? perRole : undefined,
      },
    };
  }

  /**
   * Cleanup after invocation.
   *
   * No-op for the Claude engine. Returns immediately.
   *
   * @param _projectDir - The target project directory (unused).
   */
  async cleanup(_projectDir: string): Promise<void> {
    /* No cleanup needed for Claude engine */
  }

  /**
   * Send a prompt to the Claude CLI and return the text response.
   *
   * Used for simple LLM calls that don't need the full orchestrator.
   * Handles Windows shell quoting and cross-platform spawning.
   *
   * @param text - The prompt text to send.
   * @param options - Prompt config options.
   * @returns The Claude CLI's text response.
   */
  async prompt(text: string, options: PromptOptions): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const isWindows = process.platform === 'win32';
      let normalizedProjectDir;
      if (options.projectDir) {
        normalizedProjectDir = options.projectDir.replace(/\\/g, '/');
      }
      const args = [];
      if (normalizedProjectDir) {
        args.push('--add-dir');
        args.push(normalizedProjectDir);
      }
      args.push('-p', '--verbose', '--output-format', 'stream-json');
      if (options.maxTurns !== undefined) {
        args.push('--max-turns', String(options.maxTurns));
      }
      for (const tool of options.allowedTools) {
        args.push('--allowedTools', tool);
      }
      args.push('-');

      const childOptions: SpawnOptionsWithoutStdio = {
        stdio: ["pipe", "pipe", "pipe"],
        shell: isWindows
      };
      if (options.workingDir) {
        childOptions.cwd = options.workingDir;
      }
      const child = this.spawnChild('claude', args, childOptions);

      let pidFilePath: string;
      if (options.id && options.projectDir) {
        pidFilePath = join(options.projectDir, '.forjis', 'tasks', options.id, 'pid');
        if (child.pid) {
          try { writeFileSync(pidFilePath, String(child.pid)); } catch { /* ignore */ }
        }
      }

      // Register the child handle so onUserMessage can find it while the
      // subprocess is alive. Keyed by the caller-supplied task id.
      if (options.id) {
        this.activeChildren.set(options.id, child);
      }

      child.stdin.write(text);
      if (!options.keepStdinOpen) {
        child.stdin.end();
      }

      let resultText = '';
      let stderr = '';
      let settled = false;

      // -- Silence watchdog ---------------------------------------------------
      // Kills the child subprocess tree if no parsed stream event is seen for
      // `silenceMs` milliseconds. This catches the failure mode where a
      // nested Bash tool (e.g. `npm test`) hangs inside the child claude
      // process: the parent never emits a `result` event, so without a
      // watchdog the orchestrator would wait forever.
      const silenceMs = options.silenceTimeoutMs ?? this.silenceTimeoutMs;
      let watchdogTimer: NodeJS.Timeout | null = null;
      let watchdogFiredAt: number | null = null;
      const startedAt = Date.now();

      const cleanupPidFile = (): void => {
        if (pidFilePath) {
          try { unlinkSync(pidFilePath); } catch { /* ignore */ }
        }
      };

      const clearWatchdog = (): void => {
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
      };

      const killChildTree = (): void => {
        const pid = child.pid;
        if (typeof pid !== 'number') return;
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/F', '/PID', String(pid), '/T']);
          } else {
            try { process.kill(-pid, 'SIGKILL'); }
            catch {
              try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }
          }
        } catch {
          /* best-effort kill — swallow errors so we can still reject */
        }
      };

      const armWatchdog = (): void => {
        clearWatchdog();
        if (!Number.isFinite(silenceMs) || silenceMs <= 0) return;
        watchdogTimer = setTimeout(() => {
          if (settled) return;
          watchdogFiredAt = Date.now();
          killChildTree();
          cleanupPidFile();
          const elapsed = watchdogFiredAt - startedAt;
          settled = true;
          reject(new EngineTimeoutError('silence', elapsed));
        }, silenceMs);
        // The watchdog must NOT keep the event loop alive — if the parent
        // process exits naturally, the timer should not block it.
        if (typeof watchdogTimer.unref === 'function') {
          watchdogTimer.unref();
        }
      };

      armWatchdog();

      child.stdout.on("data", chunk => {
        armWatchdog();
        this.parseOutput(chunk, options.onEvent, 'stdout', options.returnOutput ? (text) => { resultText = text; } : undefined, options.ctx);
      });

      child.stderr.on("data", chunk => {
        armWatchdog();
        const text = this.parseOutput(chunk, options.onEvent, 'stderr', undefined, options.ctx);
        if (options.returnOutput) {
          stderr += text;
        }
      });

      const deregisterChild = (): void => {
        if (!options.id) return;
        const tracked = this.activeChildren.get(options.id);
        if (tracked === child) {
          this.activeChildren.delete(options.id);
        }
      };

      child.on('error', (err) => {
        clearWatchdog();
        cleanupPidFile();
        deregisterChild();
        if (settled) return;
        settled = true;
        console.error('\n[Error] Failed to start process:', err.message);
        reject(new EngineInvocationError(options.id ?? "engine", err));
      });

      child.on('close', (code) => {
        clearWatchdog();
        cleanupPidFile();
        deregisterChild();
        if (settled) return;
        settled = true;
        console.log(`[engine]: claude subprocess exited (code: ${code})`);
        if (code !== 0) {
          reject(new EngineInvocationError(options.id ?? "engine", new Error(`Exit code ${code}: ${stderr}`)));
        } else {
          resolvePromise(resultText);
        }
      });
    });
  }

  /**
   * Resolves the orchestrator directory containing .claude/commands/ and .claude/skills/.
   *
   * Uses Node's module resolution to locate the installed `@forjis/orchestrator`
   * package. Works both in the monorepo (via workspace symlinks) and when
   * installed from npm.
   *
   * @returns Absolute path to the orchestrator directory.
   * @throws {CliError} If the orchestrator directory does not exist.
   */
  getOrchestratorDir(): string {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@forjis/orchestrator/package.json');
    const dir = dirname(pkgPath);
    if (!existsSync(dir)) {
      throw new CliError(`Orchestrator directory not found at ${dir}`);
    }
    return dir;
  }

  /**
   * Spawns the claude subprocess with the appropriate flags.
   *
   * Sets cwd to the orchestrator directory so Claude Code discovers
   * .claude/commands/. Passes --print -p /forjis with mode flags and
   * mode arguments to the orchestrator command.
   *
   * @param ctx - Per-invocation context for token tracking and output buffering.
   * @param projectDir - The target project directory.
   * @param taskId - The task identifier.
   * @param taskDescription - Human-readable task description.
   * @param configDir - Absolute path to .forjis/config/ with resolved config files.
   * @param mode - Orchestrator mode (e.g., 'persona', 'strategist', 'assess').
   * @param modeArgs - Mode-specific arguments to pass as flags.
   * @param onEvent - Optional callback for stream events.
   * @throws {EngineInvocationError} On non-zero exit or spawn error.
   */
  private spawnClaude(
    ctx: InvocationContext,
    projectDir: string,
    taskId: string,
    taskDescription: string,
    configDir: string,
    mode?: string,
    modeArgs?: Record<string, unknown>,
    onEvent?: (event: TaskEvent) => void,
  ): Promise<string> {
    const normalizedDir = projectDir.replace(/\\/g, '/');
    const parts = [`/forjis`];

    // Add mode flag (e.g., --persona, --strategist, --assess)
    if (mode) {
      parts.push(`--${mode}`);
    }

    // Add mode-specific arguments as flags
    if (modeArgs) {
      for (const [key, value] of Object.entries(modeArgs)) {
        if (value === true) {
          parts.push(`--${key}`);
        } else if (value !== undefined && value !== null && value !== false) {
          parts.push(`--${key}`, String(value));
        }
      }
    }

    parts.push(normalizedDir, taskId);

    const command = parts.join(' ');
    const orchestratorDir = this.getOrchestratorDir();
    const options = new PromptOptions();
    options.id = taskId;
    options.workingDir = orchestratorDir;
    options.projectDir = projectDir;
    options.onEvent = onEvent;
    options.ctx = ctx;
    // The clarifier runs interactively: the facilitator injects additional
    // user turns (clarify answers, guardrail hints) via `onUserMessage`
    // while the subprocess is still alive. Leaving stdin open is a
    // prerequisite for that injection.
    if (mode === 'inspector-clarify') {
      options.keepStdinOpen = true;
    }
    return this.prompt(command, options);
  }

  /**
   * Append a new user turn to the running subprocess for `taskId`.
   *
   * Looks up the live child handle in {@link activeChildren}; when absent
   * rejects with an {@link EngineCapabilityError} naming the missing
   * subprocess. Otherwise writes `text` plus a trailing newline to the
   * child's stdin so the Claude CLI's line-delimited parser treats it as
   * a fresh user turn.
   *
   * The subprocess's stdin must have been opened with `keepStdinOpen:
   * true` at spawn time for this call to succeed; the inspector-clarify
   * mode sets that flag automatically via
   * {@link spawnClaude}.
   *
   * @param taskId - Identifier matching the live subprocess's invocation id.
   * @param text - Payload appended as a new user turn. A trailing newline
   *   is added automatically.
   * @throws {EngineCapabilityError} When no subprocess is running for
   *   `taskId`, or when the subprocess's stdin has already been closed.
   */
  async onUserMessage(taskId: string, text: string): Promise<void> {
    const child = this.activeChildren.get(taskId);
    if (!child) {
      throw new EngineCapabilityError(
        this.name,
        'onUserMessage',
        `no active subprocess for task "${taskId}"`,
      );
    }
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new EngineCapabilityError(
        this.name,
        'onUserMessage',
        `stdin closed for task "${taskId}"`,
      );
    }
    child.stdin.write(`${text}\n`);
  }

  /**
   * Parses stream-json output from the Claude CLI.
   *
   * Buffers partial lines, parses complete JSON lines, logs events,
   * and forwards formatted events to the onEvent callback. Stamps each
   * event with the originating process stream.
   *
   * @param chunk - Raw output chunk from stdout/stderr.
   * @param onEvent - Optional callback for formatted events.
   * @param stream - Which process stream produced this chunk.
   * @param onResult - Optional callback for result text.
   * @param ctx - Per-invocation context; when provided, enables token tracking and role detection.
   * @returns The raw output string.
   */
  private parseOutput(
    chunk: any,
    onEvent?: (event: TaskEvent) => void,
    stream?: 'stdout' | 'stderr',
    onResult?: (text: string) => void,
    ctx?: InvocationContext,
  ) {
    const output = chunk.toString("utf-8");

    // When a context is present, maintain a carry-over line buffer across chunks.
    // Without a context (e.g. checkPrerequisites), treat each chunk independently.
    const rawBuffer = ctx ? (ctx.lineBuffer += output, ctx.lineBuffer) : output;

    const lines = rawBuffer.split('\n');
    /* Keep the last (possibly incomplete) line in the buffer */
    const remainder = lines.pop() ?? '';
    if (ctx) {
      ctx.lineBuffer = remainder;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ClaudeStreamEvent;
        this.logEvent(event, ctx);
        if (ctx) {
          this.accumulateTokenUsage(event, ctx);
        }

        if (ctx && event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              ctx.toolIdToName.set(block.id, block.name);
              if (block.name === 'Agent') {
                const subType = (block.input as Record<string, unknown>).subagent_type;
                if (typeof subType === 'string' && subType.startsWith('forjis-')) {
                  ctx.currentRole = subType;
                }
              }
            }
          }
        }

        if (event.type === 'result' && onResult) {
          onResult(event.result);
        }

        if (onEvent) {
          const formatted = this.formatEvent(event);
          if (formatted) {
            const taskEvent: TaskEvent = {
              timestamp: new Date().toISOString(),
              type: event.type,
              role: ctx?.currentRole ?? 'orchestrator',
              content: formatted,
            };
            if (stream) {
              taskEvent.stream = stream;
            }
            this.enrichEventPayload(taskEvent, event, ctx);
            onEvent(taskEvent);
          }
        }
      } catch {
        /* Skip malformed lines -- partial JSON or non-JSON output */
      }
    }

    return output;
  }

  /**
   * Accumulates token usage from a stream event.
   *
   * Extracts the `usage` field from assistant and user message events
   * and adds the counts to the per-invocation accumulators in ctx.
   * Also accumulates `total_cost_usd` from result events into the
   * cost accumulator on ctx.
   *
   * @param event - The parsed stream event.
   * @param ctx - Per-invocation context holding the token accumulators.
   */
  private accumulateTokenUsage(event: ClaudeStreamEvent, ctx: InvocationContext): void {
    if (event.type === 'result') {
      if (typeof event.total_cost_usd === 'number' && event.total_cost_usd > 0) {
        ctx.invocationCostUsd += event.total_cost_usd;
      }
      return;
    }

    if (event.type !== 'assistant' && event.type !== 'user') return;
    const usage = event.message.usage;
    if (!usage) return;
    ctx.invocationInputTokens += usage.input_tokens;
    ctx.invocationOutputTokens += usage.output_tokens;

    const roleKey = ctx.currentRole ?? 'orchestrator';
    let roleEntry = ctx.roleTokens.get(roleKey);
    if (!roleEntry) {
      roleEntry = { input: 0, output: 0 };
      ctx.roleTokens.set(roleKey, roleEntry);
    }
    roleEntry.input += usage.input_tokens;
    roleEntry.output += usage.output_tokens;
  }

  /**
   * Logs a stream event to the rolling event display.
   *
   * @param event - The parsed stream event to log.
   * @param ctx - Per-invocation context holding the event log; when absent, logs are skipped.
   */
  private logEvent(event: ClaudeStreamEvent, ctx?: InvocationContext): void {
    const formatted = this.formatEvent(event);
    if (!formatted) return;

    if (!ctx) return;

    ctx.eventLog.push(formatted);
    if (ctx.eventLog.length > this.MAX_EVENTS) {
      ctx.eventLog.shift(); // drop oldest
    }

    this.renderEvents(ctx);
  }

  /**
   * Populates toolName, parentId, and payload on a TaskEvent from the first
   * tool_use block (assistant) or tool_result block (user) in the source
   * stream event.
   *
   * For assistant events that carry only text blocks, concatenates every
   * text block's untruncated `text` into `taskEvent.payload` as a string.
   * The `content` field is a display-oriented preview capped at
   * {@link formatEvent}'s 200-character limit; downstream consumers that
   * need the full line (for example the inspector clarifier runner
   * parsing JSON payloads) read from `payload` instead.
   *
   * @param taskEvent - Event record to enrich in place.
   * @param event - Source stream-json event.
   * @param ctx - Per-invocation context used to resolve tool names from
   *   tool_use ids when enriching `tool_result` blocks.
   */
  private enrichEventPayload(
    taskEvent: TaskEvent,
    event: ClaudeStreamEvent,
    ctx?: InvocationContext,
  ): void {
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          taskEvent.toolName = block.name;
          taskEvent.parentId = block.id;
          taskEvent.payload = block.input;
          return;
        }
      }
      const fullText = event.message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      if (fullText.length > 0) {
        taskEvent.payload = fullText;
      }
      return;
    }

    if (event.type === 'user') {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          taskEvent.parentId = block.tool_use_id;
          taskEvent.payload = block.content;
          const name = ctx?.toolIdToName.get(block.tool_use_id);
          if (name !== undefined) {
            taskEvent.toolName = name;
          }
          return;
        }
      }
    }
  }

  /** Formats a stream event into a human-readable log line. */
  private formatEvent(event: ClaudeStreamEvent): string | null {
    switch (event.type) {
      case 'system':
        return `[SYSTEM] session=${event.session_id} model=${event.model} cwd=${event.cwd}`;
      case 'assistant':
        return event.message.content.map(block => {
          if (block.type === 'text')     return `[THINK] ${block.text.slice(0, 200)}...`;
          if (block.type === 'tool_use') return `[TOOL_CALL] ${block.name}(${JSON.stringify(block.input)})`;
          return null;
        }).filter(Boolean).join('\n') || null;
      case 'user':
        return event.message.content.map(block => {
          if (block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : block.content.map(b => b.text).join('');
            return `[TOOL_RESULT] id=${block.tool_use_id} ${text.slice(0, 200)}...`;
          }
          return null;
        }).filter(Boolean).join('\n') || null;
      case 'result':
        return `[DONE] turns=${event.num_turns} ok=${!event.is_error}`;
      default:
        return null;
    }
  }

  /**
   * Renders the rolling event log to the terminal.
   *
   * @param ctx - Per-invocation context holding the event log to display.
   */
  private renderEvents(ctx: InvocationContext): void {
    if (!process.stdout.isTTY) {
      const latest = ctx.eventLog[ctx.eventLog.length - 1];
      if (latest) {
        console.log(latest);
      }
      return;
    }

    readline.moveCursor(process.stdout, 0, -ctx.eventLog.length);
    readline.clearScreenDown(process.stdout);

    for (const line of ctx.eventLog) {
      console.log(line);
    }
  }
}

// -- Internal helpers -------------------------------------------------------

// -- Inner content blocks (inside assistant message) --

/** Text content block in a Claude message. */
interface TextBlock {
  type: 'text';
  text: string;
}

/** Tool use content block in a Claude message. */
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool result content block in a Claude message. */
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// -- Inner message shape --

/** Shape of a Claude API message in stream-json output. */
interface ClaudeMessage {
  id?: string;
  role: 'user' | 'assistant';
  model?: string;
  content: ContentBlock[];
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  usage?: { input_tokens: number; output_tokens: number };
}

// -- Top-level stream-json event types --

/** System init event from Claude CLI. */
interface SystemEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: string[];
  mcp_servers: Record<string, unknown>[];
  model: string;
  cwd: string;
  api_key_source: string;
}

/** User message event from Claude CLI. */
interface UserEvent {
  type: 'user';
  message: ClaudeMessage;
  session_id: string;
}

/** Assistant message event from Claude CLI. */
interface AssistantEvent {
  type: 'assistant';
  message: ClaudeMessage;
  session_id: string;
}

/** Result event from Claude CLI. */
interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  is_error: boolean;
}

type ClaudeStreamEvent = SystemEvent | UserEvent | AssistantEvent | ResultEvent;

/** Builds the TASK.md content for the engine. */
function buildTaskMd(taskId: string, description: string): string {
  return `# Task: ${taskId}

${description}

---
stage: pending
`;
}
