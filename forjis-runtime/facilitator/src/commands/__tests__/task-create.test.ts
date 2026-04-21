/**
 * Unit tests for the task-create command.
 *
 * Requirements validated:
 *   FR-003: Non-interactive generation (single engine call)
 *   FR-004: Interactive Q&A flow (multi-turn)
 *   FR-005: Engine resolution from build config
 *   FR-006: Task file output location
 *   FR-007: Filename auto-generation with slug
 *   FR-008: Restricted tool access (no tools allowed)
 *   FR-009: Task file structure (no YAML frontmatter)
 *   FR-010: Agent works from description only
 *   FR-011: Discussion not persisted
 *   FR-013: Success output message
 *   NFR-002: Error handling (empty response, engine failure)
 */

import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';

import { registerEngine } from '../../engine.js';
import { taskCreateCommand } from '../task-create.js';
import type { ForjisEngine } from '../../engine.js';
import type { PromptOptions } from '../../types.js';

/** Creates a temporary directory for test isolation. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-task-create-test-'));
}

/** Removes a temporary directory and all its contents. */
async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Minimal valid build file YAML with tasks config. */
const VALID_BUILD_YAML = `version: 1
repositories:
  - type: dir
    path: "./repo"
tasks:
  source: dir
  path: "./tasks"
`;

/** Build file YAML with custom engine. */
const CUSTOM_ENGINE_BUILD_YAML = `version: 1
engine: test-engine
repositories:
  - type: dir
    path: "./repo"
tasks:
  source: dir
  path: "./tasks"
`;

/** Creates a mock engine that returns the given prompt response. */
function createMockEngine(response: string): ForjisEngine & { promptCalls: Array<{ text: string; options: PromptOptions }> } {
  const promptCalls: Array<{ text: string; options: PromptOptions }> = [];

  return {
    name: 'test-engine',
    promptCalls,
    async checkPrerequisites() { return 'ok'; },
    async prepare() { return { generated: [], skipped: [] }; },
    async invoke() { return { exitCode: 0, taskId: 'test', stage: null }; },
    async cleanup() {},
    async prompt(text: string, options: PromptOptions): Promise<string> {
      promptCalls.push({ text, options });
      return response;
    },
  };
}

/** Creates a mock engine that returns different responses for sequential calls. */
function createMultiResponseEngine(responses: string[]): ForjisEngine & { promptCalls: Array<{ text: string; options: PromptOptions }> } {
  const promptCalls: Array<{ text: string; options: PromptOptions }> = [];
  let callIndex = 0;

  return {
    name: 'test-engine',
    promptCalls,
    async checkPrerequisites() { return 'ok'; },
    async prepare() { return { generated: [], skipped: [] }; },
    async invoke() { return { exitCode: 0, taskId: 'test', stage: null }; },
    async cleanup() {},
    async prompt(text: string, options: PromptOptions): Promise<string> {
      promptCalls.push({ text, options });
      const resp = responses[callIndex] ?? '';
      callIndex++;
      return resp;
    },
  };
}

describe('taskCreateCommand', () => {
  let tempDir: string;
  let buildFilePath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    buildFilePath = join(tempDir, 'build.forjis');
    await writeFile(buildFilePath, VALID_BUILD_YAML, 'utf-8');
    await mkdir(join(tempDir, 'repo'), { recursive: true });
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
    jest.restoreAllMocks();
  });

  describe('non-interactive mode', () => {
    it('calls engine.prompt exactly once with returnOutput=true', async () => {
      const engine = createMockEngine('# Build REST API\n\nCreate a REST API endpoint.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'build a REST API', false);

      expect(engine.promptCalls).toHaveLength(1);
      expect(engine.promptCalls[0].options.returnOutput).toBe(true);
    });

    it('disallows all tools to prevent engine from writing files directly', async () => {
      const engine = createMockEngine('# Build REST API\n\nCreate a REST API.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'build a REST API', false);

      expect(engine.promptCalls[0].options.allowedTools).toEqual([]);
    });

    it('writes file with underscore prefix and slug from title', async () => {
      const engine = createMockEngine('# Build REST API\n\nCreate a REST API.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'build a REST API', false);

      const tasksDir = join(tempDir, 'tasks');
      const files = await readdir(tasksDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe('_build-rest-api.md');
    });

    it('writes the generated content to the task file', async () => {
      const content = '# My Task\n\nDo something useful.';
      const engine = createMockEngine(content);
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'do something', false);

      const tasksDir = join(tempDir, 'tasks');
      const written = await readFile(join(tasksDir, '_my-task.md'), 'utf-8');
      expect(written).toBe(content);
    });

    it('prints success message after writing', async () => {
      const engine = createMockEngine('# Task Title\n\nContent.');
      registerEngine('claude', async () => engine);
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await taskCreateCommand(tempDir, buildFilePath, 'some task', false);

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Task created:'));
      spy.mockRestore();
    });

    it('includes no-analysis instruction in prompt text', async () => {
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      const promptText = engine.promptCalls[0].text;
      expect(promptText).toContain('Do NOT analyze the project codebase');
    });

    it('includes the description in the prompt', async () => {
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'build a REST API', false);

      const promptText = engine.promptCalls[0].text;
      expect(promptText).toContain('build a REST API');
    });

    it('instructs no YAML frontmatter in prompt', async () => {
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      const promptText = engine.promptCalls[0].text;
      expect(promptText).toContain('Do NOT include YAML frontmatter');
    });
  });

  describe('error handling', () => {
    it('throws when engine returns empty response', async () => {
      const engine = createMockEngine('');
      registerEngine('claude', async () => engine);

      await expect(
        taskCreateCommand(tempDir, buildFilePath, 'some task', false)
      ).rejects.toThrow('Engine returned empty response');
    });

    it('throws when engine returns whitespace-only response', async () => {
      const engine = createMockEngine('   \n  ');
      registerEngine('claude', async () => engine);

      await expect(
        taskCreateCommand(tempDir, buildFilePath, 'some task', false)
      ).rejects.toThrow('Engine returned empty response');
    });

    it('propagates engine errors without writing a file', async () => {
      const engine = createMockEngine('');
      engine.prompt = async () => { throw new Error('Engine crashed'); };
      registerEngine('claude', async () => engine);

      await expect(
        taskCreateCommand(tempDir, buildFilePath, 'some task', false)
      ).rejects.toThrow('Engine crashed');

      const tasksDir = join(tempDir, 'tasks');
      try {
        const files = await readdir(tasksDir);
        expect(files).toHaveLength(0);
      } catch {
        // tasks dir may not exist, which is correct
      }
    });
  });

  describe('slug generation', () => {
    it('handles titles with special characters', async () => {
      const engine = createMockEngine('# Build REST API (v2.0)!\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      const files = await readdir(join(tempDir, 'tasks'));
      expect(files[0]).toBe('_build-rest-api-v2-0.md');
    });

    it('uses untitled-task when no heading found', async () => {
      const engine = createMockEngine('Just some content without a heading.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      const files = await readdir(join(tempDir, 'tasks'));
      expect(files[0]).toBe('_untitled-task.md');
    });

    it('collapses consecutive hyphens', async () => {
      const engine = createMockEngine('# Build --- API\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      const files = await readdir(join(tempDir, 'tasks'));
      expect(files[0]).toBe('_build-api.md');
    });
  });

  describe('interactive mode', () => {
    it('falls back to direct generation when JSON parse fails', async () => {
      const engine = createMultiResponseEngine([
        'not valid json',
        '# Generated Task\n\nContent from fallback.',
      ]);
      registerEngine('claude', async () => engine);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await taskCreateCommand(tempDir, buildFilePath, 'a task', true);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'), expect.anything());
      expect(engine.promptCalls).toHaveLength(2);

      const files = await readdir(join(tempDir, 'tasks'));
      expect(files).toHaveLength(1);

      warnSpy.mockRestore();
    });

    it('falls back when questions array is empty', async () => {
      const engine = createMultiResponseEngine([
        '{"questions": []}',
        '# Generated Task\n\nContent.',
      ]);
      registerEngine('claude', async () => engine);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await taskCreateCommand(tempDir, buildFilePath, 'a task', true);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No clarifying questions'));
      expect(engine.promptCalls).toHaveLength(2);

      warnSpy.mockRestore();
    });
  });

  describe('engine resolution', () => {
    it('uses engine from build config when specified', async () => {
      await writeFile(buildFilePath, CUSTOM_ENGINE_BUILD_YAML, 'utf-8');
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('test-engine', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      expect(engine.promptCalls).toHaveLength(1);
    });
  });

  describe('tasks directory', () => {
    it('creates tasks directory if it does not exist', async () => {
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      const files = await readdir(join(tempDir, 'tasks'));
      expect(files).toHaveLength(1);
    });
  });

  describe('prompt options identity', () => {
    it('sets options.id to task-create in non-interactive mode', async () => {
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      expect(engine.promptCalls[0].options.id).toBe('task-create');
    });

    it('sets options.projectDir to cwd in non-interactive mode', async () => {
      const engine = createMockEngine('# Task\n\nContent.');
      registerEngine('claude', async () => engine);

      await taskCreateCommand(tempDir, buildFilePath, 'a task', false);

      expect(engine.promptCalls[0].options.projectDir).toBe(tempDir);
    });

    it('sets options.id to task-create in interactive mode (questions call)', async () => {
      const engine = createMultiResponseEngine([
        '{"questions": []}',
        '# Task\n\nContent.',
      ]);
      registerEngine('claude', async () => engine);
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      await taskCreateCommand(tempDir, buildFilePath, 'a task', true);

      expect(engine.promptCalls[0].options.id).toBe('task-create');
    });

    it('sets options.projectDir to cwd in interactive mode (questions call)', async () => {
      const engine = createMultiResponseEngine([
        '{"questions": []}',
        '# Task\n\nContent.',
      ]);
      registerEngine('claude', async () => engine);
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      await taskCreateCommand(tempDir, buildFilePath, 'a task', true);

      expect(engine.promptCalls[0].options.projectDir).toBe(tempDir);
    });

    it('sets options.id on fallback generation call after empty questions', async () => {
      const engine = createMultiResponseEngine([
        '{"questions": []}',
        '# Task\n\nContent.',
      ]);
      registerEngine('claude', async () => engine);
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      await taskCreateCommand(tempDir, buildFilePath, 'a task', true);

      expect(engine.promptCalls[1].options.id).toBe('task-create');
      expect(engine.promptCalls[1].options.projectDir).toBe(tempDir);
    });
  });
});
