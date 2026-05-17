// Unit tests for src/scoring/headline.ts. Stubs fetch — does not hit a
// real LLM. Mirrors curate.test.ts / llm.test.ts patterns.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseAndValidate,
  summariseCluster,
  type SummariseInput,
} from '../../src/scoring/headline.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.LITELLM_BASE_URL = 'https://litellm.test.example/';
  process.env.LITELLM_API_KEY = 'sk-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function sampleInput(): SummariseInput {
  return {
    primaryDomain: 'economy',
    items: [
      {
        summaryEn: 'The Federal Reserve held rates steady at June meeting.',
        contextEn:
          'Officials cited improving labour-market balance. Core PCE eased to 2.5%.',
        source: 'Reuters',
        publishedAt: '2026-05-15T13:30:00Z',
      },
      {
        summaryEn: 'Bloomberg reports Fed pause amid cooling inflation data.',
        contextEn: 'Markets read the dot plot as one cut in 2026.',
        source: 'Bloomberg',
        publishedAt: '2026-05-15T13:45:00Z',
      },
    ],
  };
}

function llmEnvelope(content: string): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 200, completion_tokens: 60 },
    model: 'gemini-2.5-flash-lite',
  };
}

function stubFetchReturning(payload: unknown): {
  fetchFn: typeof fetch;
  captured: {
    url?: string;
    body?: { messages: Array<{ role: string; content: string }>; model: string };
  };
} {
  const captured: {
    url?: string;
    body?: { messages: Array<{ role: string; content: string }>; model: string };
  } = {};
  const fetchFn = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, captured };
}

describe('parseAndValidate', () => {
  it('returns the parsed summary on a well-formed JSON object', () => {
    const out = parseAndValidate(
      JSON.stringify({
        headline: 'Fed holds, signals patience',
        context_summary: 'The Federal Reserve held rates. Officials cited balance. Markets reacted.',
        keywords: ['fed-policy', 'interest-rates', 'inflation', 'pce', 'monetary'],
        tags: ['monetary-policy'],
      }),
    );
    expect(out.headline).toBe('Fed holds, signals patience');
    expect(out.keywords).toHaveLength(5);
    expect(out.tags).toEqual(['monetary-policy']);
  });

  it('accepts an empty tags array (SPEC §9.2 allows it)', () => {
    const out = parseAndValidate(
      JSON.stringify({
        headline: 'x',
        context_summary: 'y',
        keywords: ['a', 'b', 'c', 'd', 'e'],
        tags: [],
      }),
    );
    expect(out.tags).toEqual([]);
  });

  it('strips a leading ```json fence', () => {
    const out = parseAndValidate(
      '```json\n' +
        JSON.stringify({
          headline: 'x',
          context_summary: 'y',
          keywords: ['a', 'b', 'c', 'd', 'e'],
          tags: [],
        }) +
        '\n```',
    );
    expect(out.headline).toBe('x');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAndValidate('not json')).toThrow(/valid JSON/);
  });

  it('throws on missing headline', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          context_summary: 'y',
          keywords: ['a', 'b', 'c', 'd', 'e'],
          tags: [],
        }),
      ),
    ).toThrow(/headline/);
  });

  it('throws when keywords count is below MIN_KEYWORDS (5)', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          headline: 'x',
          context_summary: 'y',
          keywords: ['a', 'b'],
          tags: [],
        }),
      ),
    ).toThrow(/keywords length/);
  });

  it('throws when keywords count is above MAX_KEYWORDS (8)', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          headline: 'x',
          context_summary: 'y',
          keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
          tags: [],
        }),
      ),
    ).toThrow(/keywords length/);
  });

  it('throws when tags exceed MAX_TAGS (3)', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          headline: 'x',
          context_summary: 'y',
          keywords: ['a', 'b', 'c', 'd', 'e'],
          tags: ['monetary-policy', 'inequality', 'climate-policy', 'biosecurity'],
        }),
      ),
    ).toThrow(/tags length/);
  });

  it('throws when a tag is not in STRATEGIC_TAG_SET', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({
          headline: 'x',
          context_summary: 'y',
          keywords: ['a', 'b', 'c', 'd', 'e'],
          tags: ['something-the-model-invented'],
        }),
      ),
    ).toThrow(/STRATEGIC_TAG_SET/);
  });
});

describe('summariseCluster', () => {
  it('throws when items is empty', async () => {
    await expect(
      summariseCluster({ primaryDomain: 'economy', items: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it('returns parsed summary + LlmCallResult on happy path', async () => {
    const { fetchFn } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({
          headline: 'Fed holds rates',
          context_summary: 'a. b. c. d.',
          keywords: ['fed-policy', 'rates', 'inflation', 'pce', 'monetary'],
          tags: ['monetary-policy'],
        }),
      ),
    );
    const result = await summariseCluster(sampleInput(), { fetchFn });
    expect(result.output.headline).toBe('Fed holds rates');
    expect(result.llm.model).toBe('gemini-2.5-flash-lite');
    expect(result.llm.usd).toBeGreaterThan(0);
  });

  it('sends items in snake_case wire shape', async () => {
    const { fetchFn, captured } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({
          headline: 'x',
          context_summary: 'y',
          keywords: ['a', 'b', 'c', 'd', 'e'],
          tags: [],
        }),
      ),
    );
    await summariseCluster(sampleInput(), { fetchFn });
    const userMsg = captured.body!.messages.find((m) => m.role === 'user');
    const payload = JSON.parse(userMsg!.content);
    expect(payload.primary_domain).toBe('economy');
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({
      summary_en: expect.any(String),
      context_en: expect.any(String),
      source: 'Reuters',
      published_at: '2026-05-15T13:30:00Z',
    });
  });

  it('throws when the LLM returns malformed output', async () => {
    const { fetchFn } = stubFetchReturning(llmEnvelope('not even json'));
    await expect(
      summariseCluster(sampleInput(), { fetchFn }),
    ).rejects.toThrow(/valid JSON/);
  });
});
