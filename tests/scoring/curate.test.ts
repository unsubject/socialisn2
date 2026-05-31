// Unit tests for src/scoring/curate.ts. Stubs fetch — does not hit a
// real LLM. Mirrors the llm.test.ts pattern.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  curateCluster,
  parseAndValidate,
  type CurateInput,
} from '../../src/scoring/curate.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.LITELLM_BASE_URL = 'https://litellm.test.example/';
  process.env.LITELLM_API_KEY = 'sk-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function sampleInput(overrides: Partial<CurateInput> = {}): CurateInput {
  return {
    headline: 'Fed signals pause as core inflation cools',
    contextSummary:
      'The Federal Reserve held rates steady at its June meeting. Core PCE eased to 2.5%. Officials cited improving labour-market balance. Markets read the dot plot as one cut in 2026.',
    keywords: ['fed-policy', 'interest-rates', 'inflation'],
    tags: ['monetary-policy'],
    primaryDomain: 'economy',
    sources: [
      { name: 'Reuters', authorityScore: 85 },
      { name: 'Bloomberg', authorityScore: 85 },
    ],
    temperature: 'hot',
    trajectory: 'rising',
    archiveOverlap: 0.42,
    archiveOverlapLinks: [],
    isExclusive: false,
    ...overrides,
  };
}

function stubFetchReturning(
  payload: unknown,
): { fetchFn: typeof fetch; captured: { url?: string; body?: unknown; headers?: Record<string, string> } } {
  const captured: { url?: string; body?: unknown; headers?: Record<string, string> } = {};
  const fetchFn = (async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = String(url);
    captured.headers = (init?.headers ?? {}) as Record<string, string>;
    captured.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, captured };
}

function llmEnvelope(content: string): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
    model: 'gemini-3.1-flash-lite',
  };
}

describe('parseAndValidate', () => {
  it('returns the parsed curation on a well-formed JSON object', () => {
    const out = parseAndValidate(
      JSON.stringify({
        curation_score: 72,
        curation_rationale: 'Solid economy story with rising trajectory.',
      }),
    );
    expect(out).toEqual({
      curationScore: 72,
      curationRationale: 'Solid economy story with rising trajectory.',
    });
  });

  it('accepts fractional scores in range', () => {
    const out = parseAndValidate(
      JSON.stringify({ curation_score: 67.5, curation_rationale: 'borderline' }),
    );
    expect(out.curationScore).toBe(67.5);
  });

  it('strips a leading ```json code fence', () => {
    const out = parseAndValidate(
      '```json\n' +
        JSON.stringify({ curation_score: 80, curation_rationale: 'good' }) +
        '\n```',
    );
    expect(out.curationScore).toBe(80);
  });

  it('tolerates a trailing comma before the closing brace (Gemini 3.5 Flash quirk)', () => {
    // Production incident 2026-05-30: Gemini occasionally emits
    // `{"curation_score": 45, "curation_rationale": "...",}` — strict
    // JSON.parse rejects with "Expected double-quoted property name".
    // The fallback path strips the trailing comma and re-parses.
    const out = parseAndValidate(
      '{"curation_score": 45, "curation_rationale": "ok-enough story",}',
    );
    expect(out).toEqual({
      curationScore: 45,
      curationRationale: 'ok-enough story',
    });
  });

  it('tolerates a trailing comma inside a code fence', () => {
    const out = parseAndValidate(
      '```json\n{"curation_score": 70, "curation_rationale": "x",}\n```',
    );
    expect(out.curationScore).toBe(70);
  });

  it('throws when the response is not valid JSON', () => {
    expect(() => parseAndValidate('not json at all')).toThrow(/valid JSON/);
  });

  it('throws when the response is a JSON array, not an object', () => {
    expect(() => parseAndValidate('[1,2,3]')).toThrow(/JSON object/);
  });

  it('throws when curation_score is missing', () => {
    expect(() =>
      parseAndValidate(JSON.stringify({ curation_rationale: 'x' })),
    ).toThrow(/curation_score/);
  });

  it('throws when curation_score is a string', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({ curation_score: '72', curation_rationale: 'x' }),
      ),
    ).toThrow(/curation_score/);
  });

  it('throws when curation_score is non-finite', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({ curation_score: null, curation_rationale: 'x' }),
      ),
    ).toThrow(/curation_score/);
  });

  it('throws when curation_score is below 0', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({ curation_score: -1, curation_rationale: 'x' }),
      ),
    ).toThrow(/out of range/);
  });

  it('throws when curation_score is above 100', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({ curation_score: 101, curation_rationale: 'x' }),
      ),
    ).toThrow(/out of range/);
  });

  it('throws when curation_rationale is missing', () => {
    expect(() =>
      parseAndValidate(JSON.stringify({ curation_score: 75 })),
    ).toThrow(/curation_rationale/);
  });

  it('throws when curation_rationale is empty string', () => {
    expect(() =>
      parseAndValidate(
        JSON.stringify({ curation_score: 75, curation_rationale: '' }),
      ),
    ).toThrow(/curation_rationale/);
  });
});

describe('curateCluster', () => {
  it('returns parsed curation + LlmCallResult on happy path', async () => {
    const { fetchFn } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({
          curation_score: 72,
          curation_rationale: 'Strong economy story; sources are top-tier.',
        }),
      ),
    );
    const result = await curateCluster(sampleInput(), { fetchFn });
    expect(result.output.curationScore).toBe(72);
    expect(result.output.curationRationale).toMatch(/economy/i);
    expect(result.llm.model).toBe('gemini-3.1-flash-lite');
    expect(result.llm.usd).toBeGreaterThan(0);
  });

  it('pins thinking minimal + json mode + headroom cap on the curate call', async () => {
    // Regression guard for the 2026-05-31 truncation outage: the curate
    // call MUST send reasoning_effort=minimal (so a Gemini 3.x model
    // doesn't spend its output budget on hidden reasoning and truncate
    // the JSON) plus a generous max_tokens as headroom, and asks for a
    // JSON object as belt-and-suspenders.
    const { fetchFn, captured } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({ curation_score: 50, curation_rationale: 'meh' }),
      ),
    );
    await curateCluster(sampleInput(), { fetchFn });
    const body = captured.body as {
      reasoning_effort?: string;
      response_format?: { type: string };
      max_tokens?: number;
    };
    expect(body.reasoning_effort).toBe('minimal');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
  });

  it('sends the cluster as snake_case in the user message', async () => {
    const { fetchFn, captured } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({ curation_score: 50, curation_rationale: 'meh' }),
      ),
    );
    await curateCluster(sampleInput(), { fetchFn });
    const body = captured.body as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const userPayload = JSON.parse(userMsg!.content);
    expect(userPayload).toMatchObject({
      context_summary: expect.any(String),
      primary_domain: 'economy',
      is_exclusive: false,
      sources: [
        { name: 'Reuters', authority_score: 85 },
        { name: 'Bloomberg', authority_score: 85 },
      ],
    });
  });

  it('appends the positioning block to the system prompt', async () => {
    const { fetchFn, captured } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({ curation_score: 50, curation_rationale: 'meh' }),
      ),
    );
    await curateCluster(sampleInput(), { fetchFn });
    const body = captured.body as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = body.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('=== Positioning ===');
    // Positioning's distinctive line so we know it was actually appended.
    expect(systemMsg!.content).toContain(
      'Economist-first, classical liberal',
    );
  });

  it('uses gemini-3.1-flash-lite by default; honours model override', async () => {
    const { fetchFn, captured } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({ curation_score: 50, curation_rationale: 'meh' }),
      ),
    );
    await curateCluster(sampleInput(), { fetchFn });
    expect((captured.body as { model: string }).model).toBe(
      'gemini-3.1-flash-lite',
    );

    const { fetchFn: fetchFn2, captured: captured2 } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({ curation_score: 50, curation_rationale: 'meh' }),
      ),
    );
    await curateCluster(sampleInput(), {
      fetchFn: fetchFn2,
      model: 'claude-haiku-4.5',
    });
    expect((captured2.body as { model: string }).model).toBe('claude-haiku-4.5');
  });

  it('honours systemPromptOverride for prompt experiments', async () => {
    const { fetchFn, captured } = stubFetchReturning(
      llmEnvelope(
        JSON.stringify({ curation_score: 50, curation_rationale: 'meh' }),
      ),
    );
    await curateCluster(sampleInput(), {
      fetchFn,
      systemPromptOverride: 'ENTIRELY DIFFERENT PROMPT',
    });
    const body = captured.body as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = body.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toBe('ENTIRELY DIFFERENT PROMPT');
  });

  it('throws when the LLM returns malformed output', async () => {
    const { fetchFn } = stubFetchReturning(llmEnvelope('not even json'));
    await expect(
      curateCluster(sampleInput(), { fetchFn }),
    ).rejects.toThrow(/valid JSON/);
  });
});
