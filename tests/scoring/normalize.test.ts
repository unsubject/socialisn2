// Unit tests for src/scoring/normalize.ts. Stubs the fetch used by llmCall
// — no real Gemini hit. Covers the JSON parser, schema validator, and the
// end-to-end normalizeItem happy path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type NormalizedItem,
  VALID_DOMAINS,
  normalizeItem,
  parseAndValidate,
} from '../../src/scoring/normalize.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.LITELLM_BASE_URL = 'https://litellm.test.example/';
  process.env.LITELLM_API_KEY = 'sk-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const VALID_RESPONSE: NormalizedItem = {
  summaryEn: 'The Fed held rates steady at the May meeting, citing sticky services inflation.',
  contextEn:
    'The Federal Reserve has paused rate cuts since March amid resilient labour-market data. Markets priced in two cuts for 2026 going into the meeting; only one is now expected. Bond yields rose on the announcement and the dollar strengthened against major peers.',
  entities: ['Federal Reserve', 'Jerome Powell'],
  domains: ['economy'],
  primaryDomain: 'economy',
  keywords: ['fed-policy', 'interest-rates', 'inflation'],
};

function asLlmJson(obj: unknown): string {
  return JSON.stringify({
    summary_en: (obj as NormalizedItem).summaryEn,
    context_en: (obj as NormalizedItem).contextEn,
    entities: (obj as NormalizedItem).entities,
    domains: (obj as NormalizedItem).domains,
    primary_domain: (obj as NormalizedItem).primaryDomain,
    keywords: (obj as NormalizedItem).keywords,
  });
}

function stubLlmFetch(content: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 800, completion_tokens: 150 },
        model: 'gemini-2.5-flash-lite',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

describe('parseAndValidate', () => {
  it('returns the typed item on a well-formed JSON response', () => {
    const result = parseAndValidate(asLlmJson(VALID_RESPONSE));
    expect(result).toEqual(VALID_RESPONSE);
  });

  it('strips ```json``` code fences before parsing', () => {
    const wrapped = '```json\n' + asLlmJson(VALID_RESPONSE) + '\n```';
    expect(parseAndValidate(wrapped)).toEqual(VALID_RESPONSE);
  });

  it('strips bare ``` code fences', () => {
    const wrapped = '```\n' + asLlmJson(VALID_RESPONSE) + '\n```';
    expect(parseAndValidate(wrapped)).toEqual(VALID_RESPONSE);
  });

  it('throws on non-JSON input', () => {
    expect(() => parseAndValidate('I am sorry, I cannot do that.')).toThrow(/valid JSON/);
  });

  it('throws when response is a JSON array instead of object', () => {
    expect(() => parseAndValidate('[1,2,3]')).toThrow(/not a JSON object/);
  });

  it('throws on missing summary_en', () => {
    const json = JSON.stringify({ ...JSON.parse(asLlmJson(VALID_RESPONSE)), summary_en: '' });
    expect(() => parseAndValidate(json)).toThrow(/summary_en/);
  });

  it('throws on unknown domain', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      domains: ['economy', 'cooking'],
    });
    expect(() => parseAndValidate(json)).toThrow(/cooking/);
  });

  it('throws when primary_domain not in domains list', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      domains: ['economy'],
      primary_domain: 'scitech',
    });
    expect(() => parseAndValidate(json)).toThrow(/not in domains list/);
  });

  it('throws when entities is not an array of strings', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      entities: ['Powell', 42, 'Fed'],
    });
    expect(() => parseAndValidate(json)).toThrow(/entities/);
  });

  it('throws when keywords is empty', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      keywords: [],
    });
    expect(() => parseAndValidate(json)).toThrow(/keywords length 0/);
  });

  it('accepts multi-domain output with one as primary', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      domains: ['economy', 'geopolitics'],
      primary_domain: 'geopolitics',
    });
    const result = parseAndValidate(json);
    expect(result.domains).toEqual(['economy', 'geopolitics']);
    expect(result.primaryDomain).toBe('geopolitics');
  });
});

describe('normalizeItem', () => {
  it('round-trips a typical input through the stubbed LLM', async () => {
    const fakeFetch = stubLlmFetch(asLlmJson(VALID_RESPONSE));
    const result = await normalizeItem(
      {
        title: 'Fed holds rates at May meeting',
        content: 'The Federal Reserve voted to keep rates unchanged...',
        language: 'en',
      },
      { fetchFn: fakeFetch },
    );
    expect(result.item).toEqual(VALID_RESPONSE);
    expect(result.llm.inputTokens).toBe(800);
    expect(result.llm.outputTokens).toBe(150);
    expect(result.llm.usd).toBeGreaterThan(0);
  });

  it('surfaces a clean error when the LLM returns malformed JSON', async () => {
    const fakeFetch = stubLlmFetch('not json at all');
    await expect(
      normalizeItem(
        { title: 'x', content: 'y', language: 'en' },
        { fetchFn: fakeFetch },
      ),
    ).rejects.toThrow(/valid JSON/);
  });

  it('passes language=null through as "unknown" in the user payload', async () => {
    let capturedBody: { messages?: Array<{ role: string; content: string }> } = {};
    const fakeFetch = (async (
      _url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: asLlmJson(VALID_RESPONSE) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await normalizeItem(
      { title: 't', content: null, language: null },
      { fetchFn: fakeFetch },
    );
    const userMsg = capturedBody.messages?.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('"language": "unknown"');
    expect(userMsg?.content).toContain('"content": ""');
  });
});

describe('VALID_DOMAINS', () => {
  it('matches the five-domain taxonomy in SPEC §3', () => {
    expect(VALID_DOMAINS).toEqual([
      'economy',
      'economics',
      'scitech',
      'geopolitics',
      'national',
    ]);
  });
});
