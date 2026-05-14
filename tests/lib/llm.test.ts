// Unit tests for src/lib/llm.ts. Stubs fetch — does not hit a real proxy.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { llmCall } from '../../src/lib/llm.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.LITELLM_BASE_URL = 'https://litellm.test.example/';
  process.env.LITELLM_API_KEY = 'sk-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function stubFetch(payload: unknown, init: Partial<Response> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    })) as unknown as typeof fetch;
}

describe('llmCall', () => {
  it('returns text + token counts + computed usd on 200', async () => {
    const fakeFetch = stubFetch({
      choices: [{ message: { content: 'hello world' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      model: 'claude-sonnet-4.5',
    });

    const result = await llmCall({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
    });

    expect(result.text).toBe('hello world');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    // 100 * 3/1M + 20 * 15/1M = 0.0003 + 0.0003 = 0.0006
    expect(result.usd).toBeCloseTo(0.0006, 9);
  });

  it('throws with status + truncated body on non-2xx', async () => {
    const fakeFetch = (async () =>
      new Response('upstream broke', { status: 500 })) as unknown as typeof fetch;

    await expect(
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('posts to {baseUrl}/v1/chat/completions with bearer auth', async () => {
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
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await llmCall({
      model: 'gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
      temperature: 0.7,
      maxTokens: 256,
    });

    expect(String(capturedUrl)).toBe('https://litellm.test.example/v1/chat/completions');
    expect(capturedHeaders.authorization).toBe('Bearer sk-test');
    expect(capturedBody).toMatchObject({
      model: 'gemini-2.5-flash-lite',
      temperature: 0.7,
      max_tokens: 256,
    });
  });

  it('normalises trailing slash in base URL', async () => {
    process.env.LITELLM_BASE_URL = 'https://litellm.test.example///';
    let capturedUrl: string | URL = '';
    const fakeFetch = (async (url: string | URL): Promise<Response> => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await llmCall({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
    });

    expect(String(capturedUrl)).toBe('https://litellm.test.example/v1/chat/completions');
  });
});
