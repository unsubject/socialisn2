// Unit tests for src/lib/embeddings.ts. Stubs fetch.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { embed } from '../../src/lib/embeddings.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function fakeVec(seed: number): number[] {
  // Stand-in for a 1536-dim vector — use 4 dims for test brevity.
  return [seed, seed + 1, seed + 2, seed + 3];
}

describe('embed', () => {
  it('returns empty arrays for empty inputs array without making a request', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;

    const result = await embed({ inputs: [], fetchFn: fakeFetch });
    expect(result).toEqual({ vectors: [], inputTokens: 0, usd: 0 });
    expect(called).toBe(false);
  });

  it('parses vectors in input order even when API returns them shuffled', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            // Out-of-order on purpose.
            { embedding: fakeVec(20), index: 1 },
            { embedding: fakeVec(10), index: 0 },
          ],
          usage: { prompt_tokens: 50, total_tokens: 50 },
          model: 'text-embedding-3-small',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await embed({ inputs: ['a', 'b'], fetchFn: fakeFetch });
    expect(result.vectors).toEqual([fakeVec(10), fakeVec(20)]);
    expect(result.inputTokens).toBe(50);
    // 50 * 0.02/1M = 1e-6
    expect(result.usd).toBeCloseTo(1e-6, 12);
  });

  it('throws with HTTP code on non-2xx', async () => {
    const fakeFetch = (async () =>
      new Response('rate-limited', { status: 429 })) as unknown as typeof fetch;

    await expect(embed({ inputs: ['x'], fetchFn: fakeFetch })).rejects.toThrow(/HTTP 429/);
  });

  it('filters out empty-string inputs from the API call but keeps slots aligned', async () => {
    let capturedBody: { input?: string[] } = {};
    let called = false;
    const fakeFetch = (async (
      _url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      called = true;
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          data: [{ embedding: fakeVec(1), index: 0 }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
          model: 'text-embedding-3-small',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await embed({ inputs: ['', 'real', ''], fetchFn: fakeFetch });
    expect(called).toBe(true);
    // Sent only the non-empty value.
    expect(capturedBody.input).toEqual(['real']);
    // Returned vectors array is index-aligned to inputs.
    expect(result.vectors).toEqual([null, fakeVec(1), null]);
  });

  it('aligns shuffled API response back to input positions when some inputs are empty', async () => {
    // Inputs: ['', 'a', '', 'b']. Non-empty are at indices 1 and 3.
    // API sees ['a','b'] → returns data with index 0, 1 (possibly shuffled).
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: fakeVec(20), index: 1 },
            { embedding: fakeVec(10), index: 0 },
          ],
          usage: { prompt_tokens: 12, total_tokens: 12 },
          model: 'text-embedding-3-small',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await embed({ inputs: ['', 'a', '', 'b'], fetchFn: fakeFetch });
    expect(result.vectors).toEqual([null, fakeVec(10), null, fakeVec(20)]);
  });

  it('short-circuits when ALL inputs are empty strings — returns aligned nulls', async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;

    const result = await embed({ inputs: ['', '', ''], fetchFn: fakeFetch });
    expect(called).toBe(false);
    expect(result).toEqual({ vectors: [null, null, null], inputTokens: 0, usd: 0 });
  });

  it('propagates an already-aborted external signal', async () => {
    const fakeFetch = (async (
      _url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      embed({ inputs: ['hi'], fetchFn: fakeFetch, signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  it('rejects when fetch itself rejects (network failure)', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(embed({ inputs: ['hi'], fetchFn: fakeFetch })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it('posts to the OpenAI embeddings endpoint with bearer auth', async () => {
    let capturedUrl: string | URL = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;
    const fakeFetch = (async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = url;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          data: [{ embedding: fakeVec(1), index: 0 }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
          model: 'text-embedding-3-small',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await embed({ inputs: ['hi'], fetchFn: fakeFetch });

    expect(String(capturedUrl)).toBe('https://api.openai.com/v1/embeddings');
    expect(capturedHeaders.authorization).toBe('Bearer sk-test');
    expect(capturedBody).toMatchObject({ model: 'text-embedding-3-small', input: ['hi'] });
  });
});
