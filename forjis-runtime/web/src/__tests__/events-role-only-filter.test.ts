/**
 * Contract tests for the GET /api/tasks/:id/events role-only filter dispatch
 * (Phase L6 of redesign-013-api-contract-extensions).
 *
 * Asserts the controller's three-way dispatch on (team, role) query pairs:
 *   - team && role         -> getEventsForRole (existing, regression check)
 *   - role && !team        -> getEventsByRole  (NEW)
 *   - neither              -> getEvents         (existing)
 *
 * Plus a real-disk end-to-end check via EventServiceImpl wired through
 * handleEvents that `?role=orchestrator` returns events scoped to
 * `event.role === 'orchestrator'` from `events.jsonl`, and that `?since=`
 * still narrows the role-only result.
 *
 * The backend-layer-only `getEventsByRole` substrate is asserted by
 * `event-service-role-filter.test.ts`. This file focuses on the controller
 * + router wiring.
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleEvents } from '../controllers.js';
import type { EventService, TaskService } from '../services.js';
import type { TaskEvent } from '../types.js';
import { EventServiceImpl } from '@forjis/facilitator';

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

const stubTaskService: TaskService = {
  async listTasks() { return []; },
  async taskExists() { return true; },
};

interface SpyEventService extends EventService {
  calls: { method: string; args: unknown[] }[];
}

function makeSpyEventService(): SpyEventService {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    async getEvents(...args: unknown[]) {
      calls.push({ method: 'getEvents', args });
      return [];
    },
    async getEventsSince(...args: unknown[]) {
      calls.push({ method: 'getEventsSince', args });
      return [];
    },
    async getEventsForRole(...args: unknown[]) {
      calls.push({ method: 'getEventsForRole', args });
      return [];
    },
    async getEventsByRole(...args: unknown[]) {
      calls.push({ method: 'getEventsByRole', args });
      return [];
    },
  } as unknown as SpyEventService;
}

describe('handleEvents three-way dispatch on (team, role)', () => {
  it('?org=acme&team=dev&role=Explorer -> getEventsForRole', async () => {
    // fix-roles-display: the role-scoped file now keys on the full
    // {org, team, role} identity triple, so the controller routes to
    // getEventsForRole only when all three query params are present.
    const svc = makeSpyEventService();
    const res = makeMockRes();
    await handleEvents(
      makeMockReq('/api/tasks/t-1/events?org=acme&team=dev&role=Explorer'),
      res,
      't-1',
      stubTaskService,
      svc,
    );
    expect(res.statusCode).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].method).toBe('getEventsForRole');
    expect(svc.calls[0].args).toEqual([
      't-1',
      { org: 'acme', team: 'dev', role: 'Explorer' },
      undefined,
    ]);
  });

  it('?role=orchestrator (no team) -> getEventsByRole', async () => {
    const svc = makeSpyEventService();
    const res = makeMockRes();
    await handleEvents(
      makeMockReq('/api/tasks/t-2/events?role=orchestrator'),
      res,
      't-2',
      stubTaskService,
      svc,
    );
    expect(res.statusCode).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].method).toBe('getEventsByRole');
    expect(svc.calls[0].args).toEqual(['t-2', 'orchestrator', undefined]);
  });

  it('no team and no role -> getEvents', async () => {
    const svc = makeSpyEventService();
    const res = makeMockRes();
    await handleEvents(
      makeMockReq('/api/tasks/t-3/events'),
      res,
      't-3',
      stubTaskService,
      svc,
    );
    expect(res.statusCode).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].method).toBe('getEvents');
    expect(svc.calls[0].args).toEqual(['t-3', undefined]);
  });

  it('?team=dev (no role) -> getEvents (team-only is treated as unfiltered)', async () => {
    const svc = makeSpyEventService();
    const res = makeMockRes();
    await handleEvents(
      makeMockReq('/api/tasks/t-4/events?team=dev'),
      res,
      't-4',
      stubTaskService,
      svc,
    );
    expect(res.statusCode).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].method).toBe('getEvents');
  });

  it('?since=<old>&role=orchestrator forwards since to getEventsByRole', async () => {
    const svc = makeSpyEventService();
    const res = makeMockRes();
    const since = '2026-04-19T09:00:00Z';
    await handleEvents(
      makeMockReq(`/api/tasks/t-5/events?since=${encodeURIComponent(since)}&role=orchestrator`),
      res,
      't-5',
      stubTaskService,
      svc,
    );
    expect(res.statusCode).toBe(200);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].method).toBe('getEventsByRole');
    expect(svc.calls[0].args).toEqual(['t-5', 'orchestrator', since]);
  });

  it('rejects an invalid since value with 400', async () => {
    const svc = makeSpyEventService();
    const res = makeMockRes();
    await handleEvents(
      makeMockReq('/api/tasks/t-6/events?since=not-a-date&role=orchestrator'),
      res,
      't-6',
      stubTaskService,
      svc,
    );
    expect(res.statusCode).toBe(400);
    expect(svc.calls).toHaveLength(0);
  });
});

describe('handleEvents end-to-end with EventServiceImpl on real disk', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'forjis-evt-role-api-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function setupTaskDir(taskId: string): Promise<string> {
    const dir = join(projectDir, '.forjis', 'tasks', taskId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function jsonl(events: TaskEvent[]): string {
    return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  it('?role=orchestrator returns events.jsonl entries with role==="orchestrator"', async () => {
    const taskId = 'task-evt-orch';
    const dir = await setupTaskDir(taskId);
    await writeFile(join(dir, 'events.jsonl'), jsonl([
      { timestamp: '2026-04-19T10:00:00Z', type: 'system', role: 'orchestrator', content: 'orch started' },
    ]), 'utf-8');
    await writeFile(join(dir, 'events-dev-explorer.jsonl'), jsonl([
      { timestamp: '2026-04-19T10:01:00Z', type: 'assistant', role: 'Explorer', content: 'exploring' },
    ]), 'utf-8');

    const svc = new EventServiceImpl(projectDir);
    const res = makeMockRes();
    await handleEvents(
      makeMockReq(`/api/tasks/${taskId}/events?role=orchestrator`),
      res,
      taskId,
      stubTaskService,
      svc,
    );

    expect(res.statusCode).toBe(200);
    const body = parseBody<TaskEvent[]>(res);
    expect(body).toHaveLength(1);
    expect(body[0].role).toBe('orchestrator');
    expect(body[0].content).toBe('orch started');
  });

  it('?role=Unknown returns []', async () => {
    const taskId = 'task-evt-unknown';
    const dir = await setupTaskDir(taskId);
    await writeFile(join(dir, 'events.jsonl'), jsonl([
      { timestamp: '2026-04-19T10:00:00Z', type: 'system', role: 'orchestrator', content: 'x' },
    ]), 'utf-8');

    const svc = new EventServiceImpl(projectDir);
    const res = makeMockRes();
    await handleEvents(
      makeMockReq(`/api/tasks/${taskId}/events?role=Unknown`),
      res,
      taskId,
      stubTaskService,
      svc,
    );

    expect(res.statusCode).toBe(200);
    const body = parseBody<TaskEvent[]>(res);
    expect(body).toEqual([]);
  });
});
