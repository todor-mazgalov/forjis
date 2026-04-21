/**
 * Contract tests for the GET /api/tasks/:id/plan response shape (Phase L2 of
 * redesign-013-api-contract-extensions).
 *
 * Asserts the wire-level shape that the dashboard consumes:
 *   - steps[0].kind === 'orchestrator', steps[0].deps === [].
 *   - Every steps[i] for i > 0 carries a `deps` array of length >= 1.
 *   - The first non-orchestrator step's deps is ['orchestrator'].
 *   - Subsequent role steps' deps is the previous step's role
 *     (linear-chain assertion that mirrors plan-writer's derivation).
 *
 * The plan-writer-side derivation (yaml -> PipelinePlanResponse) is asserted
 * by `plan-writer-deps.test.ts`. This file focuses on the controller passing
 * the shape through unchanged.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handlePlan } from '../controllers.js';
import type { TaskService, PlanService } from '../services.js';
import type { PipelinePlanResponse } from '../types.js';

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

function makeStubPlanService(plan: PipelinePlanResponse): PlanService {
  return {
    async getPlan() { return plan; },
  };
}

describe('GET /api/tasks/:id/plan — orchestrator step + deps shape', () => {
  it('passes through the synthetic orchestrator step at index 0', async () => {
    const plan: PipelinePlanResponse = {
      taskId: 'task-1',
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        {
          role: 'orchestrator',
          agent: '',
          status: 'running',
          description: 'Pipeline orchestrator',
          kind: 'orchestrator',
          deps: [],
        },
        {
          role: 'Explorer',
          agent: 'forjis-explorer',
          status: 'planned',
          description: 'Explore',
          deps: ['orchestrator'],
        },
        {
          role: 'Architect',
          agent: 'forjis-architect',
          status: 'planned',
          description: 'Design',
          deps: ['Explorer'],
        },
      ],
    };

    const req = makeMockReq('/api/tasks/task-1/plan');
    const res = makeMockRes();
    await handlePlan(req, res, 'task-1', stubTaskService, makeStubPlanService(plan));

    expect(res.statusCode).toBe(200);
    const body = parseBody<PipelinePlanResponse>(res);
    expect(body.steps[0].kind).toBe('orchestrator');
    expect(body.steps[0].role).toBe('orchestrator');
    expect(body.steps[0].deps).toEqual([]);
  });

  it('passes through deps on every non-orchestrator step', async () => {
    const plan: PipelinePlanResponse = {
      taskId: 'task-2',
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { role: 'orchestrator', agent: '', status: 'running', description: 'orch', kind: 'orchestrator', deps: [] },
        { role: 'Explorer', agent: 'forjis-explorer', status: 'planned', description: 'Explore', deps: ['orchestrator'] },
        { role: 'Analyst', agent: 'forjis-analyst', status: 'skipped', description: 'Analyze', deps: ['Explorer'] },
        { role: 'Architect', agent: 'forjis-architect', status: 'planned', description: 'Design', deps: ['Analyst'] },
        { role: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Build', deps: ['Architect'] },
      ],
    };

    const req = makeMockReq('/api/tasks/task-2/plan');
    const res = makeMockRes();
    await handlePlan(req, res, 'task-2', stubTaskService, makeStubPlanService(plan));

    expect(res.statusCode).toBe(200);
    const body = parseBody<PipelinePlanResponse>(res);
    for (let i = 1; i < body.steps.length; i++) {
      expect(Array.isArray(body.steps[i].deps)).toBe(true);
      expect((body.steps[i].deps ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('first non-orchestrator step deps === ["orchestrator"]', async () => {
    const plan: PipelinePlanResponse = {
      taskId: 'task-3',
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { role: 'orchestrator', agent: '', status: 'running', description: 'orch', kind: 'orchestrator', deps: [] },
        { role: 'Setup', agent: 'forjis-setup', status: 'planned', description: 'Setup', deps: ['orchestrator'] },
        { role: 'Developer', agent: 'forjis-developer', status: 'planned', description: 'Build', deps: ['Setup'] },
      ],
    };

    const req = makeMockReq('/api/tasks/task-3/plan');
    const res = makeMockRes();
    await handlePlan(req, res, 'task-3', stubTaskService, makeStubPlanService(plan));

    const body = parseBody<PipelinePlanResponse>(res);
    expect(body.steps[1].deps).toEqual(['orchestrator']);
  });

  it('subsequent role steps deps === [previousStep.role] (linear chain)', async () => {
    const plan: PipelinePlanResponse = {
      taskId: 'task-4',
      orgName: 'my-org',
      teamName: 'default',
      status: 'ready',
      steps: [
        { role: 'orchestrator', agent: '', status: 'running', description: 'orch', kind: 'orchestrator', deps: [] },
        { role: 'A', agent: 'a', status: 'planned', description: '', deps: ['orchestrator'] },
        { role: 'B', agent: 'b', status: 'planned', description: '', deps: ['A'] },
        { role: 'C', agent: 'c', status: 'planned', description: '', deps: ['B'] },
        { role: 'D', agent: 'd', status: 'planned', description: '', deps: ['C'] },
      ],
    };

    const req = makeMockReq('/api/tasks/task-4/plan');
    const res = makeMockRes();
    await handlePlan(req, res, 'task-4', stubTaskService, makeStubPlanService(plan));

    const body = parseBody<PipelinePlanResponse>(res);
    expect(body.steps[2].deps).toEqual(['A']);
    expect(body.steps[3].deps).toEqual(['B']);
    expect(body.steps[4].deps).toEqual(['C']);
  });
});
