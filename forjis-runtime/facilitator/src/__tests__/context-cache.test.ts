/**
 * Unit tests for the `context-cache/` module suite.
 *
 * Covers FR-001, FR-003, FR-004, FR-005, FR-006, FR-008, FR-009, FR-011
 * from `openspec/changes/cache-harden/specs/requirements/spec.md`.
 *
 * All tests stub git / engine / summarizer seams so the suite runs
 * offline. `mkdtemp` fixtures give each test an isolated project root.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { parse as parseYaml } from 'yaml';

import {
  augmentExplorationFilesTouched,
  buildIndexMd,
  computeBlobOid,
  computeBlobOidForFile,
  findOverlappingExplorations,
  invalidateExplorations,
  rankByTask,
  readTreeYaml,
  refreshTreeYaml,
  summarizeFile,
  writeContextArtefact,
  writeContextArtefactsForTask,
  writeTreeYaml,
  type ArtefactRole,
  type ContextArtefact,
  type GitResult,
  type TreeEntry,
  type TreeYaml,
} from '../context-cache/index.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Checks whether `git` is on the PATH. Used to skip cross-check tests. */
function hasGit(): boolean {
  try {
    const result = spawnSync('git', ['--version']);
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Builds a fake git seam that returns the given responses in order. */
function makeGitStub(
  responses: Array<GitResult | ((args: string[]) => GitResult)>,
): jest.Mock<(args: string[], cwd: string) => Promise<GitResult>> {
  let call = 0;
  const fn = jest.fn(
    async (args: string[], _cwd: string): Promise<GitResult> => {
      const r = responses[Math.min(call, responses.length - 1)];
      call++;
      if (typeof r === 'function') return r(args);
      return r;
    },
  );
  return fn as unknown as jest.Mock<
    (args: string[], cwd: string) => Promise<GitResult>
  >;
}

// --------------------------------------------------------------------------
// oid.ts
// --------------------------------------------------------------------------

describe('computeBlobOid / computeBlobOidForFile', () => {
  it('hashes "hello\\n" to the known git-blob sha1', () => {
    // `printf "hello\n" | git hash-object --stdin` yields:
    //   ce013625030ba8dba906f756967f9e9ca394464a
    expect(computeBlobOid(Buffer.from('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });

  it('hashes an empty file to the known empty-blob sha1', () => {
    expect(computeBlobOid(Buffer.alloc(0))).toBe(
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    );
  });

  it('matches git hash-object for ASCII file', async () => {
    if (!hasGit()) return;
    const tmp = await mkdtemp(join(tmpdir(), 'oid-ascii-'));
    try {
      const path = join(tmp, 'f.txt');
      await writeFile(path, 'hello world');
      const viaGit = spawnSync('git', ['hash-object', path]).stdout
        .toString()
        .trim();
      const viaOurs = await computeBlobOidForFile(tmp, 'f.txt');
      expect(viaOurs).toBe(viaGit);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('matches git hash-object for a file with a trailing NUL byte', async () => {
    if (!hasGit()) return;
    const tmp = await mkdtemp(join(tmpdir(), 'oid-nul-'));
    try {
      const path = join(tmp, 'f.bin');
      await writeFile(path, Buffer.from([0x61, 0x00]));
      const viaGit = spawnSync('git', ['hash-object', path]).stdout
        .toString()
        .trim();
      const viaOurs = await computeBlobOidForFile(tmp, 'f.bin');
      expect(viaOurs).toBe(viaGit);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('matches git hash-object for a zero-byte file', async () => {
    if (!hasGit()) return;
    const tmp = await mkdtemp(join(tmpdir(), 'oid-empty-'));
    try {
      const path = join(tmp, 'empty');
      await writeFile(path, Buffer.alloc(0));
      const viaGit = spawnSync('git', ['hash-object', path]).stdout
        .toString()
        .trim();
      const viaOurs = await computeBlobOidForFile(tmp, 'empty');
      expect(viaOurs).toBe(viaGit);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects paths that escape the project directory', async () => {
    await expect(
      computeBlobOidForFile('/tmp/project', '/etc/passwd'),
    ).rejects.toThrow(/escapes projectDir/);
  });
});

// --------------------------------------------------------------------------
// tree-yaml.ts
// --------------------------------------------------------------------------

describe('readTreeYaml / writeTreeYaml', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tree-yaml-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns {files: []} when the file does not exist', async () => {
    const result = await readTreeYaml(join(tmp, 'missing.yaml'));
    expect(result).toEqual({ files: [] });
  });

  it('returns {files: []} + warn on malformed YAML', async () => {
    const path = join(tmp, 'bad.yaml');
    await writeFile(path, 'not: [valid: yaml: structure');
    const warn = jest.fn();
    const result = await readTreeYaml(path, {
      warn: warn as unknown as (msg: string) => void,
    });
    expect(result).toEqual({ files: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed tree.yaml'),
    );
  });

  it('returns {files: []} + warn on well-formed but unexpected shape', async () => {
    const path = join(tmp, 'weird.yaml');
    await writeFile(path, 'wrong_key: 1\n');
    const warn = jest.fn();
    const result = await readTreeYaml(path, {
      warn: warn as unknown as (msg: string) => void,
    });
    expect(result).toEqual({ files: [] });
    expect(warn).toHaveBeenCalled();
  });

  it('round-trips a well-formed tree.yaml', async () => {
    const path = join(tmp, 'tree.yaml');
    const data: TreeYaml = {
      files: [
        { path: 'a.ts', oid: 'a'.repeat(40), summary: 'file a does X' },
        { path: 'b.ts', oid: 'b'.repeat(40), summary: 'file b does Y' },
      ],
    };
    await writeTreeYaml(path, data);
    const reread = await readTreeYaml(path);
    expect(reread).toEqual(data);
  });
});

// --------------------------------------------------------------------------
// refresh.ts
// --------------------------------------------------------------------------

describe('refreshTreeYaml', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'refresh-repo-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('no-op on unchanged repo yields zero summarize calls', async () => {
    await writeFile(join(repo, 'a.ts'), 'console.log("a");');
    await writeFile(join(repo, 'b.ts'), 'console.log("b");');

    const git = makeGitStub([
      // first refresh: ls-files then status
      { stdout: 'a.ts\nb.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 }, // high-traffic log
      // second refresh
      { stdout: 'a.ts\nb.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    const summarize = jest.fn<typeof summarizeFile>().mockResolvedValue({
      summary: 'stub summary',
    });

    const first = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });
    expect(first.summarizedCount).toBe(2);

    const firstTree = await readFile(
      join(repo, '.forjis', 'context', 'tree.yaml'),
      'utf-8',
    );

    summarize.mockClear();
    const second = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (
        args: string[],
        cwd: string,
      ) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });
    expect(second.summarizedCount).toBe(0);
    expect(second.keptCount).toBe(2);
    expect(summarize).not.toHaveBeenCalled();

    const secondTree = await readFile(
      join(repo, '.forjis', 'context', 'tree.yaml'),
      'utf-8',
    );
    expect(secondTree).toBe(firstTree);
  });

  it('partial refresh only re-summarises changed files', async () => {
    await writeFile(join(repo, 'a.ts'), 'content a');
    await writeFile(join(repo, 'b.ts'), 'content b');
    await writeFile(join(repo, 'c.ts'), 'content c');

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\nc.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: 'a.ts\nb.ts\nc.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    let seq = 0;
    const summarize = jest.fn<typeof summarizeFile>(async () => {
      seq++;
      return { summary: `summary ${seq}` };
    });

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });

    // Modify only b.ts.
    await writeFile(join(repo, 'b.ts'), 'content b CHANGED');

    summarize.mockClear();
    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });
    expect(result.summarizedCount).toBe(1);
    expect(result.keptCount).toBe(2);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('skips binary files (NUL byte in first 8 KB)', async () => {
    const binary = Buffer.concat([Buffer.from('ELF'), Buffer.from([0, 1, 2])]);
    await writeFile(join(repo, 'bin.bin'), binary);
    await writeFile(join(repo, 'ok.ts'), 'hello');

    const git = makeGitStub([
      { stdout: 'bin.bin\nok.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    const summarize = jest.fn<typeof summarizeFile>().mockResolvedValue({
      summary: 'stub',
    });

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });
    expect(result.skippedCount).toBe(1);
    expect(summarize).toHaveBeenCalledTimes(1); // only ok.ts
    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    expect(tree.files.find((f) => f.path === 'bin.bin')).toBeUndefined();
    expect(tree.files.find((f) => f.path === 'ok.ts')).toBeDefined();
  });

  it('skips oversized files (> maxBytes)', async () => {
    await writeFile(join(repo, 'small.ts'), 'x');
    await writeFile(join(repo, 'big.ts'), 'a'.repeat(2000));

    const git = makeGitStub([
      { stdout: 'small.ts\nbig.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    const summarize = jest.fn<typeof summarizeFile>().mockResolvedValue({
      summary: 'stub',
    });

    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
      maxBytes: 1000,
    });
    expect(result.skippedCount).toBe(1);
    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    expect(tree.files.map((f) => f.path)).toEqual(['small.ts']);
  });

  it('drops entries whose path left the candidate set', async () => {
    await writeFile(join(repo, 'a.ts'), 'a');
    await writeFile(join(repo, 'b.ts'), 'b');

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: 'a.ts\n', exitCode: 0 }, // b.ts gone
      { stdout: '', exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ]);
    const summarize = jest.fn<typeof summarizeFile>().mockResolvedValue({
      summary: 'stub',
    });

    await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });
    const result = await refreshTreeYaml({
      repoRoot: repo,
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
      summarizeImpl: summarize as unknown as typeof summarizeFile,
    });
    expect(result.droppedCount).toBe(1);
    const tree = await readTreeYaml(
      join(repo, '.forjis', 'context', 'tree.yaml'),
    );
    expect(tree.files.map((f) => f.path)).toEqual(['a.ts']);
  });
});

// --------------------------------------------------------------------------
// summarize.ts — just the empty-engine short-circuit
// --------------------------------------------------------------------------

describe('summarizeFile', () => {
  it('returns empty summary when no engine is wired', async () => {
    const warn = jest.fn();
    const result = await summarizeFile(
      { path: 'a.ts', content: Buffer.from('hi') },
      { warn: warn as unknown as (msg: string) => void },
    );
    expect(result.summary).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no engine wired'));
  });

  it('returns engine output trimmed to 120 chars and ASCII', async () => {
    const long = `x`.repeat(200) + '\n';
    const engine = jest
      .fn<(sys: string, user: string) => Promise<string>>()
      .mockResolvedValue(long);
    const result = await summarizeFile(
      { path: 'a.ts', content: Buffer.from('hi') },
      { engineInvokeImpl: engine },
    );
    expect(result.summary.length).toBeLessThanOrEqual(120);
  });

  it('retries once on empty completion and returns empty after second failure', async () => {
    const engine = jest
      .fn<(sys: string, user: string) => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    const warn = jest.fn();
    const result = await summarizeFile(
      { path: 'a.ts', content: Buffer.from('hi') },
      {
        engineInvokeImpl: engine,
        warn: warn as unknown as (msg: string) => void,
      },
    );
    expect(engine).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe('');
  });
});

// --------------------------------------------------------------------------
// ranking.ts
// --------------------------------------------------------------------------

describe('rankByTask', () => {
  it('path-token match outranks unrelated row', () => {
    const rows: TreeEntry[] = [
      { path: 'inspector-message-pump.ts', oid: '0'.repeat(40), summary: 'pumps inspector events' },
      { path: 'health-check.ts', oid: '1'.repeat(40), summary: 'pings engines' },
    ];
    const ranked = rankByTask(rows, 'fix inspector pump');
    expect(ranked[0].path).toBe('inspector-message-pump.ts');
    expect(ranked[1].path).toBe('health-check.ts');
  });

  it('filename fuzzy match outranks path-only match', () => {
    const rows: TreeEntry[] = [
      { path: 'facilitator/src/commands/run.ts', oid: '2'.repeat(40), summary: 'runs things' },
      { path: 'docs/run-notes.md', oid: '3'.repeat(40), summary: 'documents running' },
    ];
    const ranked = rankByTask(rows, 'run.ts');
    expect(ranked[0].path).toBe('facilitator/src/commands/run.ts');
  });

  it('deterministic tie-break by path ASC', () => {
    const rows: TreeEntry[] = [
      { path: 'z.ts', oid: '4'.repeat(40), summary: '' },
      { path: 'a.ts', oid: '5'.repeat(40), summary: '' },
      { path: 'm.ts', oid: '6'.repeat(40), summary: '' },
    ];
    // All rows score zero for an unrelated description; order must be alphabetical.
    const ranked = rankByTask(rows, 'unrelated');
    expect(ranked.map((r) => r.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('respects the limit argument', () => {
    const rows: TreeEntry[] = Array.from({ length: 100 }, (_, i) => ({
      path: `f${i}.ts`,
      oid: '7'.repeat(40),
      summary: '',
    }));
    const ranked = rankByTask(rows, 'x', 5);
    expect(ranked).toHaveLength(5);
  });
});

// --------------------------------------------------------------------------
// invalidator.ts
// --------------------------------------------------------------------------

describe('invalidateExplorations', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'invalidator-'));
    await mkdir(join(tmp, '.forjis', 'exploration'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeExploration(
    taskId: string,
    fm: string,
    body: string,
  ): Promise<void> {
    const content = `---\n${fm}\n---\n${body}`;
    await writeFile(join(tmp, '.forjis', 'exploration', `${taskId}.md`), content);
  }

  it('flips status on overlap and preserves body bytes', async () => {
    const bodyBytes = '# body\n\nsome contents\nmore\n';
    await writeExploration(
      'T1',
      [
        'status: valid',
        'createdAt: "2026-04-20T00:00:00Z"',
        'taskId: "T1"',
        'taskSummary: "first"',
        'files_touched:',
        '  - path: src/a.ts',
        '    oid: aaaa',
      ].join('\n'),
      bodyBytes,
    );
    await writeExploration(
      'T2',
      [
        'status: valid',
        'createdAt: "2026-04-20T00:00:00Z"',
        'taskId: "T2"',
        'taskSummary: "second"',
        'files_touched:',
        '  - path: src/other.ts',
        '    oid: bbbb',
      ].join('\n'),
      '# other body\n',
    );

    const now = new Date('2026-04-24T00:00:00.000Z');
    const result = await invalidateExplorations({
      projectDir: tmp,
      taskId: 'T3',
      changedPaths: ['src/a.ts'],
      now,
    });
    expect(result.invalidatedCount).toBe(1);
    expect(result.skippedCount).toBe(1);

    const flipped = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    expect(flipped).toMatch(/status:\s+invalid/);
    expect(flipped).toMatch(/invalidatedAt:\s+["']?2026-04-24/);
    expect(flipped).toMatch(/invalidatedBy:\s+T3/);
    // Body preserved.
    expect(flipped.endsWith(bodyBytes)).toBe(true);
  });

  it('skips legacy entries (no files_touched key)', async () => {
    await writeExploration(
      'T1',
      [
        'status: valid',
        'createdAt: "2026-04-20T00:00:00Z"',
        'taskId: "T1"',
        'taskSummary: "legacy"',
      ].join('\n'),
      '# body\n',
    );
    const before = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    const result = await invalidateExplorations({
      projectDir: tmp,
      taskId: 'T3',
      changedPaths: ['src/a.ts'],
      now: new Date(),
    });
    expect(result.invalidatedCount).toBe(0);
    const after = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    expect(after).toBe(before);
  });

  it('skips already-invalid entries', async () => {
    await writeExploration(
      'T1',
      [
        'status: invalid',
        'createdAt: "2026-04-20T00:00:00Z"',
        'taskId: "T1"',
        'taskSummary: "old"',
        'files_touched:',
        '  - path: src/a.ts',
        '    oid: aaaa',
      ].join('\n'),
      '# body\n',
    );
    const before = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    const result = await invalidateExplorations({
      projectDir: tmp,
      taskId: 'T3',
      changedPaths: ['src/a.ts'],
      now: new Date(),
    });
    expect(result.invalidatedCount).toBe(0);
    const after = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    expect(after).toBe(before);
  });

  it('handles rename / copy status lines — both paths treated as changed', async () => {
    await writeExploration(
      'T1',
      [
        'status: valid',
        'createdAt: "2026-04-20T00:00:00Z"',
        'taskId: "T1"',
        'taskSummary: "s"',
        'files_touched:',
        '  - path: new.ts',
        '    oid: aaaa',
      ].join('\n'),
      'body\n',
    );
    const result = await invalidateExplorations({
      projectDir: tmp,
      taskId: 'T3',
      changedPaths: ['R100\told.ts\tnew.ts'],
      now: new Date(),
    });
    expect(result.invalidatedCount).toBe(1);
  });

  it('degrades gracefully when readFile throws', async () => {
    await writeExploration(
      'T1',
      [
        'status: valid',
        'createdAt: "2026-04-20T00:00:00Z"',
        'taskId: "T1"',
        'taskSummary: "s"',
        'files_touched:',
        '  - path: src/a.ts',
        '    oid: aaaa',
      ].join('\n'),
      'body\n',
    );
    const readFileImpl = jest.fn<() => Promise<string>>().mockRejectedValue(
      new Error('boom'),
    );
    const warn = jest.fn();
    const result = await invalidateExplorations({
      projectDir: tmp,
      taskId: 'T3',
      changedPaths: ['src/a.ts'],
      now: new Date(),
      readFileImpl: readFileImpl as unknown as typeof import('node:fs/promises').readFile,
      warn: warn as unknown as (msg: string) => void,
    });
    expect(result.invalidatedCount).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// exploration-writer.ts
// --------------------------------------------------------------------------

describe('augmentExplorationFilesTouched', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aug-writer-'));
    await mkdir(join(tmp, '.forjis', 'exploration'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('injects files_touched with sorted {path,oid} entries; body preserved', async () => {
    await writeFile(join(tmp, 'b.ts'), 'content b');
    await writeFile(join(tmp, 'a.ts'), 'content a');

    const bodyText = '# exploration body\n\nlots of words\n';
    const fm = [
      'status: valid',
      'createdAt: "2026-04-20T00:00:00Z"',
      'taskId: "T1"',
      'taskSummary: "first"',
    ].join('\n');
    await writeFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      `---\n${fm}\n---\n${bodyText}`,
    );

    await augmentExplorationFilesTouched({
      projectDir: tmp,
      taskId: 'T1',
      filesRead: ['b.ts', 'a.ts'],
    });

    const after = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    // Sorted by path ASC → a.ts before b.ts.
    expect(after.indexOf('a.ts')).toBeLessThan(after.indexOf('b.ts'));
    expect(after).toMatch(/files_touched:/);
    // Body preserved byte-for-byte at the end.
    expect(after.endsWith(bodyText)).toBe(true);
  });

  it('empty filesRead → files_touched: []', async () => {
    const fm = [
      'status: valid',
      'createdAt: "2026-04-20T00:00:00Z"',
      'taskId: "T1"',
      'taskSummary: "first"',
    ].join('\n');
    await writeFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      `---\n${fm}\n---\n# body\n`,
    );
    await augmentExplorationFilesTouched({
      projectDir: tmp,
      taskId: 'T1',
      filesRead: [],
    });
    const after = await readFile(
      join(tmp, '.forjis', 'exploration', 'T1.md'),
      'utf-8',
    );
    expect(after).toMatch(/files_touched:\s*\[\]/);
  });

  it('silently no-ops when the cache file does not exist', async () => {
    const warn = jest.fn();
    await augmentExplorationFilesTouched({
      projectDir: tmp,
      taskId: 'missing-task',
      filesRead: ['a.ts'],
      warn: warn as unknown as (msg: string) => void,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// exploration-overlap.ts
// --------------------------------------------------------------------------

describe('findOverlappingExplorations', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'overlap-'));
    await mkdir(join(tmp, '.forjis', 'exploration'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeEntry(
    id: string,
    status: string,
    createdAt: string,
    touched: string[],
    body = '# body\n',
  ): Promise<void> {
    const touchedYaml = touched.length === 0
      ? 'files_touched: []'
      : ['files_touched:', ...touched.map((p) => `  - path: ${p}\n    oid: ${'a'.repeat(40)}`)].join('\n');
    const fm = [
      `status: ${status}`,
      `createdAt: "${createdAt}"`,
      `taskId: "${id}"`,
      `taskSummary: "summary ${id}"`,
      touchedYaml,
    ].join('\n');
    await writeFile(
      join(tmp, '.forjis', 'exploration', `${id}.md`),
      `---\n${fm}\n---\n${body}`,
    );
  }

  it('caps at limit and sorts by createdAt DESC', async () => {
    await writeEntry('T1', 'valid', '2026-04-20T00:00:00Z', ['src/a.ts']);
    await writeEntry('T2', 'valid', '2026-04-21T00:00:00Z', ['src/a.ts']);
    await writeEntry('T3', 'valid', '2026-04-22T00:00:00Z', ['src/a.ts']);
    await writeEntry('T4', 'valid', '2026-04-23T00:00:00Z', ['src/a.ts']);
    await writeEntry('T5', 'valid', '2026-04-24T00:00:00Z', ['src/a.ts']);

    const result = await findOverlappingExplorations({
      projectDir: tmp,
      currentTaskId: 'T999',
      candidatePaths: ['src/a.ts'],
    });
    expect(result.map((r) => r.taskId)).toEqual(['T5', 'T4', 'T3']);
  });

  it('excludes the current task', async () => {
    await writeEntry('T7', 'valid', '2026-04-24T00:00:00Z', ['src/a.ts']);
    const result = await findOverlappingExplorations({
      projectDir: tmp,
      currentTaskId: 'T7',
      candidatePaths: ['src/a.ts'],
    });
    expect(result).toEqual([]);
  });

  it('excludes legacy entries (no files_touched)', async () => {
    const fm = [
      'status: valid',
      'createdAt: "2026-04-24T00:00:00Z"',
      'taskId: "T8"',
      'taskSummary: "s"',
    ].join('\n');
    await writeFile(
      join(tmp, '.forjis', 'exploration', 'T8.md'),
      `---\n${fm}\n---\nbody\n`,
    );
    const result = await findOverlappingExplorations({
      projectDir: tmp,
      currentTaskId: 'X',
      candidatePaths: ['src/a.ts'],
    });
    expect(result).toEqual([]);
  });

  it('returns empty list when exploration directory is missing', async () => {
    const result = await findOverlappingExplorations({
      projectDir: '/nonexistent/path',
      currentTaskId: 'X',
      candidatePaths: ['src/a.ts'],
    });
    expect(result).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// artefact-writer.ts
// --------------------------------------------------------------------------

describe('writeContextArtefact', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'artefact-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const baseOpts = (): {
    tree: TreeYaml;
    indexMd: string;
  } => ({
    tree: {
      files: Array.from({ length: 100 }, (_, i) => ({
        path: `file-${i}.ts`,
        oid: 'a'.repeat(40),
        summary: `summary ${i}`,
      })),
    },
    indexMd: '## Workspace layout\n\n- src/ — (no description)\n',
  });

  it('skips Reviewer roles silently', async () => {
    const { tree, indexMd } = baseOpts();
    const result = await writeContextArtefact({
      projectDir: tmp,
      taskId: 'T1',
      role: { org: 'a', team: 'b', role: 'Reviewer', stage: 'reviewer' },
      taskDescription: 'task',
      tree,
      indexMd,
      inlineTopN: 5,
      candidatePaths: [],
    });
    expect(result.artefactPath).toBeNull();
  });

  it('honours inline_top_n (5 -> 5 ranked rows)', async () => {
    const { tree, indexMd } = baseOpts();
    const result = await writeContextArtefact({
      projectDir: tmp,
      taskId: 'T1',
      role: { org: 'a', team: 'b', role: 'Explorer', stage: 'explorer' },
      taskDescription: 'unrelated task',
      tree,
      indexMd,
      inlineTopN: 5,
      candidatePaths: [],
    });
    expect(result.artefactPath).not.toBeNull();
    const content = await readFile(result.artefactPath!, 'utf-8');
    const parsed = parseYaml(content) as ContextArtefact;
    expect(parsed.ranked_rows).toHaveLength(5);
    expect(parsed.version).toBe(1);
  });
});

describe('writeContextArtefactsForTask', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'artefacts-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes one artefact per non-Reviewer role', async () => {
    const roles: ArtefactRole[] = [
      { org: 'x', team: 'y', role: 'Explorer', stage: 'explorer' },
      { org: 'x', team: 'y', role: 'Analyst', stage: 'analyst' },
      { org: 'x', team: 'y', role: 'Architect', stage: 'architect' },
      { org: 'x', team: 'y', role: 'Developer', stage: 'developer' },
      { org: 'x', team: 'y', role: 'Reviewer', stage: 'reviewer' },
    ];
    const result = await writeContextArtefactsForTask({
      projectDir: tmp,
      taskId: 'T1',
      taskDescription: 'task',
      roles,
      tree: { files: [] },
      indexMd: '# idx',
      inlineTopN: 20,
      candidatePaths: [],
    });
    expect(result.written).toBe(4);
    expect(result.skipped).toBe(1);
  });
});

// --------------------------------------------------------------------------
// index-md.ts
// --------------------------------------------------------------------------

describe('buildIndexMd', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'idxmd-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('emits workspace layout for top-level dirs + high-traffic section', async () => {
    await mkdir(join(tmp, 'src'));
    await mkdir(join(tmp, 'docs'));

    const git = makeGitStub([
      { stdout: 'a.ts\nb.ts\na.ts\nc.ts\na.ts\nb.ts\n', exitCode: 0 },
    ]);
    const md = await buildIndexMd({
      repoRoot: tmp,
      tree: { files: [] },
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
    });
    expect(md).toContain('## Workspace layout');
    expect(md).toContain('- docs/ — (no description)');
    expect(md).toContain('- src/ — (no description)');
    expect(md).toContain('## High-traffic files');
    expect(md).toContain('- a.ts (3x)');
  });

  it('shows (no data) when git log exit is non-zero', async () => {
    const git = makeGitStub([{ stdout: '', exitCode: 128 }]);
    const md = await buildIndexMd({
      repoRoot: tmp,
      tree: { files: [] },
      gitImpl: git as unknown as (args: string[], cwd: string) => Promise<GitResult>,
    });
    expect(md).toContain('## High-traffic files');
    expect(md).toContain('(no data)');
  });
});
