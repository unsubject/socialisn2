// Stage 6 of the scoring pipeline (SPEC §9.4) — curation.
//
// The curate model receives the Stage 4 cluster summary (headline +
// context_summary + keywords + tags) plus the cluster's source list,
// the temperature / trajectory annotations from §9.5, the
// archive_overlap metadata from §9.3, and Simon's positioning
// statement (config/positioning.md). It outputs a 0-100 score and
// a 1-2 sentence rationale.
//
// The 60-cutoff ("only clusters with curation_score ≥ 60 become
// candidates") is the orchestrator's call (Phase 3 PR 4) — this module
// returns whatever the model produced so a borderline cluster's reason
// is preserved for debugging the cutoff decision and for the eventual
// authority recalibration pass (Phase 5 PR 1).
//
// Model: gemini-3.1-flash-lite via LiteLLM, with thinking pinned to
// `minimal` (reasoning_effort) so the model can't spend its output-token
// budget on hidden reasoning. History:
//   - claude-sonnet-4.5 ($3/$15) was the original curate model.
//   - 2026-05-28 (#100): swapped to gemini-3.5-flash ($1.50/$9) for cost.
//   - 2026-05-31: gemini-3.5-flash truncated its JSON mid-token on every
//     run (0 candidates twice daily). Gemini 3.x defaults thinking_level
//     to HIGH, so reasoning ate the 400-token cap before the JSON closed.
//     Moved to the Flash-Lite tier ($0.25/$1.50 — ~6× cheaper than 3.5
//     Flash AND cheaper than Haiku 4.5) AND pinned thinking minimal +
//     raised the cap for headroom + JSON mode. GPT-5 Nano was rejected:
//     documented schema-unreliability on the nano size for structured
//     output. Route + pricing live in config/litellm.yaml +
//     src/cost/pricing.ts; SPEC.md §12 cost table is a follow-up.
//
// This module is PURE TRANSFORMATION: it does not read from or write to
// the database. The caller threads a CurateInput in and gets a
// CurationOutput out, plus the underlying LlmCallResult so cost can be
// recorded against the appropriate run_id + stage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type LlmCallResult, llmCall } from '../lib/llm.js';
import type { Domain } from './normalize.js';

// Anchor both file paths to THIS module rather than process.cwd() — same
// rationale as normalize.ts: a BullMQ worker / Docker WORKDIR shift
// could otherwise break the load. The Dockerfile copies `dist/` and
// `config/` together so import.meta.url resolves consistently.
const SYSTEM_PROMPT_PATH = fileURLToPath(
  new URL('../../config/prompts/curate.txt', import.meta.url),
);
const POSITIONING_PATH = fileURLToPath(
  new URL('../../config/positioning.md', import.meta.url),
);
const SYSTEM_PROMPT = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
const POSITIONING = readFileSync(POSITIONING_PATH, 'utf-8');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export type Temperature = 'cold' | 'warm' | 'hot' | 'over_saturated';
export type Trajectory = 'new' | 'rising' | 'peaking' | 'declining';

export interface CurateClusterSource {
  name: string;
  authorityScore: number;
}

export interface CurateArchiveLink {
  title: string;
  url: string;
  similarity: number;
  type: 'essay' | 'episode';
}

export interface CurateInput {
  headline: string;
  contextSummary: string;
  keywords: string[];
  tags: string[];
  primaryDomain: Domain;
  sources: CurateClusterSource[];
  temperature: Temperature;
  trajectory: Trajectory;
  archiveOverlap: number;
  archiveOverlapLinks: CurateArchiveLink[];
  isExclusive: boolean;
}

export interface CurationOutput {
  curationScore: number;
  curationRationale: string;
}

export interface CurateOptions {
  model?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override the system prompt for testing prompt-edit candidates. */
  systemPromptOverride?: string;
}

export interface CurateResult {
  output: CurationOutput;
  llm: LlmCallResult;
}

/**
 * Curate one cluster. Throws on malformed LLM output — fail loudly
 * rather than silently corrupting a candidate's score and rationale.
 */
export async function curateCluster(
  input: CurateInput,
  opts: CurateOptions = {},
): Promise<CurateResult> {
  // The positioning statement is appended to the system prompt rather
  // than inlined in the prompt file so the file stays a clean spec of
  // "how to curate" and the editorial voice can be edited independently
  // in positioning.md.
  const systemContent =
    opts.systemPromptOverride ??
    `${SYSTEM_PROMPT}\n\n=== Positioning ===\n${POSITIONING}`;

  const userPayload = JSON.stringify(toWireShape(input), null, 2);

  const llm = await llmCall({
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userPayload },
    ],
    // Slightly higher than normalize (0.1) — curation involves judgement
    // calls and a marginal temperature lets the model break ties
    // sensibly instead of returning the same number for similar clusters.
    temperature: 0.3,
    // Pin thinking to minimal so a Gemini 3.x model doesn't burn the
    // output-token budget on hidden reasoning (the 2026-05-31 truncation
    // outage). LiteLLM maps this to Gemini's thinking_level=minimal.
    reasoningEffort: 'minimal',
    // Ask for JSON-object output as insurance against malformed-but-
    // complete responses (LiteLLM → Gemini response_mime_type).
    responseFormat: { type: 'json_object' },
    // Raised from 400: the schema is tiny (score + 1-2 sentence rationale,
    // ~80 tokens), but the higher cap is structural headroom — if the
    // minimal-thinking pin is ever silently dropped (drop_params) and the
    // model does emit reasoning, the JSON still completes (a more
    // expensive but WORKING call) instead of truncating to a parse error.
    maxTokens: 2048,
    fetchFn: opts.fetchFn,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });

  // Codex review on PR #107 flagged: the skip-on-parse-error path in
  // src/orchestrator/run.ts was discarding the LLM usage on every parse
  // failure, so `cost_ledger` and `runs.total_cost_usd` undercounted
  // spend during the exact malformed-response outage that path exists
  // to tolerate. The thrown error from parseAndValidate carried only a
  // message — the caller had no way to recover the `llm` info.
  //
  // Wrap the parse so a thrown CurateParseError carries the LlmCallResult.
  // The orchestrator's `msg.startsWith('curate:')` predicate keeps
  // working (we preserve the original error message verbatim), and the
  // catch path can now `if (err instanceof CurateParseError) recordCost(err.llm)`
  // before skipping.
  try {
    return { output: parseAndValidate(llm.text), llm };
  } catch (err) {
    throw new CurateParseError(err instanceof Error ? err : new Error(String(err)), llm);
  }
}

/**
 * Error class for curate-stage parse / validation failures that carries
 * the LlmCallResult so the orchestrator can record the spend on the
 * skip-on-error path. The `code` discriminator + the `llm` field make
 * the cost-accounting fix from Codex's PR #107 review possible.
 *
 * The `message` is forwarded verbatim from the underlying
 * `parseAndValidate` throw so the existing `msg.startsWith('curate:')`
 * predicate in `src/orchestrator/run.ts` continues to match.
 */
export class CurateParseError extends Error {
  readonly code = 'curate_parse_error' as const;
  constructor(
    cause: Error,
    public readonly llm: LlmCallResult,
  ) {
    super(cause.message);
    this.name = 'CurateParseError';
    // Preserve the original stack for debugging.
    if (cause.stack) {
      this.stack = cause.stack;
    }
  }
}

/**
 * Translate the camelCase CurateInput into the snake_case wire shape
 * the prompt documents. Keeps the prompt readable for editorial review
 * (matching SPEC §9 field names) while letting TS callers use idiomatic
 * camelCase.
 */
function toWireShape(input: CurateInput): Record<string, unknown> {
  return {
    headline: input.headline,
    context_summary: input.contextSummary,
    keywords: input.keywords,
    tags: input.tags,
    primary_domain: input.primaryDomain,
    sources: input.sources.map((s) => ({
      name: s.name,
      authority_score: s.authorityScore,
    })),
    temperature: input.temperature,
    trajectory: input.trajectory,
    archive_overlap: input.archiveOverlap,
    archive_overlap_links: input.archiveOverlapLinks,
    is_exclusive: input.isExclusive,
  };
}

/**
 * Strip trailing commas inside { } and [ ] blocks. Strict JSON forbids
 * them but Gemini 3.5 Flash routinely emits JS-object-literal-style
 * output with `{"k": 1,}` and `["a","b",]`. Sonnet didn't do this so
 * the production parser was strict pre-2026-05-30. This fallback runs
 * only if the initial strict parse failed — strict-JSON-clean inputs
 * are unaffected.
 *
 * Scope: handles the simple case `,<whitespace>[}\]]`. Does NOT attempt
 * to be a full JSON5 parser — a string literal containing a literal
 * `,` followed by `}` is the only edge case that could false-positive,
 * and our prompt's expected output (a 1-2 sentence rationale) makes
 * that extremely unlikely.
 */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parse the LLM response into a validated CurationOutput. Exposed for
 * unit tests; production callers should call `curateCluster`.
 */
export function parseAndValidate(rawText: string): CurationOutput {
  const cleaned = stripCodeFences(rawText).trim();

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (firstErr: unknown) {
    // Fallback: tolerate trailing commas (Gemini 3.5 Flash quirk).
    // If THIS also fails, throw with the ORIGINAL error so debug
    // output points at the actual syntax issue rather than at our
    // sanitised string.
    try {
      json = JSON.parse(stripTrailingCommas(cleaned));
    } catch {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(
        `curate: LLM did not return valid JSON: ${msg}. Raw (first 200c): ${cleaned.slice(0, 200)}`,
      );
    }
  }
  if (!isObject(json)) {
    throw new Error('curate: LLM response was not a JSON object');
  }

  const score = json.curation_score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(
      `curate: curation_score must be a finite number (got ${JSON.stringify(score)})`,
    );
  }
  if (score < 0 || score > 100) {
    throw new Error(`curate: curation_score ${score} out of range [0, 100]`);
  }

  const rationale = json.curation_rationale;
  if (typeof rationale !== 'string' || rationale.length === 0) {
    throw new Error('curate: curation_rationale must be a non-empty string');
  }

  return { curationScore: score, curationRationale: rationale };
}

function stripCodeFences(s: string): string {
  return s.replace(/^\s*```[a-z0-9]*\s*\n?/i, '').replace(/```\s*$/, '');
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
