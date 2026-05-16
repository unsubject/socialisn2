// OpenAI text-embedding-3-small client.
//
// Used by SPEC §7.2 step 2 (semantic dedup), §7.4 (cluster centroid match),
// §10 (archive-overlap lookup against 2nd-brain). Dimension is 1536 —
// matched by `EMBEDDING_DIM` in `src/db/schema.ts` and by pgvector index
// definitions in migration 001.
//
// LiteLLM CAN proxy OpenAI embeddings, but going direct keeps the embedding
// path independent of the LiteLLM service availability (embeddings run on
// every ingestion tick; LLM curation runs twice a day). One less moving
// part on the hot path is worth the extra key in `.env`.

import { env } from '../config/env.js';
import { computeCostUsd } from '../cost/pricing.js';
import { EMBEDDING_DIM } from '../db/schema.js';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
// Embedding calls are short — 1-2s typical for a batch of 100 inputs.
// 30s tracks the generic HTTP_TIMEOUT_MS in env.
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export interface EmbedOptions {
  /**
   * One or more strings to embed. OpenAI's API accepts up to 2048 inputs per
   * call and ~8192 tokens per input. Caller is responsible for chunking
   * larger payloads.
   *
   * Empty strings are filtered out before the API call (OpenAI 400s on `""`),
   * but the returned `vectors` array is index-aligned to `inputs` — empty
   * positions surface as `null`, not as dropped entries. This lets callers
   * iterate `inputs` and pair each one with its embedding (or skip on null)
   * without separate book-keeping.
   */
  inputs: string[];
  /** Override fetch — primarily for tests. */
  fetchFn?: typeof fetch;
  /** External abort signal; raced with the default timeout. */
  signal?: AbortSignal;
  /** Override the default 30s timeout (ms). */
  timeoutMs?: number;
}

export interface EmbedResult {
  /**
   * Aligned 1:1 with `inputs`. Each entry is a 1536-dim vector or `null` if
   * the corresponding input was an empty string and therefore not sent to
   * the API.
   */
  vectors: (number[] | null)[];
  inputTokens: number;
  usd: number;
}

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
  model: string;
}

/**
 * Embed N strings in a single API call. Returns vectors in the input order,
 * not the order OpenAI happens to return them in (the API guarantees
 * `index` but we re-sort defensively in case of any reordering).
 *
 * Throws on non-2xx — caller decides retry policy. Also throws if any
 * returned vector has length ≠ EMBEDDING_DIM, so a model-name typo or a
 * silent upstream dimension change surfaces here rather than at pgvector
 * insert time. Does NOT write to cost_ledger; use `recordCost()` from
 * `src/cost/ledger.ts` after a successful call.
 */
export async function embed(opts: EmbedOptions): Promise<EmbedResult> {
  // Build a list of (originalIndex, value) for non-empty inputs. We send
  // only the non-empty ones to the API and use originalIndex to scatter the
  // returned vectors back into the right slots of an output array sized to
  // match `inputs`.
  const sendable: Array<{ idx: number; value: string }> = [];
  for (let i = 0; i < opts.inputs.length; i++) {
    const s = opts.inputs[i] ?? '';
    if (s.length > 0) sendable.push({ idx: i, value: s });
  }
  if (sendable.length === 0) {
    return {
      vectors: opts.inputs.map(() => null),
      inputTokens: 0,
      usd: 0,
    };
  }

  const apiKey = env.openaiApiKey();
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await doFetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: sendable.map((s) => s.value) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new Error(
      `OpenAI embeddings call failed: HTTP ${res.status} n=${sendable.length} body=${detail.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAiEmbeddingResponse;
  // The API guarantees `index` matches the request order, but re-sort
  // defensively in case of any reordering. Then scatter into the
  // input-aligned output array, asserting dimension as we go.
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  const vectors: (number[] | null)[] = opts.inputs.map(() => null);
  for (let i = 0; i < sorted.length; i++) {
    const originalIdx = sendable[i]?.idx;
    const vec = sorted[i]?.embedding;
    if (originalIdx === undefined || !vec) continue;
    if (vec.length !== EMBEDDING_DIM) {
      // A non-1536-dim vector means OpenAI served a different model than
      // we requested (or the model definition changed). Failing here
      // localises the surprise; pgvector would also reject the insert,
      // but the error there is harder to attribute back to embeddings.ts.
      throw new Error(
        `OpenAI embeddings: vector length ${vec.length} ≠ EMBEDDING_DIM ${EMBEDDING_DIM} at input index ${originalIdx}`,
      );
    }
    vectors[originalIdx] = vec;
  }
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const usd = computeCostUsd(EMBED_MODEL, inputTokens, 0);

  return { vectors, inputTokens, usd };
}

export { EMBED_MODEL };
