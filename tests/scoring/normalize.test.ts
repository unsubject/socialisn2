// Unit tests for src/scoring/normalize.ts. Stubs the fetch used by llmCall
// — no real Gemini hit. Covers the JSON parser, schema validator, and the
// end-to-end normalizeItem happy path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type NormalizedItem,
  VALID_DOMAINS,
  buildEmbeddingInput,
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

  it('throws when keywords length is 1 (below SPEC §7.3 min of 3)', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      keywords: ['only-one'],
    });
    expect(() => parseAndValidate(json)).toThrow(/keywords length 1/);
  });

  it('throws when keywords length is 2 (below SPEC §7.3 min of 3)', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      keywords: ['one', 'two'],
    });
    expect(() => parseAndValidate(json)).toThrow(/keywords length 2/);
  });

  it('throws when keywords length is 8 (above SPEC §7.3 max of 7)', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    expect(() => parseAndValidate(json)).toThrow(/keywords length 8/);
  });

  it('accepts keywords length 3 (lower SPEC §7.3 bound)', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      keywords: ['a', 'b', 'c'],
    });
    expect(parseAndValidate(json).keywords).toEqual(['a', 'b', 'c']);
  });

  it('accepts keywords length 7 (upper SPEC §7.3 bound)', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(parseAndValidate(json).keywords).toHaveLength(7);
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

  it('dedupes repeated domains', () => {
    const json = JSON.stringify({
      ...JSON.parse(asLlmJson(VALID_RESPONSE)),
      domains: ['economy', 'economy', 'geopolitics'],
      primary_domain: 'economy',
    });
    expect(parseAndValidate(json).domains).toEqual(['economy', 'geopolitics']);
  });

  it('strips ```json5 fences without leaving "5" glued to the body', () => {
    const wrapped = '```json5\n' + asLlmJson(VALID_RESPONSE) + '\n```';
    expect(parseAndValidate(wrapped)).toEqual(VALID_RESPONSE);
  });

  it('strips uppercase ```JSON fences', () => {
    const wrapped = '```JSON\n' + asLlmJson(VALID_RESPONSE) + '\n```';
    expect(parseAndValidate(wrapped)).toEqual(VALID_RESPONSE);
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

  it('propagates temperature=0.1 and max_tokens=800 to llmCall', async () => {
    let capturedBody: { temperature?: number; max_tokens?: number } = {};
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
      { title: 't', content: 'c', language: 'en' },
      { fetchFn: fakeFetch },
    );
    expect(capturedBody.temperature).toBe(0.1);
    expect(capturedBody.max_tokens).toBe(800);
  });

  it('threads non-English source language through to the user payload', async () => {
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
      { title: '美聯儲維持利率不變', content: '香港股市午後...', language: 'zh-Hant' },
      { fetchFn: fakeFetch },
    );
    const userMsg = capturedBody.messages?.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('"language": "zh-Hant"');
    expect(userMsg?.content).toContain('美聯儲維持利率不變');
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

describe('buildEmbeddingInput', () => {
  it('emits summary + context + entities in the SPEC §7.3 step-2 order', () => {
    const out = buildEmbeddingInput({
      summaryEn: 'Summary line.',
      contextEn: 'Context paragraph here.',
      entities: ['Federal Reserve', 'Jerome Powell'],
    });
    expect(out).toBe(
      'Summary line.\n\nContext paragraph here.\nEntities: Federal Reserve, Jerome Powell',
    );
  });

  it('omits the Entities suffix entirely when entities[] is empty', () => {
    const out = buildEmbeddingInput({
      summaryEn: 'Summary.',
      contextEn: 'Context.',
      entities: [],
    });
    expect(out).toBe('Summary.\n\nContext.');
    expect(out).not.toContain('Entities:');
  });

  it('is deterministic — same inputs produce the same string twice', () => {
    const item = {
      summaryEn: 'A',
      contextEn: 'B',
      entities: ['x', 'y'],
    };
    expect(buildEmbeddingInput(item)).toBe(buildEmbeddingInput(item));
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
