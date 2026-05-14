// LiteLLM client.
//
// All chat-completion calls in scoring stages 1-3 route through here. LiteLLM
// itself proxies to Anthropic / Google / OpenAI / etc, so we speak the
// OpenAI-compatible `/v1/chat/completions` shape and the caller just passes
// the LiteLLM-normalised model name (e.g. `claude-sonnet-4.5`,
// `gemini-2.5-flash-lite`).
//
// This module is HTTP-only: it does NOT write to cost_ledger. Use
// `recordCost()` from `src/cost/ledger.ts` to persist. Separation lets the
// caller correlate the call with a `run_id` and `stage` it knows about, and
// lets us unit-test this module without a database.

import process from 'node:process';

import { env } from '../config/env.js';
import { computeCostUsd } from '../cost/pricing.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  model: string;
  messages: LlmMessage[];
  /** Sampling temperature. Default 0.2 for deterministic-ish scoring. */
  temperature?: number;
  /** Max response tokens. Default 1024. */
  maxTokens?: number;
  /** Override fetch — primarily for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Override abort signal — primarily for tests / per-call timeouts. */
  signal?: AbortSignal;
}

export interface LlmCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** USD cost computed from the pricing table. */
  usd: number;
  /** Raw model name as returned by LiteLLM (may differ from requested). */
  model: string;
}

interface OpenAiChatResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

/**
 * Single chat-completion call against the LiteLLM proxy. Returns text +
 * token counts + computed USD cost. Throws on non-2xx; the caller decides
 * retry policy (Stage gating expects errors to fail the stage so the run
 * row records `failed`, per SPEC §12).
 */
export async function llmCall(opts: LlmCallOptions): Promise<LlmCallResult> {
  const baseUrl = env.litellmBaseUrl().replace(/\/+$/, '');
  const apiKey = env.litellmApiKey();
  const url = `${baseUrl}/v1/chat/completions`;

  const body = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
  };

  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new Error(
      `LiteLLM call failed: HTTP ${res.status} model=${opts.model} body=${detail.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAiChatResponse;
  const text = json.choices[0]?.message.content ?? '';
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  const resolvedModel = json.model ?? opts.model;
  const usd = computeCostUsd(opts.model, inputTokens, outputTokens);

  if (process.env.SOCIALISN2_LLM_DEBUG === '1') {
    console.log(
      `[llm] model=${resolvedModel} in=${inputTokens} out=${outputTokens} usd=${usd.toFixed(6)}`,
    );
  }

  return { text, inputTokens, outputTokens, usd, model: resolvedModel };
}
