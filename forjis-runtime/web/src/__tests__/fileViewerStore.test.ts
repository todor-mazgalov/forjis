/**
 * Unit tests for the file-viewer store exported by
 * `components/fileViewerStore.ts`. The store is three module-level
 * accessors backed by a private `createSignal`, so the tests call the
 * functions and assert against `currentFile()` in response.
 *
 * The store imports `createSignal` from `solid-js`; Solid is a small
 * reactive library that resolves cleanly under Node when the package is
 * reachable from the test runner's module resolver. If the runner cannot
 * locate `solid-js`, the whole file should be skipped (the ts-jest
 * resolver will raise a descriptive error at load time) — see
 * redesign-010 qa.md for the follow-up.
 *
 * Requirements covered:
 *   redesign-010 — fileViewerStore module-level dispatcher (design.md § D-6).
 */

import {
  closeFile,
  currentFile,
  openFile,
} from '../../client/src/components/fileViewerStore.js';

describe('fileViewerStore', () => {
  afterEach(() => {
    closeFile();
  });

  test('currentFile is null before any open call', () => {
    expect(currentFile()).toBeNull();
  });

  test('openFile with source=plugin stores taskId=null', () => {
    openFile('a/b.md', 'plugin');
    expect(currentFile()).toEqual({
      path: 'a/b.md',
      source: 'plugin',
      taskId: null,
    });
  });

  test('openFile with source=task and no taskId stores taskId=null', () => {
    openFile('TASK.md', 'task');
    expect(currentFile()).toEqual({
      path: 'TASK.md',
      source: 'task',
      taskId: null,
    });
  });

  test('openFile with source=task and an explicit taskId stores it', () => {
    openFile('TASK.md', 'task', 'my-task');
    expect(currentFile()).toEqual({
      path: 'TASK.md',
      source: 'task',
      taskId: 'my-task',
    });
  });

  test('closeFile returns the signal to null', () => {
    openFile('x.md', 'plugin');
    expect(currentFile()).not.toBeNull();
    closeFile();
    expect(currentFile()).toBeNull();
  });

  test('two consecutive openFile calls produce distinct object identities', () => {
    openFile('a.md', 'plugin');
    const first = currentFile();
    openFile('a.md', 'plugin');
    const second = currentFile();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
