// Unit tests for src/lib/two_brain_client.ts. Stubs fetch — does not hit
// a real MCP server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveSearch,
  EXPECTED_QUERY_EMBEDDING_DIM,
  recordPick,
  type ArchiveMatch,
} from '../../src/lib/two_brain_client.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.TWO_BRAIN_MCP_URL = 'https://2ndbrain.test.example/mcp';
  process.env.TWO_BRAIN_MCP_TOKEN = 'tk-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

function makeEmbedding(): number[] {
  return new Array(EXPECTED_QUERY_EMBEDDING_DIM).fill(0.1);
}

function stubResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mcpResult(payload: unknown, opts: { isError?: boolean } = {}): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      ...(opts.isError ? { isError: true } : {}),
    },
  };
}

describe('archiveSearch', () => {
  it('throws on wrong-sized embedding (programmer error, not graceful)', async () => {
    await expect(
      archiveSearch([1, 2, 3], 5, {
        fetchFn: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/1536-dim/);
  });

  it('throws on non-positive top_k', async () => {
    await expect(
      archiveSearch(makeEmbedding(), 0, {
        fetchFn: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it('parses content[0].text and returns matches on happy path', async () => {
    const matches: ArchiveMatch[] = [
      {
        id: 'e1',
        title: 'Prior essay',
        url: 'https://example.com/e1',
        published_at: '2026-04-01T00:00:00Z',
        similarity: 0.87,
        type: 'essay',
      },
    ];
    const fakeFetch = vi.fn(async () => stubResponse(mcpResult(matches))) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual(matches);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('posts a JSON-RPC 2.0 tools/call envelope with bearer auth', async () => {
    let capturedUrl: string | URL = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: { jsonrpc?: string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {};
    const fakeFetch = (async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = url;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));
      return stubResponse(mcpResult([]));
    }) as unknown as typeof fetch;

    await archiveSearch(makeEmbedding(), 7, { fetchFn: fakeFetch });

    expect(String(capturedUrl)).toBe('https://2ndbrain.test.example/mcp');
    expect(capturedHeaders.authorization).toBe('Bearer tk-test');
    expect(capturedBody.jsonrpc).toBe('2.0');
    expect(capturedBody.method).toBe('tools/call');
    expect(capturedBody.params?.name).toBe('archive_search');
    expect(capturedBody.params?.arguments?.top_k).toBe(7);
    expect((capturedBody.params?.arguments?.query_embedding as number[]).length).toBe(
      EXPECTED_QUERY_EMBEDDING_DIM,
    );
  });

  it('retries transient network failures and succeeds on a later attempt', async () => {
    // Speed up the backoff sleeps so the test isn't waiting ~3.5s of real time.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let attempt = 0;
    const fakeFetch = (async (): Promise<Response> => {
      attempt += 1;
      if (attempt < 3) throw new TypeError('fetch failed');
      return stubResponse(mcpResult([]));
    }) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
    expect(attempt).toBe(3);
  });

  it('degrades to [] after MAX_ATTEMPTS consecutive transient failures', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let attempt = 0;
    const fakeFetch = (async (): Promise<Response> => {
      attempt += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
    expect(attempt).toBe(3);
  });

  it('fails fast on HTTP 401 (no retry — token is wrong)', async () => {
    let attempt = 0;
    const fakeFetch = (async (): Promise<Response> => {
      attempt += 1;
      return new Response('unauthorised', { status: 401 });
    }) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
    expect(attempt).toBe(1);
  });

  it('fails fast on RPC -32602 (unknown tool — server is missing archive_search)', async () => {
    let attempt = 0;
    const fakeFetch = (async (): Promise<Response> => {
      attempt += 1;
      return stubResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'Unknown tool: archive_search' },
      });
    }) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
    expect(attempt).toBe(1);
  });

  it('degrades to [] when TWO_BRAIN_MCP_URL is unset (no fetch call at all)', async () => {
    delete process.env.TWO_BRAIN_MCP_URL;
    const fakeFetch = vi.fn() as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('degrades to [] when TWO_BRAIN_MCP_TOKEN is unset', async () => {
    delete process.env.TWO_BRAIN_MCP_TOKEN;
    const fakeFetch = vi.fn() as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('degrades to [] when result content shape is unexpected', async () => {
    const fakeFetch = (async (): Promise<Response> =>
      stubResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [] },
      })) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
  });

  it('degrades to [] when tool returns isError=true', async () => {
    const fakeFetch = (async (): Promise<Response> =>
      stubResponse(mcpResult('boom', { isError: true }))) as unknown as typeof fetch;

    const result = await archiveSearch(makeEmbedding(), 5, { fetchFn: fakeFetch });

    expect(result).toEqual([]);
  });
});

describe('recordPick', () => {
  const candidate = {
    headline: 'Why X matters',
    context: 'New paper shows...',
    domain: 'AI/CS',
    keywords: ['rlhf', 'alignment'],
    tags: ['paper', 'safety'],
    urls: ['https://example.com/paper'],
  };

  it('returns {ok:true} on happy path', async () => {
    const fakeFetch = (async (): Promise<Response> =>
      stubResponse(mcpResult({ ok: true }))) as unknown as typeof fetch;

    const result = await recordPick(candidate, 'pick', 'looks novel', {
      fetchFn: fakeFetch,
    });

    expect(result).toEqual({ ok: true });
  });

  it('omits reason from arguments when undefined', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      capturedArgs = body.params.arguments;
      return stubResponse(mcpResult({ ok: true }));
    }) as unknown as typeof fetch;

    await recordPick(candidate, 'pass', undefined, { fetchFn: fakeFetch });

    expect(capturedArgs).toEqual({ candidate, decision: 'pass' });
    expect('reason' in capturedArgs).toBe(false);
  });

  it('includes reason when supplied (including empty string)', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      capturedArgs = body.params.arguments;
      return stubResponse(mcpResult({ ok: true }));
    }) as unknown as typeof fetch;

    await recordPick(candidate, 'defer', '', { fetchFn: fakeFetch });

    expect(capturedArgs.reason).toBe('');
  });

  it('degrades to {ok:false} on permanent failure (no throw)', async () => {
    const fakeFetch = (async (): Promise<Response> =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch;

    const result = await recordPick(candidate, 'pick', undefined, {
      fetchFn: fakeFetch,
    });

    expect(result).toEqual({ ok: false });
  });

  it('degrades to {ok:false} when env is unconfigured (no fetch call)', async () => {
    delete process.env.TWO_BRAIN_MCP_URL;
    const fakeFetch = vi.fn() as unknown as typeof fetch;

    const result = await recordPick(candidate, 'pick', undefined, {
      fetchFn: fakeFetch,
    });

    expect(result).toEqual({ ok: false });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
