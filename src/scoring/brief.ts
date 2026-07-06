// Weekly Ideation Brief generation (redesign P1,
// docs/redesign/2026-07-05-ideation-redesign.md §5.2).
//
// PURE TRANSFORMATION, mirroring curate.ts: the caller (the weekly
// orchestrator in src/orchestrator/brief.ts) gathers the week's signal
// from the DB and threads a BriefInput in; this module makes the one
// frontier-model call, parses/validates the pitches, and renders the
// markdown + HTML bodies. No DB access here.
//
// Model: claude-sonnet-4.5 via LiteLLM (env BRIEF_MODEL), fallback to
// gemini-3.5-flash per config/litellm.yaml. This is the single call in
// the system where frontier quality is worth the price — one call per
// week, and the output IS the product (episode pitches), not an
// intermediate filter signal.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type LlmCallResult, llmCall } from '../lib/llm.js';
import { escapeHtml } from '../lib/escape.js';

const SYSTEM_PROMPT_PATH = fileURLToPath(
  new URL('../../config/prompts/brief.txt', import.meta.url),
);
const POSITIONING_PATH = fileURLToPath(
  new URL('../../config/positioning.md', import.meta.url),
);
const SYSTEM_PROMPT = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
const POSITIONING = readFileSync(POSITIONING_PATH, 'utf-8');

const DEFAULT_MODEL = 'claude-sonnet-4.5';
/** Pitches are ~200-300 tokens each; 5 pitches + JSON overhead lands
 *  well under 4k. 8k leaves the same structural headroom rationale as
 *  curate.ts's 2048 (reasoning-token insurance on fallback models). */
const MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// input shapes — what the orchestrator gathers from the week's pool
// ---------------------------------------------------------------------------

export interface BriefCandidate {
  id: string;
  headline: string;
  contextSummary: string;
  primaryDomain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  curationScore: number;
  curationRationale: string | null;
  keywords: string[];
  tags: string[];
  isExclusive: boolean;
  runsSeen: number;
  status: string;
  /** Source URLs from the cluster's items — the only URLs the model may
   *  cite as evidence. */
  sourceUrls: Array<{ title: string; url: string }>;
  /** Archive matches in the 0.70-0.85 "related to prior work" band —
   *  sequel/callback material. */
  archiveLinks: Array<{ title: string; url: string; similarity: number }>;
}

export interface BriefDecision {
  action: 'pick' | 'pass' | 'defer';
  headline: string;
  reason: string | null;
}

export interface BriefTrendingTerm {
  term: string;
  clusterCount: number;
  leadDomain: string;
}

export interface BriefInput {
  /** ISO date (YYYY-MM-DD) of the Sunday the brief is generated for. */
  weekOf: string;
  candidates: BriefCandidate[];
  decisions: BriefDecision[];
  trendingThemes: BriefTrendingTerm[];
  /** P2: computed cross-domain rhyme-band pairs (src/scoring/
   *  collisions.ts). Candidates for bisociation, judged by the brief
   *  model inside the same call. */
  collisionPairs: CollisionPairInput[];
}

export interface CollisionPairInput {
  aCandidateId: string;
  aHeadline: string;
  aDomain: string;
  bCandidateId: string;
  bHeadline: string;
  bDomain: string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// output shapes
// ---------------------------------------------------------------------------

export interface BriefPitch {
  hook: string;
  thesis: string;
  steelman: string;
  break: string;
  whyNow: string;
  fit: string;
  collision?: string;
  evidence: Array<{ title: string; url: string }>;
  candidateIds: string[];
}

export interface BriefResult {
  pitches: BriefPitch[];
  llm: LlmCallResult;
}

export interface BriefOptions {
  model?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  systemPromptOverride?: string;
}

/** Parse/validation failures carry the LlmCallResult so the caller can
 *  record the spend before failing the run — same contract as
 *  CurateParseError (codex review on PR #107). */
export class BriefParseError extends Error {
  readonly code = 'brief_parse_error' as const;
  constructor(
    cause: Error,
    public readonly llm: LlmCallResult,
  ) {
    super(cause.message);
    this.name = 'BriefParseError';
    if (cause.stack) this.stack = cause.stack;
  }
}

/**
 * Generate the week's pitches. Throws BriefParseError on malformed
 * model output (with the LlmCallResult attached for cost recording).
 */
export async function generateBrief(
  input: BriefInput,
  opts: BriefOptions = {},
): Promise<BriefResult> {
  const systemContent =
    opts.systemPromptOverride ??
    `${SYSTEM_PROMPT}\n\n=== Positioning ===\n${POSITIONING}`;

  const llm = await llmCall({
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: JSON.stringify(toWireShape(input), null, 2) },
    ],
    // Higher than curate's 0.3: pitch generation is a creative task —
    // hooks and collisions benefit from variance; the JSON scaffold and
    // validation below keep the structure honest.
    temperature: 0.7,
    responseFormat: { type: 'json_object' },
    maxTokens: MAX_TOKENS,
    fetchFn: opts.fetchFn,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });

  try {
    return { pitches: parseAndValidate(llm.text, input), llm };
  } catch (err) {
    throw new BriefParseError(
      err instanceof Error ? err : new Error(String(err)),
      llm,
    );
  }
}

/** Wire shape: snake_case, compact — one entry per candidate with just
 *  what the prompt documents. */
function toWireShape(input: BriefInput): Record<string, unknown> {
  return {
    week_of: input.weekOf,
    candidates: input.candidates.map((c) => ({
      id: c.id,
      headline: c.headline,
      context_summary: c.contextSummary,
      primary_domain: c.primaryDomain,
      domains: c.domains,
      temperature: c.temperature,
      trajectory: c.trajectory,
      curation_score: c.curationScore,
      curation_rationale: c.curationRationale,
      keywords: c.keywords,
      tags: c.tags,
      is_exclusive: c.isExclusive,
      runs_seen: c.runsSeen,
      status: c.status,
      source_urls: c.sourceUrls,
      archive_links: c.archiveLinks,
    })),
    decisions: input.decisions.map((d) => ({
      action: d.action,
      headline: d.headline,
      reason: d.reason,
    })),
    trending_themes: input.trendingThemes.map((t) => ({
      term: t.term,
      cluster_count: t.clusterCount,
      lead_domain: t.leadDomain,
    })),
    collision_pairs: input.collisionPairs.map((p) => ({
      a_candidate_id: p.aCandidateId,
      a_headline: p.aHeadline,
      a_domain: p.aDomain,
      b_candidate_id: p.bCandidateId,
      b_headline: p.bHeadline,
      b_domain: p.bDomain,
      similarity: Number(p.similarity.toFixed(3)),
    })),
  };
}

// Same trailing-comma tolerance as curate.ts (see its stripTrailingCommas
// docblock for scope + false-positive analysis) — fallback models on the
// brief's litellm chain include Gemini, which emits them routinely.
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parse and validate the model response. Exposed for unit tests.
 * Validation is structural + referential: every pitch field present and
 * non-empty, 1-6 pitches, evidence URLs and candidate_ids drawn from
 * the provided input (anti-hallucination guard).
 */
export function parseAndValidate(text: string, input: BriefInput): BriefPitch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(stripTrailingCommas(text));
    } catch {
      throw new Error(`brief: unparseable JSON: ${text.slice(0, 200)}`);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || !('pitches' in parsed)) {
    throw new Error('brief: response missing "pitches"');
  }
  const rawPitches = (parsed as { pitches: unknown }).pitches;
  if (!Array.isArray(rawPitches) || rawPitches.length === 0 || rawPitches.length > 6) {
    throw new Error(
      `brief: expected 1-6 pitches, got ${Array.isArray(rawPitches) ? rawPitches.length : typeof rawPitches}`,
    );
  }

  const knownIds = new Set(input.candidates.map((c) => c.id));
  const knownUrls = new Set(
    input.candidates.flatMap((c) => c.sourceUrls.map((s) => s.url)),
  );

  return rawPitches.map((raw, i) => {
    const p = raw as Record<string, unknown>;
    const str = (key: string): string => {
      const v = p[key];
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`brief: pitch ${i + 1} missing/empty "${key}"`);
      }
      return v.trim();
    };
    const evidence = Array.isArray(p.evidence) ? p.evidence : [];
    const validEvidence = evidence
      .filter(
        (e): e is { title: string; url: string } =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as { title?: unknown }).title === 'string' &&
          typeof (e as { url?: unknown }).url === 'string',
      )
      // Anti-hallucination: only URLs that exist in the provided pool.
      .filter((e) => knownUrls.has(e.url));
    if (validEvidence.length === 0) {
      throw new Error(`brief: pitch ${i + 1} has no valid evidence links`);
    }
    const candidateIds = (Array.isArray(p.candidate_ids) ? p.candidate_ids : [])
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => knownIds.has(id));
    const collision =
      typeof p.collision === 'string' && p.collision.trim() !== ''
        ? p.collision.trim()
        : undefined;

    return {
      hook: str('hook'),
      thesis: str('thesis'),
      steelman: str('steelman'),
      break: str('break'),
      whyNow: str('why_now'),
      fit: str('fit'),
      collision,
      evidence: validEvidence,
      candidateIds,
    };
  });
}

// ---------------------------------------------------------------------------
// rendering — markdown (MCP / stored body) + HTML (page / feed content)
// ---------------------------------------------------------------------------

export function renderBriefMarkdown(weekOf: string, pitches: BriefPitch[]): string {
  const parts: string[] = [`# Weekly Ideation Brief — ${weekOf}`, ''];
  pitches.forEach((p, i) => {
    parts.push(`## Pitch ${i + 1}: ${p.hook}`, '');
    parts.push(`- **Thesis:** ${p.thesis}`);
    parts.push(`- **Steelman:** ${p.steelman}`);
    parts.push(`- **Where it breaks:** ${p.break}`);
    parts.push(`- **Why now:** ${p.whyNow}`);
    parts.push(`- **Fit:** ${p.fit}`);
    if (p.collision) parts.push(`- **Collision:** ${p.collision}`);
    parts.push(`- **Evidence:**`);
    for (const e of p.evidence) parts.push(`  - [${e.title}](${e.url})`);
    parts.push('');
  });
  return parts.join('\n');
}

/** Body-only HTML (no <html>/<head>) — embedded both in the /brief page
 *  shell and in the feed's content:encoded. Every model-derived string
 *  flows through escapeHtml, same discipline as render-detail.ts. */
export function renderBriefBodyHtml(pitches: BriefPitch[]): string {
  const sections = pitches.map((p, i) => {
    const rows: string[] = [
      `<h2>Pitch ${i + 1}: ${escapeHtml(p.hook)}</h2>`,
      '<dl>',
      `<dt>Thesis</dt><dd>${escapeHtml(p.thesis)}</dd>`,
      `<dt>Steelman</dt><dd>${escapeHtml(p.steelman)}</dd>`,
      `<dt>Where it breaks</dt><dd>${escapeHtml(p.break)}</dd>`,
      `<dt>Why now</dt><dd>${escapeHtml(p.whyNow)}</dd>`,
      `<dt>Fit</dt><dd>${escapeHtml(p.fit)}</dd>`,
    ];
    if (p.collision) {
      rows.push(`<dt>Collision</dt><dd>${escapeHtml(p.collision)}</dd>`);
    }
    rows.push('</dl>');
    rows.push('<ul>');
    for (const e of p.evidence) {
      rows.push(
        `<li><a href="${escapeHtml(e.url)}">${escapeHtml(e.title)}</a></li>`,
      );
    }
    rows.push('</ul>');
    return `<section>${rows.join('\n')}</section>`;
  });
  return sections.join('\n');
}
