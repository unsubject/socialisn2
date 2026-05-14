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

// LLM completions are slower than ingestion fetches — Sonnet at 1024 tokens
// can take 30-60s tail-latency. We deliberately use a higher default than
// the generic HTTP_TIMEOUT_MS used elsewhere.
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

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
  /**
   * External abort signal. If provided, it AND the default timeout race —
   * whichever fires first aborts the request. Tests typically pass a
   * pre-aborted signal to bypass the timeout entirely.
   */
  signal?: AbortSignal;
  /** Override the default 120s timeout (ms). */
  timeoutMs?: number;
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  // Race the caller's signal with our timeout: if the caller aborts, we
  // forward that to our controller and stop the timer.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new Error(
      `LiteLLM call failed: HTTP ${res.status} model=${opts.model} body=${detail.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAiChatResponse;
  const rawContent = json.choices[0]?.message.content;
  if (rawContent === null || rawContent === undefined || rawContent === '') {
    // Anthropic occasionally returns null content on tool-use / refusal paths
    // through the OpenAI-compat shim. Silently returning '' would propagate a
    // zero-vector embedding or a JSON-parse error far from this site. Fail the
    // stage instead, per SPEC §12: caller marks `runs.status = 'failed'`.
    throw new Error(
      `LLM returned empty completion for model=${opts.model} — possible tool-use/refusal`,
    );
  }
  const text = rawContent;
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  const resolvedModel = json.model ?? opts.model;
  // Price against the model LiteLLM actually served — alias resolution may
  // route a logical name to a different physical variant.
  const usd = computeCostUsd(resolvedModel, inputTokens, outputTokens);

  if (process.env.SOCIALISN2_LLM_DEBUG === '1') {
    console.log(
      `[llm] model=${resolvedModel} in=${inputTokens} out=${outputTokens} usd=${usd.toFixed(6)}`,
    );
  }

  return { text, inputTokens, outputTokens, usd, model: resolvedModel };
}
