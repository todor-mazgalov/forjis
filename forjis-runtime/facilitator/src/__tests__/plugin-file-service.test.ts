/**
 * Traversal-focused tests for PluginFileServiceImpl.
 *
 * Verifies the three layers of path protection:
 *   1. Raw query rejection (`..`, absolute paths) — 400
 *   2. Candidate prefix check against each whitelisted plugin root
 *   3. Post-realpath prefix check to block symlink escape — 400
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';

import { PluginFileServiceImpl } from '../web-services/plugin-file-service.js';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe('PluginFileServiceImpl — successful reads', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    rootA = await createTempDir('forjis-plugin-a-');
    rootB = await createTempDir('forjis-plugin-b-');
    await mkdir(join(rootA, 'agents'), { recursive: true });
    await writeFile(join(rootA, 'agents', 'forjis-explorer.md'), '# Explorer');
    await writeFile(join(rootB, 'README.md'), '# B README');
  });

  afterEach(async () => {
    await removeTempDir(rootA);
    await removeTempDir(rootB);
  });

  it('returns content from the first whitelisted root that owns the file', async () => {
    const svc = new PluginFileServiceImpl([rootA, rootB]);
    const result = await svc.getPluginFile('agents/forjis-explorer.md');
    expect(result).toEqual({ kind: 'ok', content: '# Explorer' });
  });

  it('returns content from a later root when earlier roots do not own the file', async () => {
    const svc = new PluginFileServiceImpl([rootA, rootB]);
    const result = await svc.getPluginFile('README.md');
    expect(result).toEqual({ kind: 'ok', content: '# B README' });
  });

  it('returns notFound when no whitelisted root owns the file', async () => {
    const svc = new PluginFileServiceImpl([rootA, rootB]);
    const result = await svc.getPluginFile('missing.md');
    expect(result).toEqual({ kind: 'notFound' });
  });

  it('returns notFound when the whitelist is empty', async () => {
    const svc = new PluginFileServiceImpl([]);
    const result = await svc.getPluginFile('anything.md');
    expect(result).toEqual({ kind: 'notFound' });
  });
});

describe('PluginFileServiceImpl — traversal rejection', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempDir('forjis-plugin-traversal-');
    await writeFile(join(root, 'present.md'), '# present');
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it('rejects raw `..` in the requested path', async () => {
    const svc = new PluginFileServiceImpl([root]);
    const result = await svc.getPluginFile('../../../etc/passwd');
    expect(result).toEqual({ kind: 'traversal' });
  });

  it('rejects a path whose middle segment is `..`', async () => {
    const svc = new PluginFileServiceImpl([root]);
    const result = await svc.getPluginFile('agents/../../etc/passwd');
    expect(result).toEqual({ kind: 'traversal' });
  });

  it('rejects POSIX absolute paths', async () => {
    const svc = new PluginFileServiceImpl([root]);
    const result = await svc.getPluginFile('/etc/passwd');
    expect(result).toEqual({ kind: 'traversal' });
  });

  it('rejects absolute paths that resolve inside a whitelisted root', async () => {
    const svc = new PluginFileServiceImpl([root]);
    const result = await svc.getPluginFile(join(root, 'present.md'));
    expect(result).toEqual({ kind: 'traversal' });
  });

  it('rejects an empty path', async () => {
    const svc = new PluginFileServiceImpl([root]);
    const result = await svc.getPluginFile('');
    expect(result).toEqual({ kind: 'traversal' });
  });
});

// Symlink creation requires filesystem support for it. Skip on hosts that
// cannot create symlinks (e.g. Windows without developer mode) rather than
// failing the entire suite.
const SYMLINK_AVAILABLE = (async () => {
  const probeBase = await createTempDir('forjis-plugin-symlink-probe-');
  try {
    await writeFile(join(probeBase, 'target.txt'), 'ok');
    await symlink(join(probeBase, 'target.txt'), join(probeBase, 'probe-link'));
    return true;
  } catch {
    return false;
  } finally {
    await removeTempDir(probeBase);
  }
})();

describe('PluginFileServiceImpl — symlink escape', () => {
  let root: string;
  let outside: string;
  let canRun: boolean;

  beforeAll(async () => {
    canRun = await SYMLINK_AVAILABLE;
  });

  beforeEach(async () => {
    root = await createTempDir('forjis-plugin-root-');
    outside = await createTempDir('forjis-plugin-outside-');
    await writeFile(join(outside, 'secret.md'), 'leaked');
  });

  afterEach(async () => {
    await removeTempDir(root);
    await removeTempDir(outside);
  });

  it('rejects a symlink inside the root that points outside the whitelist', async () => {
    if (!canRun) {
      return;
    }
    await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));
    const svc = new PluginFileServiceImpl([root]);
    const result = await svc.getPluginFile('escape.md');
    expect(result).toEqual({ kind: 'traversal' });
  });
});
