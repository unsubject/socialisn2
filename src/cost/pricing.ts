// Per-model USD pricing, expressed as USD per token. Source: vendor public
// pricing pages as of 2026-05. Update with vendor announcements; LiteLLM
// itself surfaces a `_response_cost` field for served models, but we re-
// derive locally so the ledger doesn't depend on LiteLLM internals (and so
// embedding-direct calls to OpenAI go through the same code path).
//
// Convention: USD per *single* token (not per 1M). Divide vendor's per-1M
// rate by 1_000_000.

export interface ModelPricing {
  /** Cost per single input token, USD. */
  inputUsdPerToken: number;
  /** Cost per single output token, USD. 0 for embedding-only models. */
  outputUsdPerToken: number;
}

const M = 1_000_000;

export const PRICING: Record<string, ModelPricing> = {
  // ---------- Embeddings ----------
  // OpenAI text-embedding-3-small — $0.02 / 1M input tokens, no output.
  'text-embedding-3-small': { inputUsdPerToken: 0.02 / M, outputUsdPerToken: 0 },

  // ---------- LLM (LiteLLM-normalised model names) ----------
  // Anthropic Sonnet 4.5 — $3 / $15 per 1M (input / output).
  'claude-sonnet-4.5': { inputUsdPerToken: 3 / M, outputUsdPerToken: 15 / M },
  // Anthropic Haiku 4.5 — $1 / $5 per 1M.
  'claude-haiku-4.5': { inputUsdPerToken: 1 / M, outputUsdPerToken: 5 / M },
  // Google Gemini 2.5 Flash-Lite — $0.10 / $0.40 per 1M.
  'gemini-2.5-flash-lite': { inputUsdPerToken: 0.1 / M, outputUsdPerToken: 0.4 / M },
  // Google Gemini 3.5 Flash — $1.50 / $9.00 per 1M. Curate stage
  // default since 2026-05-28 (config/litellm.yaml + src/scoring/curate.ts).
  'gemini-3.5-flash': { inputUsdPerToken: 1.5 / M, outputUsdPerToken: 9 / M },
};

// Pessimistic fallback for unknown models. Sonnet rates — the most
// expensive entry we currently bill. The rationale is documented in
// `pricingFor`: a hard cost ceiling MUST count every call. Throwing on
// unknown models would let an unbilled call sneak past the ceiling, which
// is the exact failure mode SPEC §12 is designed to prevent.
//
// Module-init guard rather than a non-null assertion: if the table ever
// loses the claude-sonnet-4.5 key (rename, table edit), we want a clear
// error at import time, not a runtime crash on the first pricingFor()
// call to an unknown model.
const PESSIMISTIC_FALLBACK_KEY = 'claude-sonnet-4.5';
const pessimisticFallbackEntry = PRICING[PESSIMISTIC_FALLBACK_KEY];
if (!pessimisticFallbackEntry) {
  throw new Error(
    `pricing: PRICING table is missing "${PESSIMISTIC_FALLBACK_KEY}" — needed as the pessimistic fallback for unknown models`,
  );
}
const PESSIMISTIC_FALLBACK: ModelPricing = pessimisticFallbackEntry;

/**
 * Look up pricing for a model. If the model isn't in the table — e.g.
 * LiteLLM resolved an alias to an unexpected variant, or a new model name
 * appeared in production before the table was updated — log a warning and
 * return the pessimistic fallback (currently Sonnet rates). Bill against
 * the ceiling rather than silently skipping the row.
 */
export function pricingFor(model: string): ModelPricing {
  const p = PRICING[model];
  if (p) return p;
  console.warn(
    `[pricing] No entry for model "${model}" — billing at pessimistic ` +
      `fallback (${PESSIMISTIC_FALLBACK_KEY} rates). Add the entry to src/cost/pricing.ts.`,
  );
  return PESSIMISTIC_FALLBACK;
}

/**
 * Compute USD cost for a call given token counts. Pure — does not write to
 * the ledger. Use `recordCost()` to persist.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Audit A-P1-3: reject negative / non-integer / non-finite token
  // counts. Without this guard, a vendor or test stub returning -1
  // produces negative `usd`, which lands in cost_ledger.usd
  // (numeric(10,6) accepts negatives) and SUBTRACTS from
  // dailyTotalUsd — could mask real spend or let subsequent calls
  // escape the ceiling. Treat as programmer error and throw loud.
  if (
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new Error(
      `computeCostUsd: tokens must be non-negative integers (got inputTokens=${inputTokens}, outputTokens=${outputTokens})`,
    );
  }
  const p = pricingFor(model);
  return inputTokens * p.inputUsdPerToken + outputTokens * p.outputUsdPerToken;
}
