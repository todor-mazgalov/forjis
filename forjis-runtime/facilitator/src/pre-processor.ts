/**
 * Pre-processor for @forjis/cli.
 *
 * Analyzes tasks for ambiguities using an LLM and generates clarification
 * question files when issues are detected. Also supports automatic
 * dependency detection between tasks when enabled.
 */

import { join } from 'node:path';

import type { ForjisEngine } from './engine.js';
import { writeYamlFile } from './state.js';
import { isValidTaskId } from './task-id.js';
import { PromptOptions, type ClarificationFile, type ClarificationQuestion, type TaskState } from './types.js';

/**
 * Analyzes a task for ambiguities and optionally detects dependencies.
 *
 * Invokes the LLM with the task description. If auto-dependency detection
 * is enabled, existing task descriptions are included for cross-referencing.
 *
 * @param task - The task state to analyze.
 * @param taskContent - The full task description text.
 * @param autoDependencies - Whether to detect dependencies on other tasks.
 * @param existingTasks - List of other tasks for dependency analysis.
 * @returns Questions (if ambiguities found) and detected dependencies.
 */
export async function preprocessTask(
  task: TaskState,
  taskContent: string,
  autoDependencies: boolean,
  existingTasks: TaskState[],
  engine: ForjisEngine
): Promise<{ questions: ClarificationFile | null; dependencies: string[] }> {
  const prompt = buildPreprocessPrompt(task, taskContent, autoDependencies, existingTasks);

  try {
    const options = new PromptOptions();
    options.returnOutput = true;
    const output = await engine.prompt(prompt, options);
    return parsePreprocessResponse(task.id, output);
  } catch {
    return { questions: null, dependencies: [] };
  }
}

/**
 * Writes a clarification file next to the task source.
 *
 * The file is named <taskId>.questions.yaml and placed in the tasks directory.
 *
 * @param tasksDir - The path to the tasks directory.
 * @param taskId - The ID of the task needing clarification.
 * @param clarification - The clarification questions to write.
 */
export async function writeClarificationFile(
  tasksDir: string,
  taskId: string,
  clarification: ClarificationFile
): Promise<void> {
  const filePath = join(tasksDir, `${taskId}.questions.yaml`);
  await writeYamlFile(filePath, clarification);
}

// -- Internal helpers -------------------------------------------------------

/** Builds the LLM prompt for task pre-processing. */
function buildPreprocessPrompt(
  task: TaskState,
  taskContent: string,
  autoDependencies: boolean,
  existingTasks: TaskState[]
): string {
  let prompt = `Analyze the following task for ambiguities or missing information.

## Task: ${task.id}
${taskContent}

If you find ambiguities, return a JSON object with this structure:
{ "ambiguities": [{"id": "q1", "question": "..."}], "dependencies": [] }

If the task is clear, return:
{ "ambiguities": [], "dependencies": [] }`;

  if (autoDependencies && existingTasks.length > 0) {
    prompt += '\n\n## Existing Tasks (check for dependencies)\n';
    for (const existing of existingTasks) {
      prompt += `- ${existing.id}: ${existing.description.substring(0, 200)}\n`;
    }
    prompt += '\nInclude any task IDs this task depends on in the "dependencies" array.';
  }

  return prompt;
}

/** Parses the LLM pre-processor response. */
function parsePreprocessResponse(
  taskId: string,
  output: string
): { questions: ClarificationFile | null; dependencies: string[] } {
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { questions: null, dependencies: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      ambiguities?: Array<{ id: string; question: string }>;
      dependencies?: string[];
    };

    const rawDependencies = parsed.dependencies ?? [];
    const dependencies = rawDependencies.filter(depId => {
      if (isValidTaskId(depId)) return true;
      console.warn(`[pre-processor] Rejected invalid dependency ID: "${depId}" (task: ${taskId})`);
      return false;
    });

    if (!parsed.ambiguities || parsed.ambiguities.length === 0) {
      return { questions: null, dependencies };
    }

    const questions: ClarificationQuestion[] = parsed.ambiguities.map(a => ({
      id: a.id,
      question: a.question,
      answer: '',
    }));

    const clarification: ClarificationFile = {
      task: taskId,
      status: 'awaiting_answers',
      questions,
    };

    return { questions: clarification, dependencies };
  } catch {
    return { questions: null, dependencies: [] };
  }
}

