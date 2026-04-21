/**
 * Unit tests for task-queue.ts — TaskQueue, extractPriority, priorityToNumeric.
 *
 * All file system operations use a temporary directory that is cleaned up after each test.
 *
 * Requirements validated:
 *   Inline task ingestion
 *   Directory task ingestion
 *   Task priority extraction
 *   Task priority ordering
 *   Task state management (transitions)
 *   Task concurrency management
 *   Task dependency ordering
 *   Clarification flow
 *   Task dependency circular detection
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskQueue, extractPriority, priorityToNumeric } from '../task-queue.js';
import { writeYamlFile } from '../state.js';
import type { TaskState, TasksConfig, ClarificationFile } from '../types.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-tq-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function makeTasksConfig(path: string, overrides?: Partial<TasksConfig>): TasksConfig {
  return {
    source: 'dir',
    path,
    pollIntervalMs: 30_000,
    autoDependencies: false,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// extractPriority
// --------------------------------------------------------------------------

describe('extractPriority', () => {
  /** Validates: Task priority extraction — priority in YAML frontmatter */
  it('extracts priority from YAML frontmatter', () => {
    const content = `---\npriority: high\n---\nDo something`;
    expect(extractPriority(content)).toBe('high');
  });

  /** Validates: Task priority extraction — priority in trailing metadata */
  it('extracts priority from trailing metadata line', () => {
    const content = `Content\npriority: critical`;
    expect(extractPriority(content)).toBe('critical');
  });

  /** Validates: Task priority extraction — defaults to medium when no priority */
  it('defaults to medium when no priority metadata', () => {
    const content = `Just plain text with no priority`;
    expect(extractPriority(content)).toBe('medium');
  });

  it('extracts numeric priority from frontmatter', () => {
    const content = `---\npriority: 85\n---\nContent`;
    expect(extractPriority(content)).toBe(85);
  });
});

// --------------------------------------------------------------------------
// priorityToNumeric
// --------------------------------------------------------------------------

describe('priorityToNumeric', () => {
  /** Validates: Task priority ordering — named priorities map correctly */
  it('maps critical to 100', () => {
    expect(priorityToNumeric('critical')).toBe(100);
  });

  it('maps high to 75', () => {
    expect(priorityToNumeric('high')).toBe(75);
  });

  it('maps medium to 50', () => {
    expect(priorityToNumeric('medium')).toBe(50);
  });

  it('maps low to 25', () => {
    expect(priorityToNumeric('low')).toBe(25);
  });

  it('passes numeric values through directly', () => {
    expect(priorityToNumeric(85)).toBe(85);
  });
});

// --------------------------------------------------------------------------
// TaskQueue.ingestInline
// --------------------------------------------------------------------------

describe('TaskQueue.ingestInline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Inline task ingestion — creates task with cli source and queued status */
  it('creates a task state with cli source and queued status', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = await queue.ingestInline('Add login page');

    expect(state.source).toBe('cli');
    expect(state.status).toBe('queued');
    expect(state.priority).toBe('medium');
    expect(state.id).toBeTruthy();
    expect(state.description).toBe('Add login page');
  });

  it('persists state.yaml in queue directory', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = await queue.ingestInline('Fix bug');

    const persisted = await queue.getState(state.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.id).toBe(state.id);
    expect(persisted?.description).toBe('Fix bug');
  });
});

// --------------------------------------------------------------------------
// TaskQueue.scanDirectory
// --------------------------------------------------------------------------

describe('TaskQueue.scanDirectory', () => {
  let tmpDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    tasksDir = join(tmpDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Directory task ingestion — finds .md and .txt files */
  it('creates tasks for .md and .txt files', async () => {
    await writeFile(join(tasksDir, 'add-auth.md'), 'Add authentication');
    await writeFile(join(tasksDir, 'fix-bug.txt'), 'Fix the bug');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('add-auth');
    expect(ids).toContain('fix-bug');
  });

  /** Validates: Directory task ingestion — finds directory with task.md */
  it('creates task for directory containing task.md', async () => {
    const taskSubDir = join(tasksDir, 'my-feature');
    await mkdir(taskSubDir, { recursive: true });
    await writeFile(join(taskSubDir, 'task.md'), 'Implement feature');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    expect(newTasks.some(t => t.id === 'my-feature')).toBe(true);
  });

  /** Validates: Directory task ingestion — ignores directories without task.md */
  it('ignores directories that have no task.md', async () => {
    const noTaskDir = join(tasksDir, 'no-task-dir');
    await mkdir(noTaskDir, { recursive: true });
    await writeFile(join(noTaskDir, 'readme.txt'), 'just a readme');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    expect(newTasks.some(t => t.id === 'no-task-dir')).toBe(false);
  });

  /** Validates: Directory task ingestion — skips already-tracked tasks */
  it('skips tasks already in the queue', async () => {
    await writeFile(join(tasksDir, 'add-auth.md'), 'Add authentication');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    // First scan — creates the task
    const first = await queue.scanDirectory();
    expect(first).toHaveLength(1);

    // Second scan — should skip because already tracked
    const second = await queue.scanDirectory();
    expect(second).toHaveLength(0);
  });

  /** Validates: Directory task ingestion — skips underscore-prefixed entries */
  it('skips entries whose name starts with an underscore', async () => {
    await writeFile(join(tasksDir, '_disabled-task.md'), 'Should be ignored');
    await writeFile(join(tasksDir, 'active-task.md'), 'Should be found');

    const underscoreSubDir = join(tasksDir, '_hidden-feature');
    await mkdir(underscoreSubDir, { recursive: true });
    await writeFile(join(underscoreSubDir, 'task.md'), 'Also ignored');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('active-task');
    expect(ids).not.toContain('_disabled-task');
    expect(ids).not.toContain('_hidden-feature');
  });

  it('scanned tasks have source dir', async () => {
    await writeFile(join(tasksDir, 'task1.md'), 'Content');
    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const tasks = await queue.scanDirectory();
    expect(tasks[0].source).toBe('dir');
  });

  /** Validates: skip underscore — entry named exactly "_" is skipped */
  it('skips an entry named exactly "_"', async () => {
    await writeFile(join(tasksDir, '_'), 'Bare underscore file');
    await writeFile(join(tasksDir, 'real-task.md'), 'Real task');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('real-task');
    expect(ids).not.toContain('_');
  });

  /** Validates: skip underscore — underscore in middle of name does NOT skip */
  it('does not skip entries with underscore in the middle of the name', async () => {
    await writeFile(join(tasksDir, 'my_task.md'), 'Middle underscore task');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('my_task');
  });

  /** Validates: Flow 3 — .yaml and .yml files still scanned when no underscore prefix */
  it('creates tasks for .yaml and .yml files', async () => {
    await writeFile(join(tasksDir, 'configure-db.yaml'), 'Configure database');
    await writeFile(join(tasksDir, 'setup-ci.yml'), 'Setup CI pipeline');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('configure-db');
    expect(ids).toContain('setup-ci');
  });

  /** Validates: Flow 4 — .questions.yaml still ignored (existing skip logic unchanged) */
  it('still ignores .questions.yaml files after underscore skip is added', async () => {
    await writeFile(join(tasksDir, 'some-task.questions.yaml'), 'questions content');
    await writeFile(join(tasksDir, 'normal-task.md'), 'Normal content');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('normal-task');
    // .questions.yaml should not produce any task (processEntry returns null for it)
    expect(ids.some(id => id.includes('questions'))).toBe(false);
  });

  /** Validates: Flow 4 — directory without task.md still ignored after underscore skip */
  it('still ignores directories without task.md after underscore skip is added', async () => {
    const emptyDir = join(tasksDir, 'no-task-here');
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(emptyDir, 'README.md'), 'Not a task.md');
    await writeFile(join(tasksDir, 'valid-task.md'), 'Valid task');

    const queue = new TaskQueue(tmpDir, makeTasksConfig('./tasks'));
    const newTasks = await queue.scanDirectory();

    const ids = newTasks.map(t => t.id);
    expect(ids).toContain('valid-task');
    expect(ids).not.toContain('no-task-here');
  });
});

// --------------------------------------------------------------------------
// TaskQueue.getOrdered
// --------------------------------------------------------------------------

describe('TaskQueue.getOrdered', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Task priority ordering — sorted by priority desc then created asc */
  it('sorts tasks by priority descending then created time ascending', async () => {
    const queue = new TaskQueue(tmpDir, null);

    // Create tasks with different priorities
    const tasksDir = join(tmpDir, '.forjis', 'tasks');

    const t1: TaskState = {
      id: 'task-low', status: 'queued', priority: 'low',
      created: '2024-01-01T00:00:00.000Z', source: 'cli', dependencies: [],
      description: 'low', retryCount: 0,
    };
    const t2: TaskState = {
      id: 'task-high', status: 'queued', priority: 'high',
      created: '2024-01-01T00:01:00.000Z', source: 'cli', dependencies: [],
      description: 'high', retryCount: 0,
    };
    const t3: TaskState = {
      id: 'task-critical', status: 'queued', priority: 'critical',
      created: '2024-01-01T00:02:00.000Z', source: 'cli', dependencies: [],
      description: 'critical', retryCount: 0,
    };

    for (const task of [t1, t2, t3]) {
      await mkdir(join(tasksDir, task.id), { recursive: true });
      await writeYamlFile(join(tasksDir, task.id, 'state.yaml'), task);
    }

    const ordered = await queue.getOrdered();
    expect(ordered[0].id).toBe('task-critical');
    expect(ordered[1].id).toBe('task-high');
    expect(ordered[2].id).toBe('task-low');
  });

  it('orders by created asc within the same priority', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasksDir = join(tmpDir, '.forjis', 'tasks');

    const tA: TaskState = {
      id: 'task-a', status: 'queued', priority: 'high',
      created: '2024-01-01T00:00:00.000Z', source: 'cli', dependencies: [],
      description: 'A', retryCount: 0,
    };
    const tB: TaskState = {
      id: 'task-b', status: 'queued', priority: 'high',
      created: '2024-01-01T00:01:00.000Z', source: 'cli', dependencies: [],
      description: 'B', retryCount: 0,
    };

    for (const task of [tB, tA]) {
      await mkdir(join(tasksDir, task.id), { recursive: true });
      await writeYamlFile(join(tasksDir, task.id, 'state.yaml'), task);
    }

    const ordered = await queue.getOrdered();
    expect(ordered[0].id).toBe('task-a');
    expect(ordered[1].id).toBe('task-b');
  });
});

// --------------------------------------------------------------------------
// TaskQueue.nextDispatchable
// --------------------------------------------------------------------------

describe('TaskQueue.nextDispatchable', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Task concurrency management — returns null at concurrency cap */
  it('returns null when running count equals max concurrent', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasksDir = join(tmpDir, '.forjis', 'tasks');

    const task: TaskState = {
      id: 'task-1', status: 'queued', priority: 'medium',
      created: new Date().toISOString(), source: 'cli', dependencies: [],
      description: 'test', retryCount: 0,
    };
    await mkdir(join(tasksDir, task.id), { recursive: true });
    await writeYamlFile(join(tasksDir, task.id, 'state.yaml'), task);

    // Running at max capacity: 3 running, max 3
    const result = await queue.nextDispatchable(3, 3);
    expect(result).toBeNull();
  });

  /** Validates: Task dependency ordering — waits for dependencies */
  it('returns null when only queued task has unmet dependencies', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasksDir = join(tmpDir, '.forjis', 'tasks');

    const taskA: TaskState = {
      id: 'task-a', status: 'running', priority: 'medium',
      created: '2024-01-01T00:00:00.000Z', source: 'cli', dependencies: [],
      description: 'A', retryCount: 0,
    };
    const taskB: TaskState = {
      id: 'task-b', status: 'queued', priority: 'medium',
      created: '2024-01-01T00:01:00.000Z', source: 'cli', dependencies: ['task-a'],
      description: 'B', retryCount: 0,
    };

    for (const t of [taskA, taskB]) {
      await mkdir(join(tasksDir, t.id), { recursive: true });
      await writeYamlFile(join(tasksDir, t.id, 'state.yaml'), t);
    }

    const result = await queue.nextDispatchable(0, 5);
    expect(result).toBeNull();
  });

  it('returns a task when dependencies are done', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasksDir = join(tmpDir, '.forjis', 'tasks');

    const taskA: TaskState = {
      id: 'task-a', status: 'done', priority: 'medium',
      created: '2024-01-01T00:00:00.000Z', source: 'cli', dependencies: [],
      description: 'A', retryCount: 0,
    };
    const taskB: TaskState = {
      id: 'task-b', status: 'queued', priority: 'medium',
      created: '2024-01-01T00:01:00.000Z', source: 'cli', dependencies: ['task-a'],
      description: 'B', retryCount: 0,
    };

    for (const t of [taskA, taskB]) {
      await mkdir(join(tasksDir, t.id), { recursive: true });
      await writeYamlFile(join(tasksDir, t.id, 'state.yaml'), t);
    }

    const result = await queue.nextDispatchable(0, 5);
    expect(result?.id).toBe('task-b');
  });
});

// --------------------------------------------------------------------------
// TaskQueue.transition
// --------------------------------------------------------------------------

describe('TaskQueue.transition', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Task state management — transition updates status and timestamps */
  it('sets status to running and records started timestamp', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = await queue.ingestInline('Test task');

    await queue.transition(state.id, 'running');

    const updated = await queue.getState(state.id);
    expect(updated?.status).toBe('running');
    expect(updated?.started).toBeTruthy();
  });

  it('sets completed timestamp when transitioning to done', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const state = await queue.ingestInline('Test task');

    await queue.transition(state.id, 'running');
    await queue.transition(state.id, 'done');

    const updated = await queue.getState(state.id);
    expect(updated?.status).toBe('done');
    expect(updated?.completed).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// TaskQueue.checkClarifications
// --------------------------------------------------------------------------

describe('TaskQueue.checkClarifications', () => {
  let tmpDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    tasksDir = join(tmpDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Clarification flow — re-queues when all answers are filled */
  it('transitions task to queued when all clarification answers are filled', async () => {
    const queue = new TaskQueue(tmpDir, null);
    // Manually create task in needs_clarification state
    const tasksDir = join(tmpDir, '.forjis', 'tasks', 'add-auth');
    await mkdir(tasksDir, { recursive: true });
    const taskState: TaskState = {
      id: 'add-auth', status: 'needs_clarification', priority: 'medium',
      created: new Date().toISOString(), source: 'dir', dependencies: [],
      description: 'Add auth', retryCount: 0,
    };
    await writeYamlFile(join(tasksDir, 'state.yaml'), taskState);

    // Write questions file with all answers filled
    const clarification: ClarificationFile = {
      task: 'add-auth',
      status: 'awaiting_answers',
      questions: [
        { id: 'q1', question: 'Which auth method?', answer: 'OAuth2' },
      ],
    };
    await writeYamlFile(join(tasksDir, 'add-auth.questions.yaml'), clarification);

    await queue.checkClarifications(tasksDir);

    const updated = await queue.getState('add-auth');
    expect(updated?.status).toBe('queued');
  });

  it('does not re-queue when not all answers are filled', async () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasksDir = join(tmpDir, '.forjis', 'tasks', 'fix-bug');
    await mkdir(tasksDir, { recursive: true });
    const taskState: TaskState = {
      id: 'fix-bug', status: 'needs_clarification', priority: 'medium',
      created: new Date().toISOString(), source: 'dir', dependencies: [],
      description: 'Fix bug', retryCount: 0,
    };
    await writeYamlFile(join(tasksDir, 'state.yaml'), taskState);

    const clarification: ClarificationFile = {
      task: 'fix-bug',
      status: 'awaiting_answers',
      questions: [
        { id: 'q1', question: 'Which component?', answer: '' }, // unanswered
      ],
    };
    await writeYamlFile(join(tasksDir, 'fix-bug.questions.yaml'), clarification);

    await queue.checkClarifications(tasksDir);

    const updated = await queue.getState('fix-bug');
    expect(updated?.status).toBe('needs_clarification');
  });
});

// --------------------------------------------------------------------------
// TaskQueue.detectCircularDeps
// --------------------------------------------------------------------------

describe('TaskQueue.detectCircularDeps', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  /** Validates: Task dependency ordering — circular dependency detection */
  it('detects A->B->A circular dependency', () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasks: TaskState[] = [
      {
        id: 'task-a', status: 'queued', priority: 'medium',
        created: new Date().toISOString(), source: 'cli', dependencies: ['task-b'],
        description: 'A', retryCount: 0,
      },
      {
        id: 'task-b', status: 'queued', priority: 'medium',
        created: new Date().toISOString(), source: 'cli', dependencies: ['task-a'],
        description: 'B', retryCount: 0,
      },
    ];

    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('returns empty array when no circular dependencies', () => {
    const queue = new TaskQueue(tmpDir, null);
    const tasks: TaskState[] = [
      {
        id: 'task-a', status: 'queued', priority: 'medium',
        created: new Date().toISOString(), source: 'cli', dependencies: [],
        description: 'A', retryCount: 0,
      },
      {
        id: 'task-b', status: 'queued', priority: 'medium',
        created: new Date().toISOString(), source: 'cli', dependencies: ['task-a'],
        description: 'B', retryCount: 0,
      },
    ];

    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles).toHaveLength(0);
  });
});
