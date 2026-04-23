/**
 * Unit tests for `resolveRoleVisuals` in role-visuals/index.ts.
 *
 * All tests stub the probe / expand / acquire / release / stat seams so
 * the suite is fully offline and deterministic. `mkdtemp` fixtures
 * provide an on-disk project+task root for the artefact write step
 * (the writer reuses the real `atomicWriteFile`).
 *
 * Covers FR-08, FR-09, FR-10, FR-13, FR-14, FR-15, FR-17, FR-18,
 * FR-19, FR-20, NFR-02, NFR-05, NFR-06, NFR-09.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { parse as parseYaml } from 'yaml';

import type { RuntimeRole } from '@forjis/resolver';

import {
  collectPinAssets,
  resolveRoleVisuals,
  type VisualsArtefact,
} from '../index.js';

/** Builds a minimal runtime role with the supplied visuals list. */
function makeRole(visuals?: RuntimeRole['visuals']): RuntimeRole {
  const role: RuntimeRole = {
    name: 'Developer',
    org: 'acme',
    team: 'eng',
    agent: 'dev-agent',
    skills: [],
    hooks: { pre: [], validation: [], post: [] },
  };
  if (visuals !== undefined) role.visuals = visuals;
  return role;
}

/** Reads and parses the artefact written to disk. */
async function readArtefact(artefactPath: string): Promise<VisualsArtefact> {
  const content = await readFile(artefactPath, 'utf-8');
  return parseYaml(content) as VisualsArtefact;
}

describe('resolveRoleVisuals — gating and early out', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-index-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes no artefact when role has no visuals', async () => {
    const warn = jest.fn();
    const result = await resolveRoleVisuals({
      role: makeRole(),
      taskId: 't1',
      projectDir: tmpDir,
      warn: warn as unknown as (msg: string) => void,
    });
    expect(result.artefactPath).toBeNull();
    expect(result.acquiredKeys).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes no artefact when role has empty visuals', async () => {
    const result = await resolveRoleVisuals({
      role: makeRole([]),
      taskId: 't1',
      projectDir: tmpDir,
    });
    expect(result.artefactPath).toBeNull();
    expect(result.acquiredKeys).toEqual([]);
  });
});

describe('resolveRoleVisuals — http probe paths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-http-'));
    await mkdir(join(tmpDir, '.forjis', 'tasks', 't1'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('probe success skips command spawn and records reachable', async () => {
    const probeImpl = jest.fn<() => Promise<{ reachable: true; detail: 'ok'; statusCode: number }>>().mockResolvedValue({ reachable: true, detail: 'ok', statusCode: 200 });
    const acquireImpl = jest.fn();
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'http://localhost:5173', command: 'npm run dev' }]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      acquireImpl: acquireImpl as unknown as typeof import('../command-runner.js').acquire,
    });
    expect(acquireImpl).not.toHaveBeenCalled();
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('reachable');
    expect(result.acquiredKeys).toEqual([]);
  });

  it('probe fail without command marks probe-failed', async () => {
    const probeImpl = jest.fn<() => Promise<{ reachable: false; detail: 'curl-error' }>>().mockResolvedValue({ reachable: false, detail: 'curl-error' });
    const acquireImpl = jest.fn();
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'http://localhost:5173' }]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      acquireImpl: acquireImpl as unknown as typeof import('../command-runner.js').acquire,
    });
    expect(acquireImpl).not.toHaveBeenCalled();
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('probe-failed');
  });

  it('probe fail with command → spawn + retry + reachable', async () => {
    // First call fails, second succeeds — simulating a server that
    // became healthy after the command boot.
    let call = 0;
    const probeImpl = jest.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ reachable: false, detail: 'curl-error' });
      return Promise.resolve({ reachable: true, detail: 'ok', statusCode: 200 });
    });
    const acquireImpl = jest.fn().mockReturnValue({ key: 'K1', exited: Promise.resolve({ code: 0, signal: null }) });
    const releaseImpl = jest.fn().mockResolvedValue(undefined);
    const sleepImpl = jest.fn().mockResolvedValue(undefined);

    let clock = 0;
    const now = () => clock;

    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'http://localhost:5173', command: 'npm run dev' }]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      acquireImpl: acquireImpl as unknown as typeof import('../command-runner.js').acquire,
      releaseImpl: releaseImpl as unknown as typeof import('../command-runner.js').release,
      sleepImpl: ((ms: number) => {
        clock += ms;
        return sleepImpl(ms);
      }) as unknown as typeof import('node:timers/promises').setTimeout,
      now,
    });
    expect(acquireImpl).toHaveBeenCalledTimes(1);
    expect(releaseImpl).not.toHaveBeenCalled();
    expect(result.acquiredKeys).toEqual(['K1']);
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('reachable');
  });

  it('probe fail with command that never succeeds → release immediately and mark probe-failed', async () => {
    const probeImpl = jest.fn().mockResolvedValue({ reachable: false, detail: 'curl-error' });
    const acquireImpl = jest.fn().mockReturnValue({ key: 'K1', exited: Promise.resolve({ code: 0, signal: null }) });
    const releaseImpl = jest.fn().mockResolvedValue(undefined);

    let clock = 0;
    const now = () => clock;
    const sleepImpl = ((ms: number) => {
      clock += ms;
      return Promise.resolve();
    }) as unknown as typeof import('node:timers/promises').setTimeout;

    const warn = jest.fn();
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'http://localhost:5173', command: 'npm run dev' }]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      acquireImpl: acquireImpl as unknown as typeof import('../command-runner.js').acquire,
      releaseImpl: releaseImpl as unknown as typeof import('../command-runner.js').release,
      sleepImpl,
      now,
      warn: warn as unknown as (msg: string) => void,
    });

    expect(releaseImpl).toHaveBeenCalledWith('K1');
    expect(result.acquiredKeys).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boot timeout'));
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('probe-failed');
  });
});

describe('resolveRoleVisuals — file:// / dir:// expansion', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-files-'));
    await mkdir(join(tmpDir, '.forjis', 'tasks', 't1'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('file:// with matches marks expanded', async () => {
    const expandFileImpl = jest.fn().mockResolvedValue({
      paths: ['/tmp/design/a.png', '/tmp/design/b.png'],
      escapeWarnings: [],
    });
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'file://./design/*.png' }]),
      taskId: 't1',
      projectDir: tmpDir,
      expandFileImpl: expandFileImpl as unknown as typeof import('../path-expand.js').expandFileGlob,
    });
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('expanded');
    expect(artefact.entries[0].paths).toEqual(['/tmp/design/a.png', '/tmp/design/b.png']);
  });

  it('file:// empty match marks expanded-empty with warning', async () => {
    const expandFileImpl = jest.fn().mockResolvedValue({
      paths: [],
      escapeWarnings: [],
    });
    const warn = jest.fn();
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'file://./design/*.png' }]),
      taskId: 't1',
      projectDir: tmpDir,
      expandFileImpl: expandFileImpl as unknown as typeof import('../path-expand.js').expandFileGlob,
      warn: warn as unknown as (msg: string) => void,
    });
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('expanded-empty');
    expect(artefact.entries[0].paths).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched no files'));
  });

  it('dir:// with matches marks expanded', async () => {
    const expandDirImpl = jest.fn().mockResolvedValue({
      paths: ['/tmp/design/a.png'],
      skipped: [],
    });
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'dir://./design' }]),
      taskId: 't1',
      projectDir: tmpDir,
      expandDirImpl: expandDirImpl as unknown as typeof import('../path-expand.js').expandDirRecursive,
    });
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].status).toBe('expanded');
    expect(artefact.entries[0].paths).toEqual(['/tmp/design/a.png']);
  });
});

describe('resolveRoleVisuals — pin assets', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-pin-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('includes sorted pin-*.png and pin-*.json when visuals non-empty', async () => {
    const taskDir = join(tmpDir, '.forjis', 'tasks', 't1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'pin-02-viewport.png'), 'x', 'utf-8');
    await writeFile(join(taskDir, 'pin-01-element.png'), 'y', 'utf-8');
    await writeFile(join(taskDir, 'pin-01-styles.json'), '{}', 'utf-8');
    await writeFile(join(taskDir, 'unrelated.png'), 'z', 'utf-8');

    const probeImpl = jest.fn().mockResolvedValue({ reachable: true, detail: 'ok', statusCode: 200 });
    const result = await resolveRoleVisuals({
      role: makeRole([{ location: 'http://localhost:5173' }]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
    });
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.pinAssets.map(p => p.split('/').pop())).toEqual([
      'pin-01-element.png',
      'pin-01-styles.json',
      'pin-02-viewport.png',
    ]);
  });

  it('collectPinAssets returns empty when task dir does not exist', async () => {
    const result = await collectPinAssets(join(tmpDir, '.forjis', 'tasks', 'missing'));
    expect(result).toEqual([]);
  });
});

describe('resolveRoleVisuals — credentials handling', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-creds-'));
    await mkdir(join(tmpDir, '.forjis', 'tasks', 't1'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('missing credentials file → credentialsMissing:true, no read, warning', async () => {
    const probeImpl = jest.fn().mockResolvedValue({ reachable: true, detail: 'ok', statusCode: 200 });
    const warn = jest.fn();
    const statImpl = jest.fn().mockRejectedValue(new Error('ENOENT'));
    const result = await resolveRoleVisuals({
      role: makeRole([
        { location: 'http://localhost:5173', credentials: '.forjis/secrets/missing.env' },
      ]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      statImpl: statImpl as unknown as typeof import('node:fs/promises').stat,
      warn: warn as unknown as (msg: string) => void,
    });
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].credentialsMissing).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing at invocation'));
  });

  it('present credentials file → no credentialsMissing flag', async () => {
    await mkdir(join(tmpDir, '.forjis', 'secrets'), { recursive: true });
    await writeFile(
      join(tmpDir, '.forjis', 'secrets', 'present.env'),
      'TOKEN=x',
      'utf-8'
    );
    const probeImpl = jest.fn().mockResolvedValue({ reachable: true, detail: 'ok', statusCode: 200 });
    const result = await resolveRoleVisuals({
      role: makeRole([
        {
          location: 'http://localhost:5173',
          credentials: '.forjis/secrets/present.env',
        },
      ]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
    });
    const artefact = await readArtefact(result.artefactPath!);
    expect(artefact.entries[0].credentialsMissing).toBeUndefined();
    expect(artefact.entries[0].credentials).toBe('.forjis/secrets/present.env');
  });

  it('secrecy: token in credentials file never appears in artefact or warnings', async () => {
    await mkdir(join(tmpDir, '.forjis', 'secrets'), { recursive: true });
    const TOKEN = 'SECRET_TOKEN_XYZ123';
    await writeFile(
      join(tmpDir, '.forjis', 'secrets', 'fixture.env'),
      `TOKEN=${TOKEN}`,
      'utf-8'
    );
    const probeImpl = jest.fn().mockResolvedValue({ reachable: true, detail: 'ok', statusCode: 200 });
    const warnLines: string[] = [];
    const logLines: string[] = [];
    const result = await resolveRoleVisuals({
      role: makeRole([
        {
          location: 'http://localhost:5173',
          credentials: '.forjis/secrets/fixture.env',
        },
      ]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      warn: (msg: string) => warnLines.push(msg),
      onLine: (line: string) => logLines.push(line),
    });
    const rawArtefact = await readFile(result.artefactPath!, 'utf-8');
    expect(rawArtefact).not.toContain(TOKEN);
    expect(warnLines.join('\n')).not.toContain(TOKEN);
    expect(logLines.join('\n')).not.toContain(TOKEN);
  });
});

describe('resolveRoleVisuals — NFR-05 canonical-shape snapshot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'visuals-snapshot-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('produces a stable top-level YAML shape', async () => {
    const taskDir = join(tmpDir, '.forjis', 'tasks', 't1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'pin-01-element.png'), 'x', 'utf-8');

    const probeImpl = jest.fn()
      .mockResolvedValueOnce({ reachable: true, detail: 'ok', statusCode: 200 })
      .mockResolvedValueOnce({ reachable: false, detail: 'curl-error' })
      .mockResolvedValueOnce({ reachable: true, detail: 'ok', statusCode: 200 });
    const expandFileImpl = jest.fn().mockResolvedValue({
      paths: ['/abs/design/a.png'],
      escapeWarnings: [],
    });
    const expandDirImpl = jest.fn().mockResolvedValue({
      paths: ['/abs/assets/b.png'],
      skipped: [],
    });
    await mkdir(join(tmpDir, '.forjis', 'secrets'), { recursive: true });
    await writeFile(
      join(tmpDir, '.forjis', 'secrets', 'ok.env'),
      'TOKEN=x',
      'utf-8'
    );

    const result = await resolveRoleVisuals({
      role: makeRole([
        { location: 'http://reachable.example' },
        { location: 'http://probefail.example' },
        { location: 'file://design/*.png' },
        { location: 'dir://assets' },
        {
          location: 'https://with.credentials',
          credentials: '.forjis/secrets/ok.env',
        },
      ]),
      taskId: 't1',
      projectDir: tmpDir,
      probeImpl: probeImpl as unknown as typeof import('../probe.js').probeHttp,
      expandFileImpl: expandFileImpl as unknown as typeof import('../path-expand.js').expandFileGlob,
      expandDirImpl: expandDirImpl as unknown as typeof import('../path-expand.js').expandDirRecursive,
    });

    const yaml = await readFile(result.artefactPath!, 'utf-8');
    // Normalise absolute temp-dir path so the snapshot stays stable.
    const normalised = yaml.replace(new RegExp(tmpDir, 'g'), '<TMP>');
    expect(normalised).toMatchInlineSnapshot(`
"version: 1
role:
  org: acme
  team: eng
  role: Developer
entries:
  - location: http://reachable.example
    scheme: http
    status: reachable
    paths: []
  - location: http://probefail.example
    scheme: http
    status: probe-failed
    paths: []
  - location: file://design/*.png
    scheme: file
    status: expanded
    paths:
      - /abs/design/a.png
  - location: dir://assets
    scheme: dir
    status: expanded
    paths:
      - /abs/assets/b.png
  - location: https://with.credentials
    scheme: https
    status: reachable
    paths: []
    credentials: .forjis/secrets/ok.env
pinAssets:
  - <TMP>/.forjis/tasks/t1/pin-01-element.png
"
`);
  });
});
