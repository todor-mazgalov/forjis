/**
 * Backend-layer unit tests for EventServiceImpl.getEventsByRole (Phase G of
 * redesign-013-api-contract-extensions).
 *
 * Validates that the role-only filter scans every events*.jsonl file in a
 * task's directory and matches on the in-payload `role` field rather than
 * on the filename slug. This is the substrate for `?role=orchestrator` and
 * any other role identifier.
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventServiceImpl } from '@forjis/facilitator';
import type { TaskEvent } from '@forjis/facilitator';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forjis-event-role-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function setupTaskDir(projectDir: string, taskId: string): Promise<string> {
  const dir = join(projectDir, '.forjis', 'tasks', taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

function jsonl(events: TaskEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('EventServiceImpl.getEventsByRole', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(projectDir);
  });

  test('returns the orchestrator event from events.jsonl', async () => {
    const taskId = 'task-evt-1';
    const dir = await setupTaskDir(projectDir, taskId);
    await writeFile(join(dir, 'events.jsonl'), jsonl([
      {
        timestamp: '2026-04-19T10:00:00Z',
        type: 'system',
        role: 'orchestrator',
        content: 'orchestrator started',
      },
    ]), 'utf-8');
    await writeFile(join(dir, 'events-dev-explorer.jsonl'), jsonl([
      {
        timestamp: '2026-04-19T10:01:00Z',
        type: 'assistant',
        role: 'Explorer',
        content: 'exploring',
      },
    ]), 'utf-8');

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEventsByRole(taskId, 'orchestrator');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('orchestrator started');
  });

  test('matches on event.role across per-role files', async () => {
    const taskId = 'task-evt-2';
    const dir = await setupTaskDir(projectDir, taskId);
    await writeFile(join(dir, 'events.jsonl'), jsonl([
      {
        timestamp: '2026-04-19T10:00:00Z',
        type: 'system',
        role: 'orchestrator',
        content: 'orch',
      },
    ]), 'utf-8');
    await writeFile(join(dir, 'events-dev-explorer.jsonl'), jsonl([
      {
        timestamp: '2026-04-19T10:01:00Z',
        type: 'assistant',
        role: 'Explorer',
        content: 'first',
      },
      {
        timestamp: '2026-04-19T10:02:00Z',
        type: 'assistant',
        role: 'Explorer',
        content: 'second',
      },
    ]), 'utf-8');

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEventsByRole(taskId, 'Explorer');

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.content)).toEqual(['first', 'second']);
  });

  test('returns empty array for an unknown role', async () => {
    const taskId = 'task-evt-3';
    const dir = await setupTaskDir(projectDir, taskId);
    await writeFile(join(dir, 'events.jsonl'), jsonl([
      {
        timestamp: '2026-04-19T10:00:00Z',
        type: 'system',
        role: 'orchestrator',
        content: 'orch',
      },
    ]), 'utf-8');

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEventsByRole(taskId, 'Unknown');
    expect(result).toEqual([]);
  });

  test('respects the since filter', async () => {
    const taskId = 'task-evt-4';
    const dir = await setupTaskDir(projectDir, taskId);
    await writeFile(join(dir, 'events-dev-explorer.jsonl'), jsonl([
      {
        timestamp: '2026-04-19T10:00:00Z',
        type: 'assistant',
        role: 'Explorer',
        content: 'first',
      },
      {
        timestamp: '2026-04-19T10:01:00Z',
        type: 'assistant',
        role: 'Explorer',
        content: 'second',
      },
    ]), 'utf-8');

    const svc = new EventServiceImpl(projectDir);
    const result = await svc.getEventsByRole(taskId, 'Explorer', '2026-04-19T10:00:00Z');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('second');
  });
});
