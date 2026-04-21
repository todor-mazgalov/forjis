/**
 * Contract tests for the GET /api/tasks/:id/manifest endpoint after a
 * recorded write (Phase L4 of redesign-013-api-contract-extensions).
 *
 * Asserts the wire shape end-to-end:
 *   - After a single appendManifestEntry call, the manifest endpoint returns
 *     a non-empty `files` array with role/path/label/createdAt fields.
 *   - Two recorder calls with the same (role, path) produce ONE entry, not two
 *     (in-process dedupe).
 *
 * Pattern: real temp project dir + the BackendDev recorder + ManifestServiceImpl
 * routed through handleManifest.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleManifest } from '../controllers.js';
import type { TaskService } from '../services.js';
import type { ManifestResponse } from '../types.js';
import { appendManifestEntry, __resetSeen, ManifestServiceImpl } from '@forjis/facilitator';

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

describe('GET /api/tasks/:id/manifest after a recorded write', () => {
  let projectDir: string;

  beforeEach(async () => {
    __resetSeen();
    projectDir = await mkdtemp(join(tmpdir(), 'forjis-manifest-api-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns a single entry after one appendManifestEntry call', async () => {
    const taskId = 'task-m-1';
    const written = await appendManifestEntry(
      projectDir,
      taskId,
      'Explorer',
      join(projectDir, 'openspec', 'changes', taskId, 'exploration.md'),
      undefined,
      '2026-04-19T10:00:00Z',
    );
    expect(written).toBe(true);

    const svc = new ManifestServiceImpl(projectDir);
    const res = makeMockRes();
    await handleManifest(
      makeMockReq(`/api/tasks/${taskId}/manifest`),
      res,
      taskId,
      stubTaskService,
      svc,
    );

    expect(res.statusCode).toBe(200);
    const body = parseBody<ManifestResponse>(res);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      role: 'Explorer',
      path: 'openspec/changes/task-m-1/exploration.md',
      label: 'exploration.md',
      createdAt: '2026-04-19T10:00:00Z',
    });
  });

  it('two recorder calls with same (role, path) produce ONE entry', async () => {
    const taskId = 'task-m-2';
    await appendManifestEntry(
      projectDir, taskId, 'Developer',
      join(projectDir, 'src', 'foo.ts'),
      undefined, '2026-04-19T10:00:00Z',
    );
    const second = await appendManifestEntry(
      projectDir, taskId, 'Developer',
      join(projectDir, 'src', 'foo.ts'),
    );
    expect(second).toBe(false);

    const svc = new ManifestServiceImpl(projectDir);
    const res = makeMockRes();
    await handleManifest(
      makeMockReq(`/api/tasks/${taskId}/manifest`),
      res,
      taskId,
      stubTaskService,
      svc,
    );

    expect(res.statusCode).toBe(200);
    const body = parseBody<ManifestResponse>(res);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe('src/foo.ts');
  });

  it('returns 503 when manifestService is not configured', async () => {
    const res = makeMockRes();
    await handleManifest(
      makeMockReq('/api/tasks/task-m-3/manifest'),
      res,
      'task-m-3',
      stubTaskService,
      undefined,
    );
    expect(res.statusCode).toBe(503);
  });
});
