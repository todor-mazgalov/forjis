/**
 * Unit tests for `getTaskFile` in the web-client shell API module.
 *
 * Mirrors `api-getPluginFile.test.ts` but exercises the JSON-envelope
 * endpoint: `GET /api/tasks/:id/task-file?path=…` returns
 * `{ content: string }` on 200, and the helper unwraps it. Adds an extra
 * case for malformed JSON / missing `content` field which has no
 * counterpart in the plugin-file helper.
 *
 * Requirements covered:
 *   redesign-010 — `getTaskFile` status → kind mapping + envelope unwrap
 *   (design.md § D-3).
 */

import { jest } from '@jest/globals';
import { getTaskFile } from '../../client/src/shell/api.js';

type FetchArgs = Parameters<typeof fetch>;
type FetchFn = (...args: FetchArgs) => Promise<Response>;

function installFetchMock(impl: FetchFn): jest.Mock<FetchFn> {
  const mock = jest.fn(impl) as unknown as jest.Mock<FetchFn>;
  (globalThis as unknown as { fetch: FetchFn }).fetch = mock as unknown as FetchFn;
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response('', { status });
}

describe('getTaskFile', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test('URL-encodes both taskId and path', async () => {
    const mock = installFetchMock(async () =>
      jsonResponse({ content: 'x' }),
    );
    await getTaskFile('task 1/!', 'a b.md');
    expect(mock).toHaveBeenCalledTimes(1);
    const url = String(mock.mock.calls[0]?.[0]);
    expect(url).toBe('/api/tasks/task%201%2F!/task-file?path=a%20b.md');
  });

  test('returns ok with content on 200 when envelope is well-formed', async () => {
    installFetchMock(async () => jsonResponse({ content: 'hello' }));
    const result = await getTaskFile('t1', 'TASK.md');
    expect(result).toEqual({ ok: true, content: 'hello' });
  });

  test('maps 400 to not-allowed', async () => {
    installFetchMock(async () => emptyResponse(400));
    const result = await getTaskFile('t1', '..');
    expect(result).toEqual({ ok: false, kind: 'not-allowed' });
  });

  test('maps 404 to not-found', async () => {
    installFetchMock(async () => emptyResponse(404));
    const result = await getTaskFile('t1', 'missing.md');
    expect(result).toEqual({ ok: false, kind: 'not-found' });
  });

  test('maps 500 to unavailable', async () => {
    installFetchMock(async () => emptyResponse(500));
    const result = await getTaskFile('t1', 'TASK.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('malformed JSON resolves to unavailable', async () => {
    const broken = new Response('{not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    installFetchMock(async () => broken);
    const result = await getTaskFile('t1', 'TASK.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('missing `content` field resolves to unavailable', async () => {
    installFetchMock(async () => jsonResponse({ notContent: 'x' }));
    const result = await getTaskFile('t1', 'TASK.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('non-string `content` field resolves to unavailable', async () => {
    installFetchMock(async () => jsonResponse({ content: 42 }));
    const result = await getTaskFile('t1', 'TASK.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('thrown fetch resolves to unavailable', async () => {
    installFetchMock(async () => {
      throw new Error('offline');
    });
    const result = await getTaskFile('t1', 'TASK.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });
});
