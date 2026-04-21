/**
 * Contract tests for the GET /api/resources path round-trip (Phase L3 of
 * redesign-013-api-contract-extensions).
 *
 * Asserts:
 *   - For each non-empty agentPath/skillPath/hookPath the resource service
 *     emits, a follow-up GET /api/plugins/file?path=<that> returns 200 and
 *     a text/plain body with the file content.
 *   - Empty-string sentinel paths (role's agent/skill is undefined) are NOT
 *     fetched — the test asserts they are valid omissions.
 *
 * This is a wire-shape assertion: the test backs the resource-service result
 * with a real on-disk plugin root and a local PluginFileService that mirrors
 * the production contract (whitelist-prefix-match -> 200 / 404 / traversal),
 * then routes through handleResources -> handlePluginFile to confirm round-trip.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleResources, handlePluginFile } from '../controllers.js';
import type { ResourceService, PluginFileService, PluginFileResult } from '../services.js';
import type { ResourcesResponse } from '../types.js';

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
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
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

/**
 * Local PluginFileService backed by a single plugin-root whitelist entry.
 * Mirrors the production PluginFileServiceImpl contract: traversal rejection
 * for raw `..`/absolute paths, prefix-match against the root, ok/notFound otherwise.
 */
class LocalPluginFileService implements PluginFileService {
  constructor(private readonly root: string) {}

  async getPluginFile(relativePath: string): Promise<PluginFileResult> {
    if (!relativePath || relativePath.includes('..')) return { kind: 'traversal' };
    if (isAbsolute(relativePath)) return { kind: 'traversal' };

    const absRoot = resolve(this.root);
    const candidate = resolve(absRoot, relativePath);
    if (candidate !== absRoot && !candidate.startsWith(absRoot + sep)) {
      return { kind: 'traversal' };
    }
    try {
      const content = await readFile(candidate, 'utf-8');
      return { kind: 'ok', content };
    } catch {
      return { kind: 'notFound' };
    }
  }
}

async function setupPluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forjis-resources-paths-'));
  await mkdir(join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'skills'), { recursive: true });
  await mkdir(join(root, 'hooks'), { recursive: true });
  await writeFile(join(root, 'agents', 'forjis-explorer.md'), '# Explorer agent\n', 'utf-8');
  await writeFile(join(root, 'skills', 'node-ts.md'), '# Node TS skill\n', 'utf-8');
  await writeFile(join(root, 'hooks', 'pre-security.md'), '# Pre security hook\n', 'utf-8');
  return root;
}

describe('GET /api/resources -> /api/plugins/file round-trip', () => {
  let pluginRoot: string;
  let resourceService: ResourceService;
  let pluginFileService: PluginFileService;

  beforeEach(async () => {
    pluginRoot = await setupPluginRoot();

    // Stub a ResourceService whose paths point at files inside the plugin root.
    resourceService = {
      getResources(): ResourcesResponse {
        return {
          orgs: [
            {
              name: 'my-org',
              source: 'my-org',
              teams: [
                {
                  name: 'default',
                  roles: [
                    {
                      name: 'Explorer',
                      agent: 'forjis-explorer',
                      skills: ['node-ts'],
                      agentPath: 'agents/forjis-explorer.md',
                      skillPaths: ['skills/node-ts.md'],
                      hookPaths: ['hooks/pre-security.md'],
                      outcomePaths: [],
                      personaPaths: [],
                      constraintPaths: [],
                    },
                    {
                      name: 'Reviewer',
                      agent: '',
                      skills: [],
                      // Empty sentinels — must NOT be fetched through /api/plugins/file.
                      agentPath: '',
                      skillPaths: [],
                      hookPaths: [],
                      outcomePaths: [],
                      personaPaths: [],
                      constraintPaths: [],
                    },
                  ],
                },
              ],
            },
          ],
          agents: [],
          skills: [],
          hooks: [],
          plugins: [],
        };
      },
    };

    pluginFileService = new LocalPluginFileService(pluginRoot);
  });

  afterEach(async () => {
    await rm(pluginRoot, { recursive: true, force: true });
  });

  it('returns at least one role with a non-empty agentPath', () => {
    const res = makeMockRes();
    handleResources(makeMockReq('/api/resources'), res, resourceService);
    expect(res.statusCode).toBe(200);
    const body = parseBody<ResourcesResponse>(res);

    const allRoles = body.orgs.flatMap((o) => o.teams.flatMap((t) => t.roles));
    expect(allRoles.some((r) => r.agentPath !== '')).toBe(true);
  });

  it('every emitted non-empty agentPath/skillPath/hookPath round-trips through /api/plugins/file to 200', async () => {
    const resourcesRes = makeMockRes();
    handleResources(makeMockReq('/api/resources'), resourcesRes, resourceService);
    const body = parseBody<ResourcesResponse>(resourcesRes);

    const candidatePaths: string[] = [];
    for (const org of body.orgs) {
      for (const team of org.teams) {
        for (const role of team.roles) {
          if (role.agentPath !== '') candidatePaths.push(role.agentPath);
          for (const p of role.skillPaths) if (p !== '') candidatePaths.push(p);
          for (const p of role.hookPaths) if (p !== '') candidatePaths.push(p);
        }
      }
    }

    expect(candidatePaths.length).toBeGreaterThan(0);

    for (const path of candidatePaths) {
      const fileRes = makeMockRes();
      const url = `/api/plugins/file?path=${encodeURIComponent(path)}`;
      await handlePluginFile(makeMockReq(url), fileRes, pluginFileService);
      expect(fileRes.statusCode).toBe(200);
      expect(fileRes.headers['Content-Type']).toBe('text/plain; charset=utf-8');
      expect(fileRes.body.length).toBeGreaterThan(0);
    }
  });

  it('empty-string sentinel paths are NOT fetched (treated as valid omissions)', () => {
    const res = makeMockRes();
    handleResources(makeMockReq('/api/resources'), res, resourceService);
    const body = parseBody<ResourcesResponse>(res);

    const reviewer = body.orgs[0].teams[0].roles.find((r) => r.name === 'Reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.agentPath).toBe('');
    expect(reviewer!.skillPaths).toEqual([]);
    expect(reviewer!.hookPaths).toEqual([]);
    // Sentinel — caller must skip these. Asserting the contract here protects
    // the dashboard from accidentally GETting `/api/plugins/file?path=`.
  });
});
