/**
 * Unit tests for TaskQueue.detectCircularDeps
 *
 * The method uses iterative DFS with node coloring (visited + inStack sets)
 * and back-edge tracking to detect cycles. These tests exercise every
 * relevant graph topology individually so coverage is unambiguous.
 *
 * No file-system access is required — detectCircularDeps is a pure,
 * synchronous method that operates only on the in-memory task list.
 */

import { TaskQueue } from '../task-queue.js';
import type { TaskState } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal TaskState with only the fields that detectCircularDeps
 * actually uses: `id` and `dependencies`.
 */
function makeTask(id: string, dependencies: string[] = []): TaskState {
  return {
    id,
    status: 'queued',
    priority: 'medium',
    created: '2024-01-01T00:00:00.000Z',
    source: 'cli',
    dependencies,
    description: id,
    retryCount: 0,
  };
}

/** Returns a fresh TaskQueue instance. detectCircularDeps never touches disk. */
function makeQueue(): TaskQueue {
  return new TaskQueue('/tmp/noop', null);
}

/** Checks whether a specific back-edge [from, to] is present in the results. */
function hasCycle(cycles: [string, string][], from: string, to: string): boolean {
  return cycles.some(([a, b]) => a === from && b === to);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TaskQueue.detectCircularDeps', () => {
  // -------------------------------------------------------------------------
  // 1. Empty / no-dependency graphs
  // -------------------------------------------------------------------------

  it('returns an empty array for an empty task list', () => {
    const queue = makeQueue();
    expect(queue.detectCircularDeps([])).toEqual([]);
  });

  it('returns an empty array when no task has any dependencies', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a'),
      makeTask('task-b'),
      makeTask('task-c'),
    ];
    expect(queue.detectCircularDeps(tasks)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. Linear / acyclic chains
  // -------------------------------------------------------------------------

  it('returns an empty array for a single-task linear chain (A)', () => {
    const queue = makeQueue();
    expect(queue.detectCircularDeps([makeTask('task-a')])).toEqual([]);
  });

  it('returns an empty array for a two-node linear chain (A→B)', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b']),
      makeTask('task-b'),
    ];
    expect(queue.detectCircularDeps(tasks)).toEqual([]);
  });

  it('returns an empty array for a three-node linear chain (A→B→C)', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b']),
      makeTask('task-b', ['task-c']),
      makeTask('task-c'),
    ];
    expect(queue.detectCircularDeps(tasks)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3. Diamond (A→B, A→C; B→D, C→D) — shared sink, no cycle
  // -------------------------------------------------------------------------

  it('returns an empty array for a diamond graph (A→B,C; B→D; C→D)', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b', 'task-c']),
      makeTask('task-b', ['task-d']),
      makeTask('task-c', ['task-d']),
      makeTask('task-d'),
    ];
    expect(queue.detectCircularDeps(tasks)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. Simple cycle (A→B→A)
  // -------------------------------------------------------------------------

  it('detects a simple two-node cycle (A→B→A)', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b']),
      makeTask('task-b', ['task-a']),
    ];
    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles.length).toBeGreaterThan(0);
    // The DFS will find the back-edge B→A
    expect(hasCycle(cycles, 'task-b', 'task-a')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Longer cycle (A→B→C→A)
  // -------------------------------------------------------------------------

  it('detects a three-node cycle (A→B→C→A)', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b']),
      makeTask('task-b', ['task-c']),
      makeTask('task-c', ['task-a']),
    ];
    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles.length).toBeGreaterThan(0);
    // The back-edge is C→A (C is on the stack when it tries to visit A again)
    expect(hasCycle(cycles, 'task-c', 'task-a')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. Self-dependency (A→A)
  // -------------------------------------------------------------------------

  it('detects a self-dependency (A→A)', () => {
    const queue = makeQueue();
    const tasks = [makeTask('task-a', ['task-a'])];
    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles.length).toBeGreaterThan(0);
    // A is added to inStack, then its only neighbor is A which is already inStack
    expect(hasCycle(cycles, 'task-a', 'task-a')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7. Disconnected graph — cycle in one component, clean in the other
  // -------------------------------------------------------------------------

  it('detects a cycle only in the component that contains it (disconnected graph)', () => {
    const queue = makeQueue();
    const tasks = [
      // Component 1: clean linear chain X→Y→Z
      makeTask('task-x', ['task-y']),
      makeTask('task-y', ['task-z']),
      makeTask('task-z'),
      // Component 2: cycle P→Q→P
      makeTask('task-p', ['task-q']),
      makeTask('task-q', ['task-p']),
    ];
    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles.length).toBeGreaterThan(0);
    // The cycle back-edge must involve only the P/Q component
    expect(hasCycle(cycles, 'task-q', 'task-p')).toBe(true);
    // No spurious back-edges should reference the clean component
    const cleanIds = new Set(['task-x', 'task-y', 'task-z']);
    const dirtyEdges = cycles.filter(([a, b]) => cleanIds.has(a) || cleanIds.has(b));
    expect(dirtyEdges).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. Return type shape
  // -------------------------------------------------------------------------

  it('returns an array of [string, string] tuples', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b']),
      makeTask('task-b', ['task-a']),
    ];
    const cycles = queue.detectCircularDeps(tasks);
    expect(Array.isArray(cycles)).toBe(true);
    for (const entry of cycles) {
      expect(Array.isArray(entry)).toBe(true);
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
    }
  });

  // -------------------------------------------------------------------------
  // 9. Idempotency — calling twice on the same tasks gives the same result
  // -------------------------------------------------------------------------

  it('produces identical results across repeated calls (no shared state leak)', () => {
    const queue = makeQueue();
    const tasks = [
      makeTask('task-a', ['task-b']),
      makeTask('task-b', ['task-a']),
    ];
    const first = queue.detectCircularDeps(tasks);
    const second = queue.detectCircularDeps(tasks);
    expect(first).toEqual(second);
  });

  // -------------------------------------------------------------------------
  // 10. Fan-out with one cyclic branch and one acyclic branch
  // -------------------------------------------------------------------------

  it('reports only the cyclic branch when A has two children: one safe and one cyclic', () => {
    const queue = makeQueue();
    // A → B (safe leaf)
    // A → C → A (cycle)
    const tasks = [
      makeTask('task-a', ['task-b', 'task-c']),
      makeTask('task-b'),
      makeTask('task-c', ['task-a']),
    ];
    const cycles = queue.detectCircularDeps(tasks);
    expect(cycles.length).toBeGreaterThan(0);
    expect(hasCycle(cycles, 'task-c', 'task-a')).toBe(true);
    // task-b should not appear in any cycle edge
    const bEdges = cycles.filter(([a, b]) => a === 'task-b' || b === 'task-b');
    expect(bEdges).toHaveLength(0);
  });
});
