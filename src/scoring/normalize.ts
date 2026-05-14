// Stage 1 of the scoring pipeline (SPEC §7.3) — normalisation.
//
// Takes a raw_item (title + content + language) and produces a strict
// JSON object with English summary, English context, entities, domain
// labels, and topical keywords. The downstream stages (clustering,
// curation) consume only these normalised fields, so this is the
// linguistic and editorial firewall: source can be any language, output
// is always English; source can be opinionated, output is always neutral.
//
// Model: Gemini Flash-Lite via LiteLLM. Chosen for SPEC §12 cost reasons
// — ~$0.15/day for ~2000 items at $0.10/$0.40 per 1M tokens.
//
// This module is a PURE TRANSFORMATION: it does not read from or write to
// the database. The caller threads a NormalizeInput in and gets a
// NormalizedItem out, plus the underlying LlmCallResult so the caller can
// record the cost in `cost_ledger` with the appropriate run_id / stage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type LlmCallResult, llmCall } from '../lib/llm.js';

// Resolve the prompt path relative to THIS module rather than process.cwd()
// — a BullMQ worker started under systemd, a docker WORKDIR other than
// repo root, or a future bundler all change cwd in ways the operator can't
// always predict. import.meta.url anchors to the compiled .js file's
// location, and the Dockerfile copies both `dist/` and `config/` into the
// runtime image so the relative path resolves the same in dev and prod.
const PROMPT_PATH = fileURLToPath(
  new URL('../../config/prompts/normalize.txt', import.meta.url),
);
// Loaded once at module init — the prompt is config, edited rarely. A
// long-running worker will pick up edits on restart only, which is the
// behaviour we want (no surprise prompt drift mid-shift).
const SYSTEM_PROMPT = readFileSync(PROMPT_PATH, 'utf-8');

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export const VALID_DOMAINS = ['economy', 'economics', 'scitech', 'geopolitics', 'national'] as const;
export type Domain = (typeof VALID_DOMAINS)[number];

export interface NormalizeInput {
  title: string;
  content: string | null;
  /** ISO 639-1 of the source. Surfaced to the model so it doesn't guess. */
  language: string | null;
}

export interface NormalizedItem {
  summaryEn: string;
  contextEn: string;
  entities: string[];
  domains: Domain[];
  primaryDomain: Domain;
  keywords: string[];
}

export interface NormalizeOptions {
  model?: string;
  /** Override fetch / signal / timeout for testing. */
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NormalizeResult {
  item: NormalizedItem;
  /**
   * The raw LlmCallResult so the caller can persist cost with run_id +
   * stage. Exposing it instead of writing to cost_ledger here keeps this
   * module DB-free and unit-testable without Postgres.
   */
  llm: LlmCallResult;
}

/**
 * Normalise one raw_item. Throws if the LLM returns malformed JSON or a
 * value that doesn't conform to the schema (unknown domain, wrong type,
 * etc) — fail loudly rather than silently corrupting the `items` table.
 */
export async function normalizeItem(
  input: NormalizeInput,
  opts: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const userPayload = JSON.stringify(
    {
      title: input.title,
      content: input.content ?? '',
      language: input.language ?? 'unknown',
    },
    null,
    2,
  );

  const llm = await llmCall({
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPayload },
    ],
    temperature: 0.1,
    // Tight cap — the schema's longest field (context_en) is ~80 words. 800
    // tokens leaves plenty of headroom but forces the model to stay terse.
    maxTokens: 800,
    fetchFn: opts.fetchFn,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });

  const item = parseAndValidate(llm.text);
  return { item, llm };
}

/**
 * Parse the LLM response into a validated NormalizedItem. Exported for
 * tests; production code should call `normalizeItem`.
 */
export function parseAndValidate(rawText: string): NormalizedItem {
  // Some models occasionally wrap JSON in code fences despite the prompt.
  // Strip them defensively.
  const cleaned = stripCodeFences(rawText).trim();

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `normalize: LLM did not return valid JSON: ${msg}. Raw (first 200c): ${cleaned.slice(0, 200)}`,
    );
  }

  if (!isObject(json)) {
    throw new Error('normalize: LLM response was not a JSON object');
  }

  const summaryEn = requireString(json, 'summary_en');
  const contextEn = requireString(json, 'context_en');
  const entities = requireStringArray(json, 'entities');
  const domainsRaw = requireStringArray(json, 'domains');
  const primaryDomainRaw = requireString(json, 'primary_domain');
  const keywords = requireStringArray(json, 'keywords');

  // Dedupe the domains list — models occasionally repeat the primary in
  // the multi-label set ("economy" + primary "economy"), which would
  // pollute downstream array-overlap (`&&`) queries and the GIN index.
  const domains = Array.from(
    new Set(domainsRaw.map((d) => validateDomain(d, 'domains'))),
  );
  const primaryDomain = validateDomain(primaryDomainRaw, 'primary_domain');

  if (!domains.includes(primaryDomain)) {
    throw new Error(
      `normalize: primary_domain "${primaryDomain}" is not in domains list [${domains.join(', ')}]`,
    );
  }

  if (keywords.length < 1 || keywords.length > 10) {
    // SPEC §7.3 asks for 3-7. Be permissive on the bounds (1-10) so the
    // pipeline doesn't fail noisily on a borderline output; the prompt
    // pressures the model toward 3-7 in normal operation.
    throw new Error(
      `normalize: keywords length ${keywords.length} out of range (expected 1-10)`,
    );
  }

  return { summaryEn, contextEn, entities, domains, primaryDomain, keywords };
}

function stripCodeFences(s: string): string {
  // Handle ```json / ```JSON / ```json5 / ```yaml / bare ``` openers.
  // Tag can be any [a-z0-9] sequence; optional trailing newline. Some
  // models emit `\`\`\`json5\n` and we don't want `5` glued to the body.
  return s.replace(/^\s*```[a-z0-9]*\s*\n?/i, '').replace(/```\s*$/, '');
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`normalize: field "${key}" must be a non-empty string`);
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`normalize: field "${key}" must be an array of strings`);
  }
  return v as string[];
}

function validateDomain(value: string, field: string): Domain {
  if ((VALID_DOMAINS as readonly string[]).includes(value)) {
    return value as Domain;
  }
  throw new Error(
    `normalize: ${field} "${value}" is not one of [${VALID_DOMAINS.join(', ')}]`,
  );
}
