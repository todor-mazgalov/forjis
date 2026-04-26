/**
 * Regression test for `enumerateCandidates` filtering of runtime-owned
 * `.forjis/` paths.
 *
 * Background: `forjis context refresh` was re-summarising
 * `.forjis/resolved/plugins.lock.yaml` and `.forjis/resolver-cache/checksums.json`
 * on every run because the resolver rewrites them with non-deterministic
 * content. The candidate enumerator picked them up — via either `git
 * ls-files` (when tracked) or `git status --porcelain ?? ` (when
 * untracked-not-ignored) — and fired a Claude call.
 *
 * The fix is a single `isForjisOwned` predicate inside
 * `enumerateCandidates` that excludes any path equal to `.forjis` or
 * starting with `.forjis/`. This test exercises both probe sources by
 * placing `.forjis/...` paths on the tracked path AND on the untracked
 * `?? ` path, and asserts that only ordinary source paths land in the
 * resulting candidate set.
 *
 * The test drives the public {@link refreshTreeYaml} entry point rather
 * than calling `enumerateCandidates` directly — keeps the module's
 * exported surface unchanged.
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

/**
 * Builds a fake git seam that replays a fixed response sequence per call.
 *
 * Each entry is consumed in order; after the final entry, the seam keeps
 * returning the last response. Mirrors the helper used by
 * `context-refresh-engine.test.ts`.
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

describe('enumerateCandidates filters runtime-owned .forjis/ paths', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ctx-refresh-forjis-skip-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('excludes .forjis/ paths surfaced by both ls-files and status --porcelain', async () => {
    // Two ordinary source files we DO want summarised — one tracked,
    // one untracked. Their working-tree contents must exist so
    // `filterAndRead` can stat + read them.
    await writeFile(join(repo, 'src-tracked.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'src-untracked.ts'), 'export const b = 2;\n');

    // `.forjis/` paths spread across both probe sources:
    //   ls-files branch  -> .forjis/resolved/plugins.lock.yaml
    //                       .forjis/context/tree.yaml
    //   status ?? branch -> .forjis/config/orgs.yaml
    // We do NOT need to materialise the .forjis files on disk; the
    // filter rejects them before `filterAndRead` is called.
    const lsFiles = [
      'src-tracked.ts',
      '.forjis/resolved/plugins.lock.yaml',
      '.forjis/context/tree.yaml',
    ].join('\n');

    const status = [
      '?? src-untracked.ts',
      '?? .forjis/config/orgs.yaml',
    ].join('\n');

    const git = makeGitStub([
      { stdout: lsFiles + '\n', exitCode: 0 }, // ls-files
      { stdout: status + '\n', exitCode: 0 }, // status --porcelain
      { stdout: '', exitCode: 0 }, // log --name-only (high-traffic)
    ]);

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      // No summarizeImpl: each surviving candidate gets an empty summary.
      // We only care about which paths survive enumeration.
    });

    // Both ordinary source files survive; nothing else. Each .forjis/
    // path was rejected before `filterAndRead`, so they don't show up
    // as `skipped` either.
    expect(result.summarizedCount).toBe(2);
    expect(result.skippedCount).toBe(0);

    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    const paths = tree.files.map((entry) => entry.path).sort();
    expect(paths).toEqual(['src-tracked.ts', 'src-untracked.ts']);

    // Belt-and-braces: no entry whose path enters the runtime-owned tree.
    for (const entry of tree.files) {
      expect(entry.path.startsWith('.forjis/')).toBe(false);
      expect(entry.path === '.forjis').toBe(false);
    }
  });
});
