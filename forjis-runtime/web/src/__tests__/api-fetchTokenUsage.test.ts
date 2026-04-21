/**
 * Unit tests for `fetchTokenUsage` in the web-client shell API module.
 *
 * The helper mirrors the errors-to-null contract shared by `fetchConfig`,
 * `getTasks`, `getPlan`, and `getResources`: a 2xx response parses JSON and
 * returns the payload; every non-2xx status, network failure, or JSON parse
 * failure resolves to `null`. Never throws.
 *
 * Pure TypeScript — no SolidJS, no DOM — so the suite runs cleanly under
 * Node + ts-jest without an environment shim, following the convention from
 * `api-getPluginFile.test.ts`.
 *
 * Requirements covered (redesign-011 spec.md):
 *   FR — Errors-to-null client helper for token usage.
 */

import { jest } from '@jest/globals';
import { fetchTokenUsage } from '../../client/src/shell/api.js';
import type { TokenUsageResponse } from '../../../shared/src/types.js';

type FetchArgs = Parameters<typeof fetch>;
type FetchFn = (...args: FetchArgs) => Promise<Response>;

function installFetchMock(impl: FetchFn): jest.Mock<FetchFn> {
  const mock = jest.fn(impl) as unknown as jest.Mock<FetchFn>;
  (globalThis as unknown as { fetch: FetchFn }).fetch = mock as unknown as FetchFn;
  return mock;
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchTokenUsage', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  test('hits the /api/token-usage endpoint', async () => {
    const usage: TokenUsageResponse = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      windowStartedAt: '2026-04-19T00:00:00.000Z',
      lastUpdatedAt: '2026-04-19T00:00:00.000Z',
      budget: null,
    };
    const mock = installFetchMock(async () => jsonResponse(usage));
    await fetchTokenUsage();
    expect(mock).toHaveBeenCalledTimes(1);
    const url = String(mock.mock.calls[0]?.[0]);
    expect(url).toBe('/api/token-usage');
  });

  test('returns the parsed payload on 200 with budget=null', async () => {
    const usage: TokenUsageResponse = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      windowStartedAt: '2026-04-19T00:00:00.000Z',
      lastUpdatedAt: '2026-04-19T00:05:00.000Z',
      budget: null,
    };
    installFetchMock(async () => jsonResponse(usage));
    const result = await fetchTokenUsage();
    expect(result).toEqual(usage);
  });

  test('returns the parsed payload on 200 with a configured budget', async () => {
    const usage: TokenUsageResponse = {
      inputTokens: 10_000,
      outputTokens: 2_000,
      totalTokens: 12_000,
      windowStartedAt: '2026-04-19T00:00:00.000Z',
      lastUpdatedAt: '2026-04-19T00:15:00.000Z',
      budget: { maxTokens: 100_000, resetWindowMs: 3_600_000 },
    };
    installFetchMock(async () => jsonResponse(usage));
    const result = await fetchTokenUsage();
    expect(result).not.toBeNull();
    expect(result!.totalTokens).toBe(12_000);
    expect(result!.budget).toEqual({
      maxTokens: 100_000,
      resetWindowMs: 3_600_000,
    });
  });

  test('resolves to null on HTTP 503', async () => {
    installFetchMock(async () => jsonResponse({}, { status: 503 }));
    const result = await fetchTokenUsage();
    expect(result).toBeNull();
  });

  test('resolves to null on HTTP 500', async () => {
    installFetchMock(async () => jsonResponse({}, { status: 500 }));
    const result = await fetchTokenUsage();
    expect(result).toBeNull();
  });

  test('resolves to null on HTTP 404', async () => {
    installFetchMock(async () => jsonResponse({}, { status: 404 }));
    const result = await fetchTokenUsage();
    expect(result).toBeNull();
  });

  test('resolves to null when fetch throws (network failure)', async () => {
    installFetchMock(async () => {
      throw new Error('network down');
    });
    const result = await fetchTokenUsage();
    expect(result).toBeNull();
  });

  test('resolves to null when JSON parse fails', async () => {
    const broken = {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new Error('malformed JSON');
      },
    } as unknown as Response;
    installFetchMock(async () => broken);
    const result = await fetchTokenUsage();
    expect(result).toBeNull();
  });

  test('never throws across every failure mode', async () => {
    // Each mock exhibits a distinct failure mode. The caller's contract is
    // that `fetchTokenUsage` only resolves to either a payload or `null`.
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({}, { status: 500 }),
      async () => jsonResponse({}, { status: 503 }),
      async () => {
        throw new Error('boom');
      },
    ];
    for (const impl of cases) {
      installFetchMock(impl);
      // `.toBeNull()` — never throws — across every arm.
      await expect(fetchTokenUsage()).resolves.toBeNull();
    }
  });
});
