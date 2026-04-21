/**
 * Unit tests for pre-processor.ts — preprocessTask, writeClarificationFile,
 * and the internal parsePreprocessResponse logic.
 *
 * Coverage areas:
 *   - parsePreprocessResponse: valid JSON, empty ambiguities, no JSON, malformed JSON, dependencies
 *   - preprocessTask: engine.prompt invocation and error handling
 *   - writeClarificationFile: YAML output via writeYamlFile
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { jest } from '@jest/globals';

import { preprocessTask, writeClarificationFile } from '../pre-processor.js';
import type { ForjisEngine } from '../engine.js';
import type { TaskState, ClarificationFile } from '../types.js';
import { PromptOptions } from '../types.js';

// -- Helpers ----------------------------------------------------------------

/** Minimal TaskState stub with required fields. */
function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'test-task',
    status: 'pending',
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    source: 'dir',
    dependencies: [],
    description: 'A test task description',
    retryCount: 0,
    ...overrides,
  };
}

/** Creates a mock ForjisEngine whose prompt() returns the given string. */
function mockEngine(output: string): ForjisEngine {
  return {
    name: 'mock',
    checkPrerequisites: async () => 'ok',
    generateFile: async () => {},
    invoke: async () => ({ exitCode: 0, output: '', inputTokens: 0, outputTokens: 0 }),
    prompt: jest.fn(async () => output),
    cleanup: async () => {},
  } as unknown as ForjisEngine;
}

// -- parsePreprocessResponse (via preprocessTask) ---------------------------

describe('preprocessTask / parsePreprocessResponse', () => {
  it('returns populated ClarificationFile when ambiguities are present', async () => {
    const engine = mockEngine(
      'Here is my analysis:\n' +
        '{"ambiguities": [{"id": "q1", "question": "What format?"}], "dependencies": []}',
    );
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).not.toBeNull();
    expect(result.questions!.task).toBe('test-task');
    expect(result.questions!.status).toBe('awaiting_answers');
    expect(result.questions!.questions).toHaveLength(1);
    expect(result.questions!.questions[0]).toEqual({
      id: 'q1',
      question: 'What format?',
      answer: '',
    });
    expect(result.dependencies).toEqual([]);
  });

  it('returns null questions when ambiguities array is empty', async () => {
    const engine = mockEngine('{"ambiguities": [], "dependencies": []}');
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).toBeNull();
    expect(result.dependencies).toEqual([]);
  });

  it('returns null questions when output contains no JSON', async () => {
    const engine = mockEngine('The task looks fine, no issues found.');
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).toBeNull();
    expect(result.dependencies).toEqual([]);
  });

  it('returns null questions when JSON inside match is malformed', async () => {
    const engine = mockEngine('Here: {not valid json!!!}');
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).toBeNull();
    expect(result.dependencies).toEqual([]);
  });

  it('returns dependencies when populated', async () => {
    const engine = mockEngine(
      '{"ambiguities": [], "dependencies": ["dep-task-1", "dep-task-2"]}',
    );
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).toBeNull();
    expect(result.dependencies).toEqual(['dep-task-1', 'dep-task-2']);
  });

  it('returns dependencies alongside ambiguities', async () => {
    const engine = mockEngine(
      '{"ambiguities": [{"id": "q1", "question": "Scope?"}], "dependencies": ["other-task"]}',
    );
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).not.toBeNull();
    expect(result.dependencies).toEqual(['other-task']);
  });

  it('defaults dependencies to [] when key is missing', async () => {
    const engine = mockEngine('{"ambiguities": []}');
    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.dependencies).toEqual([]);
  });
});

// -- preprocessTask prompt construction -------------------------------------

describe('preprocessTask prompt construction', () => {
  it('calls engine.prompt with expected text when autoDependencies is true', async () => {
    const engine = mockEngine('{"ambiguities": [], "dependencies": []}');
    const existing = [
      makeTask({ id: 'existing-1', description: 'First existing task' }),
      makeTask({ id: 'existing-2', description: 'Second existing task' }),
    ];

    await preprocessTask(makeTask({ id: 'my-task' }), 'task content', true, existing, engine);

    expect(engine.prompt).toHaveBeenCalledTimes(1);
    const [promptArg, optionsArg] = (engine.prompt as jest.Mock).mock.calls[0];

    expect(promptArg).toContain('my-task');
    expect(promptArg).toContain('task content');
    expect(promptArg).toContain('Existing Tasks');
    expect(promptArg).toContain('existing-1');
    expect(promptArg).toContain('existing-2');
    expect(optionsArg).toBeInstanceOf(PromptOptions);
    expect(optionsArg.returnOutput).toBe(true);
  });

  it('does not include existing tasks when autoDependencies is false', async () => {
    const engine = mockEngine('{"ambiguities": [], "dependencies": []}');
    const existing = [makeTask({ id: 'existing-1', description: 'Should not appear' })];

    await preprocessTask(makeTask(), 'task content', false, existing, engine);

    const [promptArg] = (engine.prompt as jest.Mock).mock.calls[0];
    expect(promptArg).not.toContain('Existing Tasks');
    expect(promptArg).not.toContain('existing-1');
  });

  it('returns fallback when engine.prompt throws', async () => {
    const engine = mockEngine('');
    (engine.prompt as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    const result = await preprocessTask(makeTask(), 'task text', false, [], engine);

    expect(result.questions).toBeNull();
    expect(result.dependencies).toEqual([]);
  });
});

// -- writeClarificationFile -------------------------------------------------

describe('writeClarificationFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'forjis-preproc-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a YAML file with correct content', async () => {
    const clarification: ClarificationFile = {
      task: 'my-task',
      status: 'awaiting_answers',
      questions: [
        { id: 'q1', question: 'What is the scope?', answer: '' },
        { id: 'q2', question: 'Which API version?', answer: '' },
      ],
    };

    await writeClarificationFile(tmpDir, 'my-task', clarification);

    const filePath = join(tmpDir, 'my-task.questions.yaml');
    const content = await readFile(filePath, 'utf-8');

    expect(content).toContain('task: my-task');
    expect(content).toContain('status: awaiting_answers');
    expect(content).toContain('What is the scope?');
    expect(content).toContain('Which API version?');
  });
});
