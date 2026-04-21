/**
 * Reviewer supplementary tests for the task-create command.
 *
 * These tests cover gaps not addressed by the Developer test file,
 * specifically the interactive happy path (FR-004 Q&A with readline),
 * discussion non-persistence (FR-011), success output path (FR-013),
 * and interactive-mode error handling (NFR-002).
 *
 * Requirements covered:
 *   FR-004 Interactive Q&A loop (happy path)
 *   FR-006 Task file output location (default tasks path)
 *   FR-008 Agent restricted tool access (interactive mode)
 *   FR-010 Agent works from description only (interactive prompt)
 *   FR-011 Discussion history is not persisted
 *   FR-012 Command exported from facilitator barrel
 *   FR-013 Successful completion output (path in message)
 *   NFR-002 Error handling (interactive final generation, null response)
 */

import { jest } from '@jest/globals';
import type { PromptOptions } from '../../types.js';

// ---------------------------------------------------------------------------
// Mocks - all external dependencies are mocked before importing the module
// ---------------------------------------------------------------------------

// Track all fs writes
const writtenFiles: Array<{ path: string; content: string }> = [];
const createdDirs: string[] = [];

const mockMkdir = jest.fn<(path: string, opts?: { recursive?: boolean }) => Promise<void>>(
  async (path) => { createdDirs.push(path); }
);
const mockWriteFile = jest.fn<(path: string, content: string, enc: string) => Promise<void>>(
  async (path, content) => { writtenFiles.push({ path, content }); }
);
jest.unstable_mockModule('node:fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

// Mock readline - track questions asked and simulate answers
const askedQuestions: string[] = [];
let answerQueue: string[] = [];
const mockClose = jest.fn();
const mockRlQuestion = jest.fn<(q: string, cb: (a: string) => void) => void>(
  (q, cb) => {
    askedQuestions.push(q);
    const answer = answerQueue.shift() ?? '';
    cb(answer);
  }
);
jest.unstable_mockModule('node:readline', () => ({
  createInterface: jest.fn(() => ({
    question: mockRlQuestion,
    close: mockClose,
  })),
}));

// Mock build-file
const defaultConfig = {
  version: 1,
  engine: 'claude',
  tasks: { path: './tasks', pollIntervalMs: 1000, autoDependencies: false },
  repositories: [],
  plugins: [],
  orgs: [],
  outcome: null,
  tokenBudget: null,
  constraints: null,
  personas: null,
};
jest.unstable_mockModule('@forjis/resolver', () => ({
  loadBuildFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
  parseBuildFile: jest.fn().mockReturnValue({ ...defaultConfig }),
}));

// Mock engine
const promptCalls: Array<{ text: string; options: PromptOptions }> = [];
let promptResponses: string[] = [];
let promptCallIndex = 0;

const mockEngine = {
  name: 'test-engine',
  checkPrerequisites: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
  prompt: jest.fn<(text: string, options: PromptOptions) => Promise<string>>(
    async (text, options) => {
      promptCalls.push({ text, options });
      const resp = promptResponses[promptCallIndex] ?? '';
      promptCallIndex++;
      return resp;
    }
  ),
};
jest.unstable_mockModule('../../engine.js', () => ({
  loadEngine: jest.fn().mockResolvedValue(mockEngine),
}));

// Import module under test after all mocks
const { taskCreateCommand } = await import('../task-create.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CWD = '/reviewer/test';
const BUILD_FILE = '/reviewer/test/build.forjis';
const TASK_MD = '# Notification System\n\nBuild push notification support.\n\n## Requirements\n- Real-time delivery\n- Multi-channel support';

function resetState(): void {
  jest.clearAllMocks();
  writtenFiles.length = 0;
  createdDirs.length = 0;
  askedQuestions.length = 0;
  answerQueue = [];
  promptCalls.length = 0;
  promptResponses = [];
  promptCallIndex = 0;
}

// ---------------------------------------------------------------------------
// FR-004: Interactive Q&A loop - happy path
// ---------------------------------------------------------------------------

describe('FR-004: Interactive Q&A loop - happy path', () => {
  beforeEach(resetState);

  it('presents each question from engine to user one at a time', async () => {
    const questions = [
      'What notification channels are needed?',
      'Should notifications persist after delivery?',
      'What is the expected delivery latency?',
    ];
    promptResponses = [
      JSON.stringify({ questions }),
      TASK_MD,
    ];
    answerQueue = ['Email and SMS', 'Yes, store in DB', 'Under 5 seconds'];

    await taskCreateCommand(CWD, BUILD_FILE, 'build notifications', true);

    // Exactly 3 readline questions
    expect(mockRlQuestion).toHaveBeenCalledTimes(3);
    // Each question text should appear in the readline prompt
    for (const q of questions) {
      const found = askedQuestions.some((asked) => asked.includes(q));
      expect(found).toBe(true);
    }
  });

  it('passes all Q&A context to the final generation prompt', async () => {
    const questions = ['Which database?', 'Auth required?'];
    promptResponses = [
      JSON.stringify({ questions }),
      TASK_MD,
    ];
    answerQueue = ['PostgreSQL', 'Yes, JWT tokens'];

    await taskCreateCommand(CWD, BUILD_FILE, 'add data layer', true);

    // Two engine calls: question generation + final generation
    expect(promptCalls).toHaveLength(2);

    const finalPrompt = promptCalls[1].text;
    // Original description preserved
    expect(finalPrompt).toContain('add data layer');
    // Q&A pairs included
    expect(finalPrompt).toContain('Which database?');
    expect(finalPrompt).toContain('PostgreSQL');
    expect(finalPrompt).toContain('Auth required?');
    expect(finalPrompt).toContain('JWT tokens');
  });

  it('closes readline interface after all questions answered', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['One question?'] }),
      TASK_MD,
    ];
    answerQueue = ['One answer'];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', true);

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('makes exactly two engine calls in interactive mode', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      TASK_MD,
    ];
    answerQueue = ['A'];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', true);

    expect(promptCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FR-008: Restricted tool access in interactive mode
// ---------------------------------------------------------------------------

describe('FR-008: Restricted tool access in interactive mode', () => {
  beforeEach(resetState);

  it('uses maxTurns=1 and no tools for question-generation call', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      TASK_MD,
    ];
    answerQueue = ['A'];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', true);

    const questionCallOptions = promptCalls[0].options;
    expect(questionCallOptions.allowedTools).toEqual([]);
    expect(questionCallOptions.maxTurns).toBe(1);
    expect(questionCallOptions.returnOutput).toBe(true);
  });

  it('restricts allowedTools to Write for final generation call', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      TASK_MD,
    ];
    answerQueue = ['A'];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', true);

    const finalCallOptions = promptCalls[1].options;
    expect(finalCallOptions.allowedTools).toEqual(['Write']);
    expect(finalCallOptions.allowedTools).not.toContain('Read');
    expect(finalCallOptions.allowedTools).not.toContain('Grep');
    expect(finalCallOptions.allowedTools).not.toContain('Glob');
  });
});

// ---------------------------------------------------------------------------
// FR-010: No-analysis instruction in interactive final prompt
// ---------------------------------------------------------------------------

describe('FR-010: No-analysis in interactive generation prompt', () => {
  beforeEach(resetState);

  it('final interactive prompt prohibits project analysis', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      TASK_MD,
    ];
    answerQueue = ['A'];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', true);

    const finalPrompt = promptCalls[1].text;
    expect(finalPrompt.toLowerCase()).toMatch(/do not.*analyz/);
  });

  it('final interactive prompt prohibits Read, Grep, Glob tools', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      TASK_MD,
    ];
    answerQueue = ['A'];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', true);

    const finalPrompt = promptCalls[1].text;
    expect(finalPrompt).toContain('Read');
    expect(finalPrompt).toContain('Grep');
    expect(finalPrompt).toContain('Glob');
  });
});

// ---------------------------------------------------------------------------
// FR-011: Discussion history is not persisted
// ---------------------------------------------------------------------------

describe('FR-011: Discussion history not persisted to disk', () => {
  beforeEach(resetState);

  it('writes exactly one file (the task) during interactive mode', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q1?', 'Q2?', 'Q3?'] }),
      TASK_MD,
    ];
    answerQueue = ['A1', 'A2', 'A3'];

    await taskCreateCommand(CWD, BUILD_FILE, 'notifications', true);

    expect(writtenFiles).toHaveLength(1);
    // The single written file should be the task markdown, not a Q&A transcript
    expect(writtenFiles[0].content).toBe(TASK_MD);
  });
});

// ---------------------------------------------------------------------------
// FR-012: Command exported from facilitator barrel
// ---------------------------------------------------------------------------

describe('FR-012: taskCreateCommand is a callable function', () => {
  it('is exported and is a function', () => {
    expect(typeof taskCreateCommand).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// FR-013: Success message includes file path
// ---------------------------------------------------------------------------

describe('FR-013: Success message includes file path', () => {
  beforeEach(resetState);

  it('prints message containing the written file path', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    promptResponses = [TASK_MD];

    await taskCreateCommand(CWD, BUILD_FILE, 'notifications', false);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0][0] as string;
    // Should contain the filename slug
    expect(message).toContain('_notification-system.md');
    logSpy.mockRestore();
  });

  it('prints message containing "Task created" prefix', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    promptResponses = [TASK_MD];

    await taskCreateCommand(CWD, BUILD_FILE, 'notifications', false);

    const message = logSpy.mock.calls[0][0] as string;
    expect(message).toMatch(/task created/i);
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// FR-006: Tasks directory defaults
// ---------------------------------------------------------------------------

describe('FR-006: Tasks directory creation', () => {
  beforeEach(resetState);

  it('creates tasks directory before writing', async () => {
    promptResponses = [TASK_MD];

    await taskCreateCommand(CWD, BUILD_FILE, 'a task', false);

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('tasks'),
      { recursive: true }
    );
    // mkdir should be called before writeFile
    expect(mockMkdir.mock.invocationCallOrder[0])
      .toBeLessThan(mockWriteFile.mock.invocationCallOrder[0]);
  });
});

// ---------------------------------------------------------------------------
// NFR-002: Error handling in interactive mode
// ---------------------------------------------------------------------------

describe('NFR-002: Error handling in interactive mode', () => {
  beforeEach(resetState);

  it('throws when final interactive generation returns empty', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      '',
    ];
    answerQueue = ['A'];

    await expect(
      taskCreateCommand(CWD, BUILD_FILE, 'a task', true)
    ).rejects.toThrow(/empty/i);

    expect(writtenFiles).toHaveLength(0);
  });

  it('throws when final interactive generation returns whitespace', async () => {
    promptResponses = [
      JSON.stringify({ questions: ['Q?'] }),
      '   \n\t  ',
    ];
    answerQueue = ['A'];

    await expect(
      taskCreateCommand(CWD, BUILD_FILE, 'a task', true)
    ).rejects.toThrow(/empty/i);

    expect(writtenFiles).toHaveLength(0);
  });

  it('does not write file when engine throws during non-interactive', async () => {
    mockEngine.prompt.mockRejectedValueOnce(new Error('Connection timeout'));

    await expect(
      taskCreateCommand(CWD, BUILD_FILE, 'a task', false)
    ).rejects.toThrow('Connection timeout');

    expect(writtenFiles).toHaveLength(0);
  });

  it('does not write file when engine throws during interactive final call', async () => {
    mockEngine.prompt
      .mockResolvedValueOnce(JSON.stringify({ questions: ['Q?'] }))
      .mockRejectedValueOnce(new Error('Engine overloaded'));

    answerQueue = ['A'];

    await expect(
      taskCreateCommand(CWD, BUILD_FILE, 'a task', true)
    ).rejects.toThrow('Engine overloaded');

    expect(writtenFiles).toHaveLength(0);
  });
});
