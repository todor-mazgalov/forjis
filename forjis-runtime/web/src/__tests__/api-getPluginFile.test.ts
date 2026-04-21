/**
 * Unit tests for `getPluginFile` in the web-client shell API module.
 *
 * The helper is a thin `fetch` wrapper that maps response status codes to a
 * {@link FileFetchResult} discriminated union. The tests exercise each mapped
 * case in isolation by stubbing `globalThis.fetch` with a
 * {@link jest.fn}-backed mock. Pure TypeScript — no SolidJS, no DOM — so it
 * executes cleanly under Node + ts-jest without an environment shim (matches
 * the convention established by `role-id.test.ts`).
 *
 * Requirements covered:
 *   redesign-010 — `getPluginFile` status → kind mapping (design.md § D-3).
 */

import { jest } from '@jest/globals';
import {
  getPluginFile,
  type FileFetchResult,
} from '../../client/src/shell/api.js';

type FetchArgs = Parameters<typeof fetch>;
type FetchFn = (...args: FetchArgs) => Promise<Response>;

function installFetchMock(impl: FetchFn): jest.Mock<FetchFn> {
  const mock = jest.fn(impl) as unknown as jest.Mock<FetchFn>;
  (globalThis as unknown as { fetch: FetchFn }).fetch = mock as unknown as FetchFn;
  return mock;
}

function textResponse(body: string, init: ResponseInit = { status: 200 }): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

describe('getPluginFile', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test('URL-encodes the path argument', async () => {
    const mock = installFetchMock(async () => textResponse('hello'));
    await getPluginFile('a b/c.md');
    expect(mock).toHaveBeenCalledTimes(1);
    const url = String(mock.mock.calls[0]?.[0]);
    expect(url).toBe('/api/plugins/file?path=a%20b%2Fc.md');
  });

  test('returns ok with content on 200', async () => {
    installFetchMock(async () => textResponse('file-body'));
    const result: FileFetchResult = await getPluginFile('a.md');
    expect(result).toEqual({ ok: true, content: 'file-body' });
  });

  test('maps 400 to not-allowed', async () => {
    installFetchMock(async () => textResponse('', { status: 400 }));
    const result = await getPluginFile('../../../etc/passwd');
    expect(result).toEqual({ ok: false, kind: 'not-allowed' });
  });

  test('maps 404 to not-found', async () => {
    installFetchMock(async () => textResponse('', { status: 404 }));
    const result = await getPluginFile('missing.md');
    expect(result).toEqual({ ok: false, kind: 'not-found' });
  });

  test('maps 500 to unavailable', async () => {
    installFetchMock(async () => textResponse('', { status: 500 }));
    const result = await getPluginFile('a.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('maps 503 to unavailable', async () => {
    installFetchMock(async () => textResponse('', { status: 503 }));
    const result = await getPluginFile('a.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('thrown fetch resolves to unavailable', async () => {
    installFetchMock(async () => {
      throw new Error('network down');
    });
    const result = await getPluginFile('a.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });

  test('never throws even when the body reader rejects', async () => {
    const broken = {
      ok: true,
      status: 200,
      text: async (): Promise<string> => {
        throw new Error('decode failed');
      },
    } as unknown as Response;
    installFetchMock(async () => broken);
    const result = await getPluginFile('a.md');
    expect(result).toEqual({ ok: false, kind: 'unavailable' });
  });
});
