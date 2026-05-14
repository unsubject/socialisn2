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

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_URL = 'https://api.openai.com/v1/embeddings';

export interface EmbedOptions {
  /**
   * One or more strings to embed. OpenAI's API accepts up to 2048 inputs per
   * call and ~8192 tokens per input. Caller is responsible for chunking
   * larger payloads.
   */
  inputs: string[];
  /** Override fetch — primarily for tests. */
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** Same order as `inputs`. Each vector has length 1536. */
  vectors: number[][];
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
 * Throws on non-2xx — caller decides retry policy. Does NOT write to
 * cost_ledger; use `recordCost()` from `src/cost/ledger.ts` after a
 * successful call.
 */
export async function embed(opts: EmbedOptions): Promise<EmbedResult> {
  if (opts.inputs.length === 0) {
    return { vectors: [], inputTokens: 0, usd: 0 };
  }

  const apiKey = env.openaiApiKey();
  const doFetch = opts.fetchFn ?? fetch;

  const res = await doFetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: opts.inputs }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new Error(
      `OpenAI embeddings call failed: HTTP ${res.status} n=${opts.inputs.length} body=${detail.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAiEmbeddingResponse;
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => d.embedding);
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const usd = computeCostUsd(EMBED_MODEL, inputTokens, 0);

  return { vectors, inputTokens, usd };
}

export { EMBED_MODEL };
