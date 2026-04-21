/**
 * Task queue manager for @forjis/cli.
 *
 * Handles task ingestion (from CLI flags or directory scanning), priority
 * ordering, state transitions, dependency management, concurrency control,
 * and clarification flow. Task state is persisted as YAML files in
 * .forjis/tasks/<task-id>/state.yaml.
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CliError } from './errors.js';
import { ensureDir, readYamlFile, writeYamlFile } from './state.js';
import { isValidTaskId } from './task-id.js';
import type {
  ClarificationFile,
  TaskPriority,
  TaskState,
  TaskStatus,
  TasksConfig,
} from './types.js';

/** Supported task file extensions for directory scanning. */
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.yaml', '.yml']);

/**
 * Manages the task queue for a project.
 *
 * Reads and writes state files under .forjis/tasks/, provides ordered
 * retrieval, concurrency-aware dispatch, and clarification handling.
 */
export class TaskQueue {
  private readonly tasksDir: string;

  /**
   * Creates a new TaskQueue for the given project directory.
   *
   * @param projectDir - The root directory of the target project.
   * @param config - The tasks configuration from build.forjis (may be null).
   */
  constructor(
    private readonly projectDir: string,
    private readonly config: TasksConfig | null
  ) {
    this.tasksDir = join(projectDir, '.forjis', 'tasks');
  }

  /**
   * Ingests a single inline task from the -t flag.
   *
   * Creates a task state with cli source, queued status, and medium priority.
   *
   * @param description - The inline task description.
   * @returns The created task state.
   */
  async ingestInline(description: string): Promise<TaskState> {
    const id = generateTaskId();
    const now = new Date().toISOString();

    const state: TaskState = {
      id,
      status: 'queued',
      priority: 'medium',
      created: now,
      queued: now,
      source: 'cli',
      dependencies: [],
      description,
      retryCount: 0,
    };

    const taskDir = join(this.tasksDir, id);
    await ensureDir(taskDir);
    await writeYamlFile(join(taskDir, 'state.yaml'), state);

    return state;
  }

  /**
   * Scans the tasks directory for new task files and directories.
   *
   * Finds .md, .txt, .yaml, .yml files and directories containing task.md.
   * Skips tasks that are already tracked in the queue. Extracts priority
   * from task content.
   *
   * @returns An array of newly created task states.
   * @throws {CliError} If the tasks directory does not exist.
   */
  async scanDirectory(): Promise<TaskState[]> {
    if (!this.config?.path) {
      throw new CliError(
        'No tasks directory configured.\n' +
        'Add a tasks block to your build file:\n' +
        '  tasks:\n' +
        '    source: dir\n' +
        '    path: "./tasks"'
      );
    }

    const tasksPath = join(this.projectDir, this.config.path);
    let entries: string[];

    try {
      entries = await readdir(tasksPath) as unknown as string[];
    } catch {
      throw new CliError(`Tasks directory not found: ${tasksPath}`);
    }

    const newTasks: TaskState[] = [];

    for (const entry of entries) {
      /* Skip underscore-prefixed entries — they are intentionally disabled. */
      if (entry.startsWith('_')) continue;

      const taskState = await this.processEntry(tasksPath, entry);
      if (taskState) {
        console.log(`[queue]: found task "${taskState.id}" (priority: ${taskState.priority})`);
        newTasks.push(taskState);
      }
    }

    return newTasks;
  }

  /**
   * Returns all tasks ordered by priority (descending) then created (ascending).
   *
   * @returns A sorted array of all task states.
   */
  async getOrdered(): Promise<TaskState[]> {
    const tasks = await this.listAll();

    return tasks.sort((a, b) => {
      const priorityDiff = priorityToNumeric(b.priority) - priorityToNumeric(a.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return a.created.localeCompare(b.created);
    });
  }

  /**
   * Returns the next task eligible for dispatch.
   *
   * Respects the concurrency cap and dependency ordering. A task is
   * dispatchable if it is queued and all its dependencies are done.
   *
   * @param runningCount - The number of currently running tasks.
   * @param maxConcurrent - The maximum number of concurrent tasks.
   * @returns The next dispatchable task, or null if none are available.
   */
  async nextDispatchable(
    runningCount: number,
    maxConcurrent: number
  ): Promise<TaskState | null> {
    if (runningCount >= maxConcurrent) {
      return null;
    }

    const ordered = await this.getOrdered();
    const queued = ordered.filter(t => t.status === 'queued');

    for (const task of queued) {
      if (await this.areDependenciesMet(task)) {
        return task;
      }
    }

    return null;
  }

  /**
   * Transitions a task to a new status with appropriate timestamp updates.
   *
   * @param taskId - The ID of the task to transition.
   * @param status - The new status to set.
   * @param extra - Optional additional fields to update on the task state.
   */
  async transition(
    taskId: string,
    status: TaskStatus,
    extra?: Partial<TaskState>
  ): Promise<void> {
    const state = await this.getState(taskId);
    if (!state) {
      throw new CliError(`Cannot transition unknown task "${taskId}"`);
    }

    state.status = status;
    const now = new Date().toISOString();

    if (status === 'queued' && !state.queued) {
      state.queued = now;
    }
    if (status === 'running') {
      state.started = now;
    }
    if (status === 'done' || status === 'failed') {
      state.completed = now;
    }

    if (extra) {
      Object.assign(state, extra);
    }

    await writeYamlFile(join(this.tasksDir, taskId, 'state.yaml'), state);
  }

  /**
   * Reads a task's current state from disk.
   *
   * @param taskId - The ID of the task to read.
   * @returns The task state, or null if not found.
   */
  async getState(taskId: string): Promise<TaskState | null> {
    return readYamlFile<TaskState>(join(this.tasksDir, taskId, 'state.yaml'));
  }

  /**
   * Lists all task states from the queue directory.
   *
   * @returns An array of all task states.
   */
  async listAll(): Promise<TaskState[]> {
    let dirs: string[];
    try {
      dirs = await readdir(this.tasksDir) as unknown as string[];
    } catch {
      return [];
    }

    const tasks: TaskState[] = [];

    for (const dir of dirs) {
      const state = await readYamlFile<TaskState>(join(this.tasksDir, dir, 'state.yaml'));
      if (state) {
        tasks.push(state);
      }
    }

    return tasks;
  }

  /**
   * Checks for answered clarification files and re-queues resolved tasks.
   *
   * Scans the tasks directory for .questions.yaml files. When all questions
   * have answers, transitions the task back to queued.
   *
   * @param tasksDir - The path to the tasks directory.
   */
  async checkClarifications(tasksDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(tasksDir) as unknown as string[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.questions.yaml')) {
        continue;
      }

      const clarification = await readYamlFile<ClarificationFile>(join(tasksDir, entry));
      if (!clarification) {
        continue;
      }

      const allAnswered = clarification.questions.every(q => q.answer && q.answer.trim() !== '');
      if (!allAnswered) {
        continue;
      }

      const taskId = clarification.task;
      const state = await this.getState(taskId);
      if (state && state.status === 'needs_clarification') {
        await this.transition(taskId, 'queued');
      }
    }
  }

  /**
   * Detects circular dependencies among a set of tasks.
   *
   * Uses DFS with coloring to find cycles in the dependency graph.
   *
   * @param tasks - The list of tasks to check.
   * @returns An array of [taskA, taskB] pairs involved in circular dependencies.
   */
  detectCircularDeps(tasks: TaskState[]): [string, string][] {
    const graph = new Map<string, string[]>();
    for (const task of tasks) {
      graph.set(task.id, task.dependencies);
    }

    const cycles: [string, string][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        dfs(task.id, graph, visited, inStack, cycles);
      }
    }

    return cycles;
  }

  /**
   * Returns the configured tasks directory path, or undefined if not set.
   */
  getTasksPath(): string | undefined {
    return this.config?.path;
  }

  /**
   * Returns the configured poll interval in milliseconds, defaulting to 300 000 (5 min).
   */
  getPollIntervalMs(): number {
    return this.config?.pollIntervalMs ?? 300_000;
  }

  // -- Private helpers ------------------------------------------------------

  /** Processes a single directory entry during scanning. */
  private async processEntry(
    tasksPath: string,
    entry: string
  ): Promise<TaskState | null> {
    if (entry.endsWith('.questions.yaml')) {
      return null;
    }

    const fullPath = join(tasksPath, entry);
    const ext = extname(entry);
    let taskId: string;
    let content: string;

    if (SUPPORTED_EXTENSIONS.has(ext)) {
      taskId = basename(entry, ext);
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        return null;
      }
    } else {
      const taskMdPath = join(fullPath, 'task.md');
      try {
        content = await readFile(taskMdPath, 'utf-8');
        taskId = entry;
      } catch {
        return null;
      }
    }

    if (!isValidTaskId(taskId)) {
      console.warn(`[queue]: skipping entry with unsafe task ID: "${taskId}"`);
      return null;
    }

    const existing = await this.getState(taskId);
    if (existing) {
      return null;
    }

    const priority = extractPriority(content);
    const now = new Date().toISOString();

    const state: TaskState = {
      id: taskId,
      status: 'queued',
      priority,
      created: now,
      queued: now,
      source: 'dir',
      dependencies: [],
      description: content,
      retryCount: 0,
    };

    const taskDir = join(this.tasksDir, taskId);
    await ensureDir(taskDir);
    await writeYamlFile(join(taskDir, 'state.yaml'), state);

    return state;
  }

  /** Checks if all dependencies of a task are in done status. */
  private async areDependenciesMet(task: TaskState): Promise<boolean> {
    for (const depId of task.dependencies) {
      const depState = await this.getState(depId);
      if (!depState || depState.status !== 'done') {
        return false;
      }
    }
    return true;
  }
}

/**
 * Extracts priority from task file content.
 *
 * Checks YAML frontmatter first, then trailing metadata lines.
 * Supports named priorities (critical, high, medium, low) and
 * numeric values (1-100).
 *
 * @param content - The raw task file content.
 * @returns The extracted priority, defaulting to 'medium'.
 */
export function extractPriority(content: string): TaskPriority | number {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const priorityMatch = frontmatterMatch[1].match(/^priority:\s*(.+)$/m);
    if (priorityMatch) {
      return parsePriorityValue(priorityMatch[1].trim());
    }
  }

  const trailingMatch = content.match(/^priority:\s*(.+)$/m);
  if (trailingMatch) {
    return parsePriorityValue(trailingMatch[1].trim());
  }

  return 'medium';
}

/**
 * Generates a unique task ID for inline tasks.
 *
 * Format: task-<timestamp>-<random4hex>
 *
 * @returns A unique task ID string.
 */
export function generateTaskId(): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString('hex');
  return `task-${timestamp}-${random}`;
}

/**
 * Converts a named priority to a numeric sort value.
 *
 * critical=100, high=75, medium=50, low=25.
 * Numeric values pass through directly.
 *
 * @param priority - The priority to convert.
 * @returns A numeric value for sorting (higher = more urgent).
 */
export function priorityToNumeric(priority: TaskPriority | number): number {
  if (typeof priority === 'number') {
    return priority;
  }

  const mapping: Record<TaskPriority, number> = {
    critical: 100,
    high: 75,
    medium: 50,
    low: 25,
  };

  return mapping[priority];
}

// -- Internal helpers -------------------------------------------------------

/** Parses a priority value string into a TaskPriority or number. */
function parsePriorityValue(value: string): TaskPriority | number {
  const named: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
  if (named.includes(value as TaskPriority)) {
    return value as TaskPriority;
  }

  const num = parseInt(value, 10);
  if (!isNaN(num) && num >= 1 && num <= 100) {
    return num;
  }

  return 'medium';
}

/** DFS cycle detection with coloring. */
function dfs(
  node: string,
  graph: Map<string, string[]>,
  visited: Set<string>,
  inStack: Set<string>,
  cycles: [string, string][]
): void {
  visited.add(node);
  inStack.add(node);

  const neighbors = graph.get(node) ?? [];
  for (const neighbor of neighbors) {
    if (inStack.has(neighbor)) {
      cycles.push([node, neighbor]);
      continue;
    }
    if (!visited.has(neighbor)) {
      dfs(neighbor, graph, visited, inStack, cycles);
    }
  }

  inStack.delete(node);
}
