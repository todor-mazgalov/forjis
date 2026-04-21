/**
 * Task creation command for @forjis/cli.
 *
 * Generates structured task files from rough descriptions using the LLM engine.
 * Supports both non-interactive (single-shot) and interactive (Q&A) modes.
 * The generated file is named with a sanitized slug prefixed by underscore
 * to indicate it requires activation.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join, resolve } from 'node:path';

import { loadBuildFile, parseBuildFile } from '@forjis/resolver';
import { loadEngine } from '../engine.js';
import type { ForjisEngine } from '../engine.js';
import { PromptOptions } from '../types.js';

/**
 * Creates a new task file from a rough description using LLM generation.
 *
 * In non-interactive mode, sends the description to the engine in a single
 * prompt call. In interactive mode, first asks the engine for clarifying
 * questions, presents them to the user one at a time, then generates the
 * task file with the collected context.
 *
 * @param cwd - Current working directory.
 * @param buildFilePath - Path to the build.forjis file.
 * @param description - The rough task description from the user.
 * @param interactive - Whether to enable interactive Q&A mode.
 * @throws {Error} If the engine returns empty content or fails.
 */
export async function taskCreateCommand(
  cwd: string,
  buildFilePath: string,
  description: string,
  interactive: boolean
): Promise<void> {
  const config = await loadAndParseConfig(buildFilePath);
  const tasksDir = resolveTasksDir(cwd, config.tasks?.path);
  const engineName = config.engine ?? 'claude';
  const engine = await loadEngine(engineName);

  const content = interactive
    ? await generateInteractiveTask(engine, description, tasksDir, cwd)
    : await generateDirectTask(engine, description, tasksDir, cwd);

  const title = extractTitle(content);
  const filename = slugify(title);
  const filePath = join(tasksDir, filename);

  await mkdir(tasksDir, { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  console.log(`Task created: ${filePath}`);
}

/**
 * Loads and parses the build file into a typed BuildConfig.
 *
 * @param buildFilePath - Absolute path to build.forjis.
 * @returns The parsed build configuration.
 */
async function loadAndParseConfig(buildFilePath: string): Promise<import('../types.js').BuildConfig> {
  const raw = await loadBuildFile(buildFilePath);
  return parseBuildFile(raw);
}

/**
 * Resolves the absolute tasks directory path from config.
 *
 * @param cwd - Current working directory.
 * @param tasksPath - The tasks path from config, if set.
 * @returns The resolved absolute tasks directory path.
 */
function resolveTasksDir(cwd: string, tasksPath: string | undefined): string {
  return resolve(cwd, tasksPath ?? 'tasks');
}

/**
 * Creates a PromptOptions instance configured for task generation.
 *
 * Sets returnOutput to true and disallows all tools, ensuring the engine
 * returns task content as text output rather than writing files directly.
 *
 * @param cwd - Current working directory (project root).
 * @returns A configured PromptOptions instance.
 */
function createTaskPromptOptions(cwd: string): PromptOptions {
  const options = new PromptOptions();
  options.id = 'task-create';
  options.projectDir = cwd;
  options.returnOutput = true;
  options.allowedTools = [];
  return options;
}

/**
 * Creates a PromptOptions instance for fetching clarifying questions.
 *
 * Uses maxTurns=1 to prevent tool use — the engine should return
 * plain JSON text in a single response turn.
 *
 * @param cwd - Current working directory (project root).
 * @returns A configured PromptOptions instance.
 */
function createQuestionsPromptOptions(cwd: string): PromptOptions {
  const options = new PromptOptions();
  options.id = 'task-create';
  options.projectDir = cwd;
  options.returnOutput = true;
  options.maxTurns = 1;
  return options;
}

/**
 * Generates a task file in a single engine call without user interaction.
 *
 * @param engine - The loaded engine instance.
 * @param description - The user's task description.
 * @param tasksDir - Absolute path to the tasks directory.
 * @param cwd - Current working directory (project root).
 * @returns The generated task content as a string.
 * @throws {Error} If the engine returns empty or null output.
 */
async function generateDirectTask(
  engine: ForjisEngine,
  description: string,
  tasksDir: string,
  cwd: string
): Promise<string> {
  const prompt = buildGenerationPrompt(description, tasksDir);
  const options = createTaskPromptOptions(cwd);
  const output = await engine.prompt(prompt, options);

  if (!output || output.trim().length === 0) {
    throw new Error('Engine returned empty response. No task file created.');
  }

  return output.trim();
}

/**
 * Conducts an interactive Q&A session and generates a task file.
 *
 * First prompts the engine for clarifying questions about the description.
 * Then presents each question to the user via readline. Finally generates
 * the task file incorporating all answers.
 *
 * @param engine - The loaded engine instance.
 * @param description - The user's task description.
 * @param tasksDir - Absolute path to the tasks directory.
 * @param cwd - Current working directory (project root).
 * @returns The generated task content as a string.
 * @throws {Error} If the final engine call returns empty output.
 */
async function generateInteractiveTask(
  engine: ForjisEngine,
  description: string,
  tasksDir: string,
  cwd: string
): Promise<string> {
  const questions = await fetchQuestions(engine, description, cwd);

  if (questions.length === 0) {
    console.warn('No clarifying questions generated. Falling back to direct generation.');
    return generateDirectTask(engine, description, tasksDir, cwd);
  }

  const answers = await collectAnswers(questions);
  return generateWithContext(engine, description, questions, answers, tasksDir, cwd);
}

/**
 * Fetches clarifying questions from the engine for a task description.
 *
 * Sends a prompt requesting JSON-formatted questions. Falls back to an
 * empty array if JSON parsing fails (graceful degradation).
 *
 * @param engine - The loaded engine instance.
 * @param description - The user's task description.
 * @param cwd - Current working directory (project root).
 * @returns An array of question strings, or empty on parse failure.
 */
async function fetchQuestions(engine: ForjisEngine, description: string, cwd: string): Promise<string[]> {
  const prompt = buildQuestionsPrompt(description);
  const options = createQuestionsPromptOptions(cwd);

  try {
    const output = await engine.prompt(prompt, options);
    const parsed = JSON.parse(output) as { questions: string[] };
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch(e) {
    console.warn('Failed to parse clarifying questions. Falling back to direct generation.', e);
    return [];
  }
}

/**
 * Collects answers from the user for each clarifying question via readline.
 *
 * Presents questions one at a time and waits for user input.
 *
 * @param questions - Array of question strings to present.
 * @returns Array of answer strings in the same order as questions.
 */
async function collectAnswers(questions: string[]): Promise<string[]> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answers: string[] = [];
  for (const question of questions) {
    const answer = await askQuestion(rl, question);
    answers.push(answer);
  }

  rl.close();
  return answers;
}

/**
 * Asks the user a question via readline and returns the answer.
 *
 * @param rl - The readline interface.
 * @param question - The question text to display.
 * @returns The user's answer string.
 */
function askQuestion(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`\n${question}\n> `, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Generates a task file with the original description and Q&A context.
 *
 * @param engine - The loaded engine instance.
 * @param description - The original user description.
 * @param questions - The clarifying questions that were asked.
 * @param answers - The user's answers to those questions.
 * @param tasksDir - Absolute path to the tasks directory.
 * @param cwd - Current working directory (project root).
 * @returns The generated task content as a string.
 * @throws {Error} If the engine returns empty output.
 */
async function generateWithContext(
  engine: ForjisEngine,
  description: string,
  questions: string[],
  answers: string[],
  tasksDir: string,
  cwd: string
): Promise<string> {
  const qaPairs = questions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n\n');
  const prompt = buildGenerationPromptWithQA(description, qaPairs, tasksDir);
  const options = createTaskPromptOptions(cwd);
  const output = await engine.prompt(prompt, options);

  if (!output || output.trim().length === 0) {
    throw new Error('Engine returned empty response. No task file created.');
  }

  return output.trim();
}

/**
 * Generates a sanitized filename slug from a task title.
 *
 * Converts to lowercase, replaces non-alphanumeric characters with hyphens,
 * collapses consecutive hyphens, trims leading/trailing hyphens, and
 * prepends underscore prefix.
 *
 * @param title - The task title to slugify.
 * @returns Filename in format `_slug-name.md`.
 */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `_${slug}.md`;
}

/**
 * Extracts the first top-level heading from markdown content.
 *
 * @param content - The markdown content to parse.
 * @returns The heading text, or 'untitled-task' if none found.
 */
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'untitled-task';
}

/**
 * Builds the prompt for non-interactive task generation.
 *
 * @param description - The user's task description.
 * @param tasksDir - Absolute path to the tasks directory.
 * @returns The formatted prompt string.
 */
function buildGenerationPrompt(description: string, tasksDir: string): string {
  return `You are a task writer for the Forjis pipeline.

Generate a well-structured markdown task file from the following description.

## Rules
- Start with a single # heading that clearly describes the task
- Include descriptive sections explaining what needs to be done
- Do NOT include YAML frontmatter
- Do NOT analyze the project codebase
- Do NOT use Read, Grep, or Glob tools
- Work exclusively from the provided description

## Description
${description}

## Output
Return ONLY the raw markdown content. Do NOT use any tools. Do NOT write files.`;
}

/**
 * Builds the prompt for interactive question generation.
 *
 * @param description - The user's task description.
 * @returns The formatted prompt string requesting JSON questions.
 */
function buildQuestionsPrompt(description: string): string {
  return `You are a task writer for the Forjis pipeline.

A user wants to create a task from the following rough description. Before generating the task file, identify any ambiguities or missing details that would help produce a higher quality task.

## Description
${description}

## Instructions
- Return a JSON object with a "questions" array containing clarifying question strings
- Each question should address a specific ambiguity or missing detail
- Return ONLY the raw JSON object, no markdown fences, no additional text

Example format:
{"questions": ["What is the expected input format?", "Should this handle error cases?"]}`;
}

/**
 * Builds the prompt for task generation with Q&A context.
 *
 * @param description - The original user description.
 * @param qaPairs - Formatted Q&A pairs from the interactive session.
 * @param tasksDir - Absolute path to the tasks directory.
 * @returns The formatted prompt string.
 */
function buildGenerationPromptWithQA(description: string, qaPairs: string, tasksDir: string): string {
  return `You are a task writer for the Forjis pipeline.

Generate a well-structured markdown task file from the following description and clarifications.

## Rules
- Start with a single # heading that clearly describes the task
- Include descriptive sections explaining what needs to be done
- Incorporate all clarifications from the Q&A below
- Do NOT include YAML frontmatter
- Do NOT analyze the project codebase
- Do NOT use Read, Grep, or Glob tools
- Work exclusively from the provided description and answers

## Description
${description}

## Clarifications
${qaPairs}

## Output
Return ONLY the raw markdown content. Do NOT use any tools. Do NOT write files.`;
}
