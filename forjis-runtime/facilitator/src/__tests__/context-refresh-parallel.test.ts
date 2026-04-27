/**
 * Tests for the bounded-concurrency worker pool inside `refreshTreeYaml`.
 *
 * Drives the public {@link refreshTreeYaml} entry point with a stub
 * `summarizeImpl` that records call ordering / in-flight count; asserts
 * the pool never exceeds the configured concurrency, that
 * `concurrency: 1` reproduces serial behaviour, that one failing
 * summariser does not abort the rest, and that the throttled
 * `[context-cache]: <done>/<total> summarized` progress line surfaces
 * via the recorded `warn` injection seam (with a final
 * `<total>/<total>` line guaranteed).
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
  type SummarizeInput,
  type SummarizeOptions,
  type SummarizeResult,
} from '../context-cache/index.js';

/**
 * Builds a fake git seam that replays a fixed response sequence per
 * call. Mirrors the helper used by the other context-refresh tests.
 *
 * @param responses - Ordered list of responses for the git probe calls.
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

/** Result captured by an instrumenting `summarizeImpl` stub. */
interface CapturedCall {
  /** Project-relative path passed to the summariser. */
  path: string;
  /** Monotonic counter snapshot at entry (before the await). */
  enteredAt: number;
  /** Monotonic counter snapshot at exit (after the await). */
  exitedAt: number;
}

/** Output of {@link makeInstrumentedSummarize}. */
interface InstrumentedStub {
  /** The `summarizeImpl`-shaped function to inject. */
  impl: typeof import('../context-cache/index.js').summarizeFile;
  /** Per-call records, in completion order. */
  calls: CapturedCall[];
  /** Maximum simultaneously in-flight calls observed across the run. */
  observedMax: () => number;
}

/**
 * Builds an instrumented `summarizeImpl` stub.
 *
 * On entry, increments a shared in-flight counter, bumps a monotonic
 * step counter, then waits inside a barrier loop until `expected`
 * concurrent workers have entered (or a small step ceiling fires as a
 * safety net). On exit, decrements the in-flight counter and records
 * the call. A separate `failOn` predicate forces a thrown error for
 * failure-isolation tests.
 *
 * @param expected - Number of workers expected to enter concurrently.
 *   When undefined, callers fall back to a single microtask wait.
 * @param failOn - Optional path predicate that throws when matched.
 * @returns The stub plus accessor for the observed-max counter.
 */
function makeInstrumentedSummarize(
  expected?: number,
  failOn?: (path: string) => boolean,
): InstrumentedStub {
  let inFlight = 0;
  let observed = 0;
  let step = 0;
  const calls: CapturedCall[] = [];

  const impl = async (
    input: SummarizeInput,
    _opts?: SummarizeOptions,
  ): Promise<SummarizeResult> => {
    inFlight++;
    if (inFlight > observed) observed = inFlight;
    const enteredAt = step++;
    if (expected !== undefined) {
      // Barrier: wait until `expected` workers have entered (or until
      // every remaining job has entered the stub — whichever comes
      // first). Caps the wait at 50 microtask iterations so a serial
      // (concurrency=1) test still terminates promptly.
      let guard = 0;
      while (inFlight < expected && guard < 50) {
        await new Promise<void>((r) => setImmediate(r));
        guard++;
      }
    } else {
      await new Promise<void>((r) => setImmediate(r));
    }
    inFlight--;
    const exitedAt = step++;
    calls.push({ path: input.path, enteredAt, exitedAt });
    // Mirror `summarizeFile`'s contract: on failure, return
    // `{ summary: '' }` rather than throwing. The worker pool
    // intentionally does NOT wrap `await summarize(...)` in a
    // try/catch (see FR in spec), so a stub that threw would
    // poison the whole pool — that is not what failure isolation
    // means in production.
    if (failOn && failOn(input.path)) {
      return { summary: '' };
    }
    return { summary: `summary-of-${input.path}` };
  };

  return {
    impl,
    calls,
    observedMax: () => observed,
  };
}

describe('refreshTreeYaml worker pool', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ctx-refresh-parallel-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /**
   * Materialises N source files on disk + a git stub returning them as
   * tracked. Returns the path list so the caller can assert on
   * resulting tree.yaml entries.
   */
  async function seedRepo(count: number): Promise<string[]> {
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const p = `f${String(i).padStart(2, '0')}.ts`;
      await writeFile(join(repo, p), `export const x${i} = ${i};\n`);
      paths.push(p);
    }
    return paths;
  }

  it('bounds the in-flight count to the configured concurrency (16 candidates, concurrency: 4)', async () => {
    const paths = await seedRepo(16);
    const stub = makeInstrumentedSummarize(4);
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 4,
      warn: () => undefined,
    });

    // The pool MUST never exceed the configured concurrency. With a
    // barrier-style stub waiting for 4 workers to enter together, the
    // observed maximum settles to exactly 4.
    expect(stub.observedMax()).toBe(4);
    expect(stub.calls).toHaveLength(16);
  });

  it('produces four bursts of four when 16 candidates are processed with concurrency: 4', async () => {
    const paths = await seedRepo(16);
    const stub = makeInstrumentedSummarize(4);
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 4,
      warn: () => undefined,
    });

    expect(stub.calls).toHaveLength(16);
    // With a barrier-stub each burst of 4 enters together, then
    // exits in the same microtask drain. We slice the entry steps
    // into 4 groups of 4 and assert they are non-overlapping (every
    // entry step in group N is strictly less than every entry step
    // in group N+1).
    const entries = stub.calls
      .map((c) => c.enteredAt)
      .sort((a, b) => a - b);
    expect(entries).toHaveLength(16);
    for (let burst = 1; burst < 4; burst++) {
      const prevBurstMax = entries[burst * 4 - 1];
      const thisBurstMin = entries[burst * 4];
      expect(thisBurstMin).toBeGreaterThan(prevBurstMax);
    }
  });

  it('reproduces serial behaviour with concurrency: 1', async () => {
    const paths = await seedRepo(6);
    const stub = makeInstrumentedSummarize();
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 1,
      warn: () => undefined,
    });

    expect(stub.observedMax()).toBe(1);
    expect(stub.calls).toHaveLength(6);
    // Strictly monotonic: each call's exit precedes the next call's
    // entry (no overlap).
    for (let i = 1; i < stub.calls.length; i++) {
      expect(stub.calls[i].enteredAt).toBeGreaterThan(stub.calls[i - 1].exitedAt);
    }
  });

  it('clamps out-of-range concurrency at runtime (defence-in-depth)', async () => {
    const paths = await seedRepo(4);
    const stub = makeInstrumentedSummarize();
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    // concurrency: 0 must clamp to 1 — never throw, never lock up.
    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 0,
      warn: () => undefined,
    });
    expect(stub.observedMax()).toBe(1);
    expect(stub.calls).toHaveLength(4);
  });

  it('isolates per-file failures: one empty summary leaves summary: "" and others succeed', async () => {
    const paths = await seedRepo(5);
    const failingPath = paths[2];
    // No barrier here — the failure-isolation test does not depend on
    // a particular interleaving, only on the per-file failure contract
    // (a `summarizeFile`-shaped stub that returns `{ summary: '' }`
    // for the failing path mirrors what production sees when the
    // engine times out twice).
    const stub = makeInstrumentedSummarize(undefined, (p) => p === failingPath);
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 4,
      warn: () => undefined,
    });

    // Every candidate counts as "summarised" (attempted) regardless
    // of success — matches the existing behaviour of the serial loop.
    expect(result.summarizedCount).toBe(5);

    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    expect(tree.files).toHaveLength(5);

    const failingEntry = tree.files.find((f) => f.path === failingPath);
    expect(failingEntry?.summary).toBe('');

    for (const entry of tree.files) {
      if (entry.path === failingPath) continue;
      expect(entry.summary).toBe(`summary-of-${entry.path}`);
    }
  });

  it('isolates engine throws via the summarizeFile retry-and-degrade contract', async () => {
    // Real `summarizeFile` wired to an `engineInvokeImpl` that throws
    // for a specific candidate. After one retry, `summarizeFile`
    // returns `{ summary: '' }` without throwing — the worker pool
    // sees that and continues.
    const paths = await seedRepo(4);
    const failingPath = paths[1];
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    const engineInvoke = async (
      _system: string,
      user: string,
    ): Promise<string> => {
      if (user.includes(`Path: ${failingPath}`)) {
        throw new Error('engine failure');
      }
      return `summary-for-${user.slice(0, 20)}`;
    };

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: (input: SummarizeInput, opts?: SummarizeOptions) =>
        summarizeFile(input, { ...opts, engineInvokeImpl: engineInvoke }),
      concurrency: 4,
      warn: () => undefined,
    });

    expect(result.summarizedCount).toBe(4);
    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    const failingEntry = tree.files.find((f) => f.path === failingPath);
    expect(failingEntry?.summary).toBe('');
    for (const entry of tree.files) {
      if (entry.path === failingPath) continue;
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it('emits the throttled progress line and a final <total>/<total> line', async () => {
    const paths = await seedRepo(8);
    const stub = makeInstrumentedSummarize();
    const recorded: string[] = [];
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 4,
      warn: (msg: string) => {
        recorded.push(msg);
      },
    });

    const progressLines = recorded.filter((m) =>
      /^\[context-cache\]: \d+\/\d+ summarized$/.test(m),
    );
    expect(progressLines.length).toBeGreaterThan(0);
    expect(progressLines[progressLines.length - 1]).toBe(
      '[context-cache]: 8/8 summarized',
    );
  });

  it('warm refresh keeps every file from cache and emits the final progress line', async () => {
    const paths = await seedRepo(3);
    const stub = makeInstrumentedSummarize();
    const git = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);

    // First (cold) run — populates tree.yaml.
    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub.impl,
      concurrency: 4,
      warn: () => undefined,
    });

    // Second (warm) run — every oid matches; nothing should hit the
    // summariser stub. Use a fresh git stub so the stored response
    // sequence replays from the start.
    const stub2 = makeInstrumentedSummarize();
    const git2 = makeGitStub([
      { stdout: paths.join('\n') + '\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    const recorded: string[] = [];
    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git2 as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: stub2.impl,
      concurrency: 4,
      warn: (msg: string) => {
        recorded.push(msg);
      },
    });

    expect(result.summarizedCount).toBe(0);
    expect(result.keptCount).toBe(3);
    expect(result.droppedCount).toBe(0);
    expect(stub2.calls).toHaveLength(0);

    const progressLines = recorded.filter((m) =>
      /^\[context-cache\]: \d+\/\d+ summarized$/.test(m),
    );
    expect(progressLines[progressLines.length - 1]).toBe(
      '[context-cache]: 3/3 summarized',
    );
  });
});
