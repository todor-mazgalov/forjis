/**
 * Integration tests for the engine wire-up in `contextRefreshCommand`.
 *
 * Verifies that {@link tryLoadEngineImpl} returns a summariser-shaped
 * adapter that delegates to a registered {@link ForjisEngine} and that
 * driving `refreshTreeYaml` with the resulting `summarizeImpl` populates
 * every `tree.yaml` entry with the engine's response — with no real
 * `claude` binary involved.
 *
 * Companion file: `context-refresh-engine-missing.test.ts` covers the
 * fallback path when the named engine is not registered.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import {
  readTreeYaml,
  refreshTreeYaml,
  summarizeFile,
  type GitResult,
} from '../context-cache/index.js';
import {
  registerEngine,
  type ForjisEngine,
} from '../engine.js';
import { tryLoadEngineImpl } from '../commands/context.js';

/**
 * Builds a fake git seam that replays a fixed response sequence per call.
 *
 * Each entry is consumed in order; after the final entry, the seam keeps
 * returning the last response. The responses match `runGit`'s contract
 * (stdout text + exit code, never throwing).
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
 * Stub engine that records every `prompt()` call and returns a fixed
 * summary string. Used in place of the real Claude CLI so tests stay
 * hermetic and execute in milliseconds.
 */
function makeStubEngine(name: string, response: string): ForjisEngine {
  return {
    name,
    checkPrerequisites: async (): Promise<string> => 'ok',
    invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
    cleanup: async (): Promise<void> => undefined,
    prompt: async (_text: string): Promise<string> => response,
  };
}

describe('contextRefreshCommand engine wire-up (engine present)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ctx-refresh-engine-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('populates every tree.yaml entry with the engine response', async () => {
    // Register a stub engine under a unique name so we don't collide with
    // the real Claude registration.
    const engineName = 'test-engine-summary';
    registerEngine(engineName, async () =>
      makeStubEngine(engineName, 'file does X'),
    );

    const engineImpl = await tryLoadEngineImpl(engineName);
    expect(engineImpl).toBeDefined();

    await writeFile(join(repo, 'a.ts'), 'console.log("a");');
    await writeFile(join(repo, 'b.ts'), 'console.log("b");');
    await writeFile(join(repo, 'c.ts'), 'console.log("c");');

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\nc.ts\n', exitCode: 0 }, // ls-files
      { stdout: '', exitCode: 0 }, // status --porcelain
      { stdout: '', exitCode: 0 }, // log --name-only (high-traffic)
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

    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    expect(tree.files).toHaveLength(3);
    for (const entry of tree.files) {
      expect(entry.summary).toBe('file does X');
    }
  });

  it('combines system + user prompts with the documented separator', async () => {
    // Capture the single prompt string the adapter forwards so we can
    // assert the system and user halves end up on opposite sides of the
    // `\n\n---\n\n` delimiter (the cache-friendly contract).
    const captured: string[] = [];
    const engineName = 'test-engine-capture';
    registerEngine(engineName, async () => ({
      name: engineName,
      checkPrerequisites: async () => 'ok',
      invoke: async () => ({ exitCode: 0, taskId: '', stage: null }),
      cleanup: async () => undefined,
      prompt: async (text: string): Promise<string> => {
        captured.push(text);
        return 'ok';
      },
    }));

    const engineImpl = await tryLoadEngineImpl(engineName);
    expect(engineImpl).toBeDefined();
    await engineImpl!('SYSTEM-HALF', 'USER-HALF');

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('SYSTEM-HALF');
    expect(captured[0]).toContain('USER-HALF');
    expect(captured[0]).toContain('\n\n---\n\n');
    expect(captured[0].indexOf('SYSTEM-HALF')).toBeLessThan(
      captured[0].indexOf('USER-HALF'),
    );
  });
});
