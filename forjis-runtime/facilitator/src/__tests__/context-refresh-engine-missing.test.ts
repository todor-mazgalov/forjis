/**
 * Integration tests for the engine-missing fallback in
 * `contextRefreshCommand`.
 *
 * Verifies that {@link tryLoadEngineImpl} resolves to `undefined` and
 * logs the documented warning when the named engine is not registered
 * (the resolver would surface this via {@link EngineNotFoundError}),
 * and that driving `refreshTreeYaml` without a `summarizeImpl` still
 * completes — every entry gets an empty summary, no error is thrown.
 *
 * Companion file: `context-refresh-engine.test.ts` covers the success
 * path with a stub engine wired through.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import {
  readTreeYaml,
  refreshTreeYaml,
  type GitResult,
} from '../context-cache/index.js';
import { tryLoadEngineImpl } from '../commands/context.js';

/**
 * Builds a fake git seam that replays a fixed response sequence per call.
 *
 * Each entry is consumed in order; after the final entry, the seam keeps
 * returning the last response.
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

describe('contextRefreshCommand engine wire-up (engine missing)', () => {
  let repo: string;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ctx-refresh-missing-'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(repo, { recursive: true, force: true });
  });

  it('returns undefined and logs once when the engine is not registered', async () => {
    // The resolver would translate this into an EngineNotFoundError at
    // load time. The adapter must catch it, emit one fixed warning, and
    // hand back `undefined` so the caller can fall through.
    const engineName = 'definitely-not-a-real-engine-xyz';
    const engineImpl = await tryLoadEngineImpl(engineName);

    expect(engineImpl).toBeUndefined();
    const matched = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes(
        `[context-cache]: engine "${engineName}" unavailable — summaries will be empty`,
      ),
    );
    expect(matched).toHaveLength(1);
  });

  it('refresh completes with empty summaries when no summarizeImpl is wired', async () => {
    await writeFile(join(repo, 'a.ts'), 'console.log("a");');
    await writeFile(join(repo, 'b.ts'), 'console.log("b");');

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\n', exitCode: 0 }, // ls-files
      { stdout: '', exitCode: 0 }, // status --porcelain
      { stdout: '', exitCode: 0 }, // log --name-only (high-traffic)
    ]);

    // No summarizeImpl override — mirrors the production fall-through
    // when `tryLoadEngineImpl` returns `undefined`. Refresh must NOT
    // throw and must return a non-zero `summarizedCount`.
    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
    });
    expect(result.summarizedCount).toBe(2);

    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    expect(tree.files).toHaveLength(2);
    for (const entry of tree.files) {
      expect(entry.summary).toBe('');
    }
  });
});
