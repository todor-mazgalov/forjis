/**
 * Integration tests for the `context.model` wire-up in
 * {@link tryLoadEngineImpl}.
 *
 * Stubs the engine to capture every {@link PromptOptions} argument
 * forwarded by the adapter and drives `refreshTreeYaml` through the
 * resulting summariser. Verifies that:
 *
 *   - When `tryLoadEngineImpl` is called with `model: 'haiku'`, every
 *     captured `PromptOptions.model === 'haiku'`.
 *   - When called with the resolver's default `'sonnet'` (mirroring
 *     the omitted-config code path), every captured
 *     `PromptOptions.model === 'sonnet'`.
 *
 * Companion files: `context-refresh-engine.test.ts`,
 * `context-refresh-engine-missing.test.ts`,
 * `context-refresh-forjis-skip.test.ts`,
 * `context-refresh-parallel.test.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import {
  refreshTreeYaml,
  summarizeFile,
  type GitResult,
} from '../context-cache/index.js';
import {
  registerEngine,
  type ForjisEngine,
} from '../engine.js';
import { tryLoadEngineImpl } from '../commands/context.js';
import { PromptOptions } from '../types.js';

/**
 * Builds a fake git seam that replays a fixed response sequence per call.
 *
 * @param responses - Ordered list of responses for `git ls-files`,
 *   `git status --porcelain`, and `git log --name-only` calls.
 * @returns A jest mock implementing the `gitImpl` shape.
 */
function makeGitStub(
  responses: GitResult[],
): jest.Mock<(args: string[], cwd: string) => Promise<GitResult>> {
  let call = 0;
  const fn = jest.fn(
    async (_args: string[], _cwd: string): Promise<GitResult> => {
      const r = responses[Math.min(call, responses.length - 1)];
      call++;
      return r;
    },
  );
  return fn as unknown as jest.Mock<
    (args: string[], cwd: string) => Promise<GitResult>
  >;
}

/**
 * Stub engine that records every {@link PromptOptions} forwarded to
 * `prompt()` and returns a fixed summary. The captured array is shared
 * across the engine instance so the test can inspect it after driving
 * the refresh pipeline.
 */
function makeCapturingEngine(
  name: string,
  captured: PromptOptions[],
): ForjisEngine {
  return {
    name,
    checkPrerequisites: async (): Promise<string> => 'ok',
    invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
    cleanup: async (): Promise<void> => undefined,
    prompt: async (_text: string, options: PromptOptions): Promise<string> => {
      captured.push(options);
      return 'one-line summary';
    },
  };
}

describe('contextRefreshCommand model wire-up', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ctx-refresh-model-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('forwards context.model: "haiku" to every PromptOptions', async () => {
    const captured: PromptOptions[] = [];
    const engineName = 'test-engine-model-haiku';
    registerEngine(engineName, async () =>
      makeCapturingEngine(engineName, captured),
    );

    const engineImpl = await tryLoadEngineImpl(engineName, 'haiku');
    expect(engineImpl).toBeDefined();

    await writeFile(join(repo, 'a.ts'), 'console.log("a");');
    await writeFile(join(repo, 'b.ts'), 'console.log("b");');
    await writeFile(join(repo, 'c.ts'), 'console.log("c");');

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\nc.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: (input, opts) =>
        summarizeFile(input, { ...opts, engineInvokeImpl: engineImpl! }),
    });

    expect(result.summarizedCount).toBe(3);
    expect(captured).toHaveLength(3);
    for (const opts of captured) {
      expect(opts.model).toBe('haiku');
    }
  });

  it('forwards the resolver default "sonnet" when context.model is unset', async () => {
    const captured: PromptOptions[] = [];
    const engineName = 'test-engine-model-default';
    registerEngine(engineName, async () =>
      makeCapturingEngine(engineName, captured),
    );

    // The resolver normalises an omitted `context.model` to `'sonnet'`
    // before reaching the adapter. Mirror that contract here so the
    // adapter sees the same value the production caller forwards.
    const engineImpl = await tryLoadEngineImpl(engineName, 'sonnet');
    expect(engineImpl).toBeDefined();

    await writeFile(join(repo, 'a.ts'), 'console.log("a");');
    await writeFile(join(repo, 'b.ts'), 'console.log("b");');

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: (input, opts) =>
        summarizeFile(input, { ...opts, engineInvokeImpl: engineImpl! }),
    });

    expect(result.summarizedCount).toBe(2);
    expect(captured).toHaveLength(2);
    for (const opts of captured) {
      expect(opts.model).toBe('sonnet');
    }
  });

  it('omits PromptOptions.model when the adapter is loaded without a model', async () => {
    const captured: PromptOptions[] = [];
    const engineName = 'test-engine-model-undefined';
    registerEngine(engineName, async () =>
      makeCapturingEngine(engineName, captured),
    );

    // Passing `undefined` reproduces the contract the adapter must
    // honour for non-summarise engine consumers (orchestrator,
    // persona, strategist) — `PromptOptions.model` stays unset so the
    // engine spawns without `--model`.
    const engineImpl = await tryLoadEngineImpl(engineName, undefined);
    expect(engineImpl).toBeDefined();

    await writeFile(join(repo, 'a.ts'), 'console.log("a");');

    const git = makeGitStub([
      { stdout: 'a.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: (input, opts) =>
        summarizeFile(input, { ...opts, engineInvokeImpl: engineImpl! }),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBeUndefined();
  });
});
