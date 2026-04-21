/**
 * Unit tests for the bug-bash changes.
 *
 * Tests cover:
 * - BUG-3: TokenTracker per-task/per-role tracking
 * - BUG-3: TokenUsageServiceImpl perTask field in response (FR-004)
 * - BUG-6: ManifestServiceImpl.getManifest()
 * - BUG-6: FileServiceImpl.getFileByProjectPath() traversal protection
 *
 * NOTE: The BUG-2 `toEventFileSlug` sanitisation tests were removed in the
 * `fix-roles-display` change — the helper itself was deleted and replaced
 * with `canonicalSlug` from `@forjis/shared`. Slug behaviour is covered by
 * `shared/src/__tests__/role-identity.test.ts`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';

import { TokenTracker } from '../token-tracker.js';
import { TokenUsageServiceImpl } from '../web-services/token-usage-service.js';
import { ManifestServiceImpl } from '../web-services/manifest-service.js';
import { FileServiceImpl } from '../web-services/file-service.js';

// -- Helpers ----------------------------------------------------------------

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-bug-bash-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ==========================================================================
// BUG-3: TokenTracker per-task/per-role tracking
// ==========================================================================

describe('TokenTracker per-task/per-role (BUG-3)', () => {
  it('records per-task usage alongside global totals', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50, 'task-1');
    tracker.recordUsage(200, 100, 'task-2');

    expect(tracker.getTotalTokens()).toBe(450);

    const perTask = tracker.getPerTaskUsage();
    expect(perTask['task-1']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      perRole: undefined,
    });
    expect(perTask['task-2']).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      perRole: undefined,
    });
  });

  it('records per-role usage within a task', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50, 'task-1', undefined, {
      'forjis-explorer': { inputTokens: 40, outputTokens: 20 },
      'forjis-developer': { inputTokens: 60, outputTokens: 30 },
    });

    const perTask = tracker.getPerTaskUsage();
    expect(perTask['task-1'].perRole).toEqual({
      'forjis-explorer': { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      'forjis-developer': { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
    });
  });

  it('accumulates per-role usage across multiple calls', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50, 'task-1', 'explorer');
    tracker.recordUsage(200, 100, 'task-1', 'explorer');

    const perTask = tracker.getPerTaskUsage();
    expect(perTask['task-1'].perRole).toEqual({
      explorer: { inputTokens: 300, outputTokens: 150, totalTokens: 450 },
    });
  });

  it('returns empty object when no per-task data exists', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50);

    const perTask = tracker.getPerTaskUsage();
    expect(perTask).toEqual({});
  });

  it('reset clears per-task data', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50, 'task-1');
    tracker.reset();

    expect(tracker.getPerTaskUsage()).toEqual({});
    expect(tracker.getTotalTokens()).toBe(0);
  });
});

// ==========================================================================
// BUG-6: ManifestServiceImpl
// ==========================================================================

describe('ManifestServiceImpl (BUG-6)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it('returns empty files array when manifest does not exist', async () => {
    const service = new ManifestServiceImpl(tempDir);
    const result = await service.getManifest('nonexistent-task');
    expect(result).toEqual({ files: [] });
  });

  it('parses valid manifest YAML', async () => {
    const taskDir = join(tempDir, '.forjis', 'tasks', 'task-1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, 'output-files.yaml'),
      `files:
  - role: Explorer
    path: openspec/changes/task-1/exploration.md
    label: exploration.md
    createdAt: "2026-03-26T10:30:00Z"
  - role: Architect
    path: openspec/changes/task-1/design.md
    label: design.md
`,
    );

    const service = new ManifestServiceImpl(tempDir);
    const result = await service.getManifest('task-1');

    expect(result.files).toHaveLength(2);
    expect(result.files[0].role).toBe('Explorer');
    expect(result.files[0].path).toBe('openspec/changes/task-1/exploration.md');
    expect(result.files[1].role).toBe('Architect');
  });

  it('returns empty files array for malformed manifest', async () => {
    const taskDir = join(tempDir, '.forjis', 'tasks', 'task-2');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'output-files.yaml'), 'not-valid-manifest: true\n');

    const service = new ManifestServiceImpl(tempDir);
    const result = await service.getManifest('task-2');
    expect(result).toEqual({ files: [] });
  });
});

// ==========================================================================
// BUG-6: FileServiceImpl.getFileByProjectPath() traversal protection
// ==========================================================================

describe('FileServiceImpl.getFileByProjectPath (BUG-6)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await mkdir(join(tempDir, 'openspec', 'changes', 'task-1'), { recursive: true });
    await writeFile(join(tempDir, 'openspec', 'changes', 'task-1', 'design.md'), '# Design');
    await writeFile(join(tempDir, 'readme.txt'), 'project root file');
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it('reads a file by project-relative path', async () => {
    const service = new FileServiceImpl(tempDir);
    const result = await service.getFileByProjectPath('openspec/changes/task-1/design.md');
    expect(result).toEqual({ content: '# Design' });
  });

  it('reads a file at project root', async () => {
    const service = new FileServiceImpl(tempDir);
    const result = await service.getFileByProjectPath('readme.txt');
    expect(result).toEqual({ content: 'project root file' });
  });

  it('blocks path traversal with ../', async () => {
    const service = new FileServiceImpl(tempDir);
    const result = await service.getFileByProjectPath('../../../etc/passwd');
    expect(result).toBeNull();
  });

  it('blocks absolute path traversal', async () => {
    const service = new FileServiceImpl(tempDir);
    const result = await service.getFileByProjectPath('/etc/passwd');
    expect(result).toBeNull();
  });

  it('returns null for non-existent files', async () => {
    const service = new FileServiceImpl(tempDir);
    const result = await service.getFileByProjectPath('does-not-exist.md');
    expect(result).toBeNull();
  });
});

// ==========================================================================
// BUG-3: TokenUsageServiceImpl perTask field (FR-004)
// ==========================================================================

describe('TokenUsageServiceImpl perTask field (BUG-3 FR-004)', () => {
  it('omits perTask field when no per-task data has been recorded', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50); // no taskId
    const service = new TokenUsageServiceImpl(tracker, null);

    const response = service.getTokenUsage();
    expect(response.perTask).toBeUndefined();
  });

  it('includes perTask field when per-task data is present', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50, 'task-abc');
    const service = new TokenUsageServiceImpl(tracker, null);

    const response = service.getTokenUsage();
    expect(response.perTask).toBeDefined();
    expect(response.perTask!['task-abc']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      perRole: undefined,
    });
  });

  it('includes per-role breakdown inside perTask when roles are recorded', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(120, 60, 'task-xyz', undefined, {
      explorer: { inputTokens: 50, outputTokens: 25 },
      architect: { inputTokens: 70, outputTokens: 35 },
    });
    const service = new TokenUsageServiceImpl(tracker, null);

    const response = service.getTokenUsage();
    const taskEntry = response.perTask!['task-xyz'];
    expect(taskEntry).toBeDefined();
    expect(taskEntry.inputTokens).toBe(120);
    expect(taskEntry.outputTokens).toBe(60);
    expect(taskEntry.totalTokens).toBe(180);
    expect(taskEntry.perRole!['explorer']).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
    });
    expect(taskEntry.perRole!['architect']).toEqual({
      inputTokens: 70,
      outputTokens: 35,
      totalTokens: 105,
    });
  });

  it('includes budget when budget config is provided', () => {
    const tracker = new TokenTracker();
    const budget = { maxTokens: 100000, resetWindowMs: 3600000 };
    const service = new TokenUsageServiceImpl(tracker, budget);

    const response = service.getTokenUsage();
    expect(response.budget).toEqual({ maxTokens: 100000, resetWindowMs: 3600000 });
  });

  it('returns null budget when no budget config is set', () => {
    const tracker = new TokenTracker();
    const service = new TokenUsageServiceImpl(tracker, null);

    const response = service.getTokenUsage();
    expect(response.budget).toBeNull();
  });

  it('global totals match sum of per-task entries', () => {
    const tracker = new TokenTracker();
    tracker.recordUsage(100, 50, 'task-1');
    tracker.recordUsage(200, 100, 'task-2');
    const service = new TokenUsageServiceImpl(tracker, null);

    const response = service.getTokenUsage();
    expect(response.totalTokens).toBe(450);
    expect(response.inputTokens).toBe(300);
    expect(response.outputTokens).toBe(150);

    const perTaskTotal =
      Object.values(response.perTask!).reduce((sum, t) => sum + t.totalTokens, 0);
    expect(perTaskTotal).toBe(450);
  });
});

// ==========================================================================
// BUG-6: ManifestServiceImpl — additional coverage
// ==========================================================================

describe('ManifestServiceImpl additional cases (BUG-6)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it('preserves createdAt and label fields in parsed entries', async () => {
    const taskDir = join(tempDir, '.forjis', 'tasks', 'task-3');
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, 'output-files.yaml'),
      `files:
  - role: Developer
    path: openspec/changes/task-3/code.ts
    label: code.ts
    createdAt: "2026-03-26T12:00:00Z"
`,
    );

    const service = new ManifestServiceImpl(tempDir);
    const result = await service.getManifest('task-3');

    expect(result.files).toHaveLength(1);
    expect(result.files[0].label).toBe('code.ts');
    expect(result.files[0].createdAt).toBe('2026-03-26T12:00:00Z');
  });

  it('returns empty files array when YAML has empty files list', async () => {
    const taskDir = join(tempDir, '.forjis', 'tasks', 'task-4');
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'output-files.yaml'), 'files: []\n');

    const service = new ManifestServiceImpl(tempDir);
    const result = await service.getManifest('task-4');
    expect(result).toEqual({ files: [] });
  });
});
