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

  it('throws on empty completion content (null or "")', async () => {
    const fakeNull = stubFetch({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
      model: 'claude-sonnet-4.5',
    });
    await expect(
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeNull,
      }),
    ).rejects.toThrow(/empty completion/);

    const fakeEmpty = stubFetch({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
      model: 'claude-sonnet-4.5',
    });
    await expect(
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeEmpty,
      }),
    ).rejects.toThrow(/empty completion/);
  });

  it('uses LiteLLM-resolved model for cost calculation, not requested', async () => {
    // Requested gemini-flash-lite, served as Sonnet (alias mismatch). We
    // should bill against the model actually served.
    const fakeFetch = stubFetch({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
      model: 'claude-sonnet-4.5',
    });
    const result = await llmCall({
      model: 'gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
    });
    // Sonnet rates: 1000*3/1M + 500*15/1M = 0.0105 (not gemini's 0.0003)
    expect(result.usd).toBeCloseTo(0.0105, 9);
    expect(result.model).toBe('claude-sonnet-4.5');
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
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow();
  });

  it('rejects when fetch itself rejects (network failure)', async () => {
    const fakeFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow(/fetch failed/);
  });

  it('applies temperature=0.2 and max_tokens=1024 defaults when not specified', async () => {
    let capturedBody: { temperature?: number; max_tokens?: number } = {};
    const fakeFetch = (async (
      _url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
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
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
    });
    expect(capturedBody.temperature).toBe(0.2);
    expect(capturedBody.max_tokens).toBe(1024);
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

  // ---------------------------------------------------------------------------
  // retry behavior (added 2026-05-23 after Gemini-free-tier 429 incident)
  // ---------------------------------------------------------------------------

  it('retries on 429 then succeeds on next attempt (Retry-After: 0)', async () => {
    let calls = 0;
    const fakeFetch = (async (): Promise<Response> => {
      calls++;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok after retry' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await llmCall({
      model: 'gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
    });
    expect(calls).toBe(2);
    expect(result.text).toBe('ok after retry');
  });

  it('throws HTTP 429 after exhausting maxRetries', async () => {
    let calls = 0;
    const fakeFetch = (async (): Promise<Response> => {
      calls++;
      return new Response('still rate limited', {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }) as unknown as typeof fetch;

    await expect(
      llmCall({
        model: 'gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('retries on 503 with exponential backoff (using Retry-After: 0 to keep test fast)', async () => {
    let calls = 0;
    const fakeFetch = (async (): Promise<Response> => {
      calls++;
      if (calls < 3) {
        return new Response('upstream blip', {
          status: 503,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await llmCall({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn: fakeFetch,
      maxRetries: 2,
    });
    expect(calls).toBe(3);
    expect(result.text).toBe('recovered');
  });

  it('does NOT retry on 500 (server bug, not transient)', async () => {
    let calls = 0;
    const fakeFetch = (async (): Promise<Response> => {
      calls++;
      return new Response('genuine bug', { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(1); // not retried
  });

  it('does NOT retry on 400 / 401 / 403 / 404 (client errors)', async () => {
    for (const status of [400, 401, 403, 404]) {
      let calls = 0;
      const fakeFetch = (async (): Promise<Response> => {
        calls++;
        return new Response('client error', { status });
      }) as unknown as typeof fetch;

      await expect(
        llmCall({
          model: 'claude-sonnet-4.5',
          messages: [{ role: 'user', content: 'hi' }],
          fetchFn: fakeFetch,
          maxRetries: 2,
        }),
      ).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(calls).toBe(1);
    }
  });

  it('does NOT retry on network-level fetch rejection', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      throw new TypeError('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(
      llmCall({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(1);
  });

  it('honors abort signal mid-backoff (interrupts sleep, throws abort error)', async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const fakeFetch = (async (): Promise<Response> => {
      calls++;
      // Abort while the retry loop is sleeping. Retry-After: 5 = 5s wait,
      // we abort within 50ms so the sleep should reject.
      setTimeout(() => ctrl.abort(), 50);
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '5' },
      });
    }) as unknown as typeof fetch;

    await expect(
      llmCall({
        model: 'gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted during retry/);
    expect(calls).toBe(1); // no second attempt — abort fired during backoff
  });

  it('maxRetries=0 disables retry (single attempt only)', async () => {
    let calls = 0;
    const fakeFetch = (async (): Promise<Response> => {
      calls++;
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }) as unknown as typeof fetch;

    await expect(
      llmCall({
        model: 'gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: fakeFetch,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(1);
  });
});
