// Stage 4 of the scoring pipeline (SPEC §9.2) — cluster summarisation.
//
// Takes a cluster's items (already normalised) and produces a single
// canonical headline, English context summary, topical keywords, and 0-3
// strategic tags from config/tags.ts. Output feeds Stage 5 (archive
// overlap) and Stage 6 (curate); persisted into candidates at Stage 7.
//
// Model: Gemini Flash-Lite via LiteLLM. Chosen per SPEC §12 cost budget
// (~$0.0006/cluster × ~200 clusters/run × 2 runs/day = ~$0.24/day) and
// because the task is sub-Sonnet difficulty — we're combining already-
// normalised text, not making editorial calls.
//
// Headline preserves source language per ADR-008. context_summary is
// ENGLISH regardless of source language — it's the normalised handle
// downstream stages cluster against and the curate prompt reads.
//
// This module is PURE TRANSFORMATION: it does not read from or write to
// the database. The orchestrator threads the cluster's items in via
// SummariseInput and gets a SummariseResult out, plus the underlying
// LlmCallResult so cost can be recorded against the appropriate
// run_id + stage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type LlmCallResult, llmCall } from '../lib/llm.js';
import { STRATEGIC_TAG_SET } from '../../config/tags.js';
import type { Domain } from './normalize.js';

const PROMPT_PATH = fileURLToPath(
  new URL('../../config/prompts/headline.txt', import.meta.url),
);
const SYSTEM_PROMPT = readFileSync(PROMPT_PATH, 'utf-8');

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

// SPEC §9.2 mandates 5-8 keywords. Fail loudly rather than letting a
// sparse or noisy set leak into the candidate's metadata (which the
// §11.2 RSS feed UX assumes is in this range).
const MIN_KEYWORDS = 5;
const MAX_KEYWORDS = 8;
const MAX_TAGS = 3;

export interface SummariseClusterItem {
  summaryEn: string;
  contextEn: string;
  source: string;
  publishedAt: Date | string;
}

export interface SummariseInput {
  primaryDomain: Domain;
  items: SummariseClusterItem[];
}

export interface SummariseOutput {
  headline: string;
  contextSummary: string;
  keywords: string[];
  tags: string[];
}

export interface SummariseOptions {
  model?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  systemPromptOverride?: string;
}

export interface SummariseResult {
  output: SummariseOutput;
  llm: LlmCallResult;
}

/**
 * Summarise one cluster. Throws on malformed LLM output — fail loudly
 * rather than silently persist a sparse / non-vocabulary candidate.
 */
export async function summariseCluster(
  input: SummariseInput,
  opts: SummariseOptions = {},
): Promise<SummariseResult> {
  if (input.items.length === 0) {
    throw new Error('summariseCluster: items must be non-empty');
  }

  const userPayload = JSON.stringify(toWireShape(input), null, 2);
  const llm = await llmCall({
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: opts.systemPromptOverride ?? SYSTEM_PROMPT },
      { role: 'user', content: userPayload },
    ],
    // Slightly above normalize (0.1) because picking the "best" headline
    // from N candidates is mildly discriminative, but well below curate
    // (0.3) — we want stable summaries that downstream stages can hash on.
    temperature: 0.2,
    // Schema's longest field (context_summary) is ~120 words ≈ 200 tokens.
    // 600 leaves headroom while keeping cost in check.
    maxTokens: 600,
    fetchFn: opts.fetchFn,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  // Wrap the parse so a thrown SummariseParseError carries the
  // LlmCallResult — mirrors curate.ts/CurateParseError so the
  // orchestrator's Stage-4 skip path can record the (already-incurred)
  // LLM cost before skipping the cluster, instead of undercounting spend
  // during a malformed-response spell. The message is forwarded verbatim
  // so a `msg.startsWith('headline:')` predicate keeps matching.
  try {
    return { output: parseAndValidate(llm.text), llm };
  } catch (err) {
    throw new SummariseParseError(
      err instanceof Error ? err : new Error(String(err)),
      llm,
    );
  }
}

/**
 * Error class for Stage-4 summarise parse / validation failures that
 * carries the LlmCallResult so the orchestrator can record the spend on
 * the skip-on-error path. Mirrors curate.ts:CurateParseError. The
 * `message` is forwarded verbatim from the underlying `parseAndValidate`
 * throw so the orchestrator's `msg.startsWith('headline:')` fallback
 * predicate continues to match.
 */
export class SummariseParseError extends Error {
  readonly code = 'summarise_parse_error' as const;
  constructor(
    cause: Error,
    public readonly llm: LlmCallResult,
  ) {
    super(cause.message);
    this.name = 'SummariseParseError';
    if (cause.stack) {
      this.stack = cause.stack;
    }
  }
}

/**
 * Translate the camelCase SummariseInput to the snake_case wire shape
 * the prompt documents (keeps the prompt readable for editorial review).
 */
function toWireShape(input: SummariseInput): Record<string, unknown> {
  return {
    primary_domain: input.primaryDomain,
    items: input.items.map((i) => ({
      summary_en: i.summaryEn,
      context_en: i.contextEn,
      source: i.source,
      published_at:
        i.publishedAt instanceof Date
          ? i.publishedAt.toISOString()
          : i.publishedAt,
    })),
  };
}

/**
 * Parse the LLM response into a validated SummariseOutput. Exposed for
 * unit tests; production callers should call `summariseCluster`.
 */
export function parseAndValidate(rawText: string): SummariseOutput {
  const cleaned = stripCodeFences(rawText).trim();

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `headline: LLM did not return valid JSON: ${msg}. Raw (first 200c): ${cleaned.slice(0, 200)}`,
    );
  }
  if (!isObject(json)) {
    throw new Error('headline: LLM response was not a JSON object');
  }

  const headline = requireString(json, 'headline');
  const contextSummary = requireString(json, 'context_summary');
  const keywords = requireStringArray(json, 'keywords');
  const tags = requireStringArray(json, 'tags');

  if (keywords.length < MIN_KEYWORDS || keywords.length > MAX_KEYWORDS) {
    throw new Error(
      `headline: keywords length ${keywords.length} out of range (expected ${MIN_KEYWORDS}-${MAX_KEYWORDS} per SPEC §9.2)`,
    );
  }

  // Tags are ADVISORY metadata (0-3 strategic tags, empty allowed per
  // SPEC §9.2 / prompt rule 6). The model occasionally emits an
  // off-vocabulary value — most often a DOMAIN name like "geopolitics"
  // instead of a strategic tag (3 of 4 scoring runs on 2026-06-01/02
  // aborted on exactly this). Throwing was disproportionate: a stray
  // advisory tag must never fail an otherwise-good summary. Drop
  // unknown tags + dedupe + cap at MAX_TAGS — same controlled-vocabulary
  // surface the throw used to guarantee, but resilient to model
  // disobedience. Prompt + config stay the source of truth for what's
  // VALID; this just stops an invalid suggestion from being fatal.
  const seen = new Set<string>();
  const validTags: string[] = [];
  const droppedTags: string[] = [];
  for (const tag of tags) {
    if (!STRATEGIC_TAG_SET.has(tag)) {
      droppedTags.push(tag);
    } else if (!seen.has(tag)) {
      seen.add(tag);
      validTags.push(tag);
    }
  }
  const cappedTags = validTags.slice(0, MAX_TAGS);
  if (droppedTags.length > 0) {
    // Observable (ops-digest can flag a spike) without being fatal.
    console.warn(
      `headline: dropped ${droppedTags.length} off-vocabulary tag(s): ${droppedTags.join(', ')}`,
    );
  }

  return { headline, contextSummary, keywords, tags: cappedTags };
}

function stripCodeFences(s: string): string {
  return s.replace(/^\s*```[a-z0-9]*\s*\n?/i, '').replace(/```\s*$/, '');
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`headline: field "${key}" must be a non-empty string`);
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`headline: field "${key}" must be an array of strings`);
  }
  return v as string[];
}
