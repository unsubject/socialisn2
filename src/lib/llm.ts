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
//
// Retry behavior (added 2026-05-23 after the Gemini-free-tier 429 incident):
//   - 429: retry with Retry-After header value, else 60s default (matches
//     Gemini's per-minute quota reset). Up to `maxRetries` retries.
//   - 502/503/504: retry with exponential backoff (5s, 10s, 20s).
//   - 500 + other 4xx: not retried (server bugs / programmer errors are not
//     transient; retrying would just hide them).
//   - Abort signal interrupts the backoff sleep — caller cancellation works
//     even mid-retry.

import process from 'node:process';

import { env } from '../config/env.js';
import { computeCostUsd } from '../cost/pricing.js';

// LLM completions are slower than ingestion fetches — Sonnet at 1024 tokens
// can take 30-60s tail-latency. We deliberately use a higher default than
// the generic HTTP_TIMEOUT_MS used elsewhere.
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

const DEFAULT_MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 120_000;
const RETRYABLE_STATUSES = new Set<number>([429, 502, 503, 504]);
const DEFAULT_BACKOFF_MS_BY_STATUS: Record<number, number> = {
  // 60s is the Gemini free-tier minute-bucket reset. Paid-tier rate limits
  // typically include a Retry-After header which we honor first; this fallback
  // only fires when LiteLLM (or the upstream) doesn't surface one.
  429: 60_000,
  502: 5_000,
  503: 5_000,
  504: 5_000,
};

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
   * pre-aborted signal to bypass the timeout entirely. Also interrupts any
   * in-flight retry backoff.
   */
  signal?: AbortSignal;
  /** Override the default 120s timeout (ms). Applies per-attempt. */
  timeoutMs?: number;
  /** Number of retries on 429 / 5xx-transient (default 2 = 3 total attempts). */
  maxRetries?: number;
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

type AttemptOutcome =
  | { kind: 'ok'; value: LlmCallResult }
  | { kind: 'err'; status: number | null; retryAfter: string | null; error: Error };

/**
 * Single chat-completion call against the LiteLLM proxy. Wraps `llmCall`'s
 * retry loop — each retry calls this once with its own AbortController +
 * timeout.
 */
async function attemptLlmCall(opts: LlmCallOptions): Promise<AttemptOutcome> {
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
  } catch (err) {
    clearTimeout(timeoutHandle);
    // Network-layer failures (fetch reject, AbortError) bubble as fatal —
    // not retryable by status code, surfaced to the caller.
    return {
      kind: 'err',
      status: null,
      retryAfter: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  clearTimeout(timeoutHandle);

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    return {
      kind: 'err',
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      error: new Error(
        `LiteLLM call failed: HTTP ${res.status} model=${opts.model} body=${detail.slice(0, 500)}`,
      ),
    };
  }

  const json = (await res.json()) as OpenAiChatResponse;
  const rawContent = json.choices[0]?.message.content;
  if (rawContent === null || rawContent === undefined || rawContent === '') {
    // Anthropic occasionally returns null content on tool-use / refusal paths
    // through the OpenAI-compat shim. Silently returning '' would propagate a
    // zero-vector embedding or a JSON-parse error far from this site. Fail the
    // stage instead, per SPEC §12: caller marks `runs.status = 'failed'`.
    return {
      kind: 'err',
      status: null,
      retryAfter: null,
      error: new Error(
        `LLM returned empty completion for model=${opts.model} — possible tool-use/refusal`,
      ),
    };
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

  return { kind: 'ok', value: { text, inputTokens, outputTokens, usd, model: resolvedModel } };
}

/**
 * Parse the Retry-After header. Accepts integer seconds (most common from
 * Google / OpenAI / Anthropic) or HTTP-date. Returns the wait in milliseconds,
 * or null if the header is absent / unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // integer seconds form ("0", "30", "60", etc.)
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date form
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const ms = asDate - Date.now();
    return ms > 0 ? ms : 0;
  }
  return null;
}

function computeBackoffMs(status: number, retryAfter: string | null, attemptIdx: number): number {
  const fromHeader = parseRetryAfter(retryAfter);
  if (fromHeader !== null) return Math.min(fromHeader, MAX_BACKOFF_MS);
  const base = DEFAULT_BACKOFF_MS_BY_STATUS[status] ?? 5_000;
  // 429: same wait each retry (matches per-minute quota windows). 5xx:
  // exponential backoff to ease pressure on a recovering backend.
  const multiplier = status === 429 ? 1 : Math.pow(2, attemptIdx);
  return Math.min(base * multiplier, MAX_BACKOFF_MS);
}

/** Interruptible sleep. Abort signal rejects the promise so the retry loop
 *  bubbles up cancellation immediately instead of waiting out the backoff. */
async function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted before retry'));
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new Error('aborted during retry backoff'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Single chat-completion call against the LiteLLM proxy. Returns text +
 * token counts + computed USD cost. Throws on non-2xx (after retries for
 * 429/5xx-transient); the caller decides what to do with the failure.
 *
 * Retry policy:
 *   - 429: up to `maxRetries` (default 2). Wait = Retry-After header, else 60s.
 *   - 502/503/504: up to `maxRetries`. Wait = exponential backoff from 5s.
 *   - 500 + other 4xx: no retry — fail immediately.
 *   - Network / abort errors: no retry — caller's signal already aborted.
 */
export async function llmCall(opts: LlmCallOptions): Promise<LlmCallResult> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const outcome = await attemptLlmCall(opts);
    if (outcome.kind === 'ok') return outcome.value;

    lastError = outcome.error;

    // Non-retryable: network error, empty completion, 500 + other 4xx.
    if (outcome.status === null || !RETRYABLE_STATUSES.has(outcome.status)) {
      throw outcome.error;
    }
    if (attempt === maxRetries) {
      throw outcome.error;
    }

    const waitMs = computeBackoffMs(outcome.status, outcome.retryAfter, attempt);
    if (process.env.SOCIALISN2_LLM_DEBUG === '1') {
      console.log(
        `[llm] retry attempt=${attempt + 1}/${maxRetries + 1} status=${outcome.status} backoff=${waitMs}ms`,
      );
    }
    await sleepInterruptible(waitMs, opts.signal);
  }

  // Loop exhausted without a return or throw — unreachable in practice, but
  // TS needs the explicit path.
  throw lastError ?? new Error('llmCall: retry loop exhausted without an outcome');
}
