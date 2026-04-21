/**
 * Contract tests for the GET /api/tasks `progress` field shape (Phase L5 of
 * redesign-013-api-contract-extensions).
 *
 * Asserts (against a stub TaskService whose listTasks() returns hand-built items):
 *   - progress is present on a task whose status is `running`.
 *   - progress is absent on a task whose status is `done`.
 *   - The synthetic orchestrator step is excluded from progress.total — i.e.
 *     a 6-step plan with one `kind: 'orchestrator'` returns total === 5.
 *
 * The plan-reading derivation is asserted by `task-progress.test.ts`. This
 * file focuses on the wire shape passing through handleTaskList unchanged.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleTaskList } from '../controllers.js';
import type { TaskService } from '../services.js';
import type { TaskListItem } from '../types.js';

function makeMockRes() {
  const mock = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    ended: false,
    writeHead(status: number, hdrs?: Record<string, string>) {
      if (this.headersSent) return;
      this.statusCode = status;
      if (hdrs) Object.assign(this.headers, hdrs);
      this.headersSent = true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      this.ended = true;
    },
    write(chunk: string) {
      this.body += chunk;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    writableEnded: false,
    on(_event: string, _cb: () => void) { return this; },
  };
  return mock as unknown as ServerResponse & typeof mock;
}

function makeMockReq(url = '/', method = 'GET'): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.url = url;
  emitter.method = method;
  return emitter;
}

function parseBody<T>(res: ReturnType<typeof makeMockRes>): T {
  return JSON.parse(res.body) as T;
}

function makeStubTaskService(items: TaskListItem[]): TaskService {
  return {
    async listTasks() { return items; },
    async taskExists() { return true; },
  };
}

describe('GET /api/tasks — progress field shape', () => {
  it('passes through progress on a running task', async () => {
    const items: TaskListItem[] = [
      {
        id: 'task-running-1',
        status: 'running',
        priority: 'medium',
        description: 'running fixture',
        currentStage: 'architect',
        created: '2026-04-19T09:00:00Z',
        started: '2026-04-19T09:01:00Z',
        completed: null,
        progress: { total: 5, done: 2, current: 'Architect' },
      },
    ];
    const svc = makeStubTaskService(items);

    const res = makeMockRes();
    await handleTaskList(makeMockReq('/api/tasks'), res, svc);

    expect(res.statusCode).toBe(200);
    const body = parseBody<TaskListItem[]>(res);
    expect(body).toHaveLength(1);
    expect(body[0].progress).toBeDefined();
    expect(body[0].progress).toEqual({ total: 5, done: 2, current: 'Architect' });
  });

  it('omits progress on a done task', async () => {
    const items: TaskListItem[] = [
      {
        id: 'task-done-1',
        status: 'done',
        priority: 'medium',
        description: 'done fixture',
        currentStage: null,
        created: '2026-04-19T09:00:00Z',
        started: '2026-04-19T09:01:00Z',
        completed: '2026-04-19T09:30:00Z',
      },
    ];
    const svc = makeStubTaskService(items);

    const res = makeMockRes();
    await handleTaskList(makeMockReq('/api/tasks'), res, svc);

    expect(res.statusCode).toBe(200);
    const body = parseBody<TaskListItem[]>(res);
    expect(body[0].progress).toBeUndefined();
  });

  it('total reflects only role steps (orchestrator excluded by service)', async () => {
    // Stub asserts the field shape: total counts only role steps. The actual
    // exclusion happens in TaskServiceImpl.computeProgress (see task-progress.test.ts).
    // Here we verify the shape passes through when a stub returns total=5 from
    // a notional 6-step plan (orchestrator + 5 roles).
    const items: TaskListItem[] = [
      {
        id: 'task-running-orch',
        status: 'running',
        priority: 'medium',
        description: 'orch-fixture',
        currentStage: 'setup',
        created: '2026-04-19T09:00:00Z',
        started: '2026-04-19T09:01:00Z',
        completed: null,
        progress: { total: 5, done: 0, current: 'Setup' },
      },
    ];
    const svc = makeStubTaskService(items);

    const res = makeMockRes();
    await handleTaskList(makeMockReq('/api/tasks'), res, svc);

    const body = parseBody<TaskListItem[]>(res);
    expect(body[0].progress!.total).toBe(5);
    expect(body[0].progress!.current).toBe('Setup');
  });

  it('current === null when nothing is running and all role steps are done', async () => {
    const items: TaskListItem[] = [
      {
        id: 'task-running-tail',
        status: 'running',
        priority: 'medium',
        description: 'tail-fixture',
        currentStage: null,
        created: '2026-04-19T09:00:00Z',
        started: '2026-04-19T09:01:00Z',
        completed: null,
        progress: { total: 3, done: 3, current: null },
      },
    ];
    const svc = makeStubTaskService(items);

    const res = makeMockRes();
    await handleTaskList(makeMockReq('/api/tasks'), res, svc);

    const body = parseBody<TaskListItem[]>(res);
    expect(body[0].progress!.current).toBeNull();
  });
});
