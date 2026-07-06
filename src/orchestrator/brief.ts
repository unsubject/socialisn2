// Weekly Ideation Brief orchestrator (redesign P1,
// docs/redesign/2026-07-05-ideation-redesign.md §5.2).
//
// Runs Sunday 18:00 ET (env WEEKLY_BRIEF_CRON via
// src/scheduler/brief-cron.ts). Gathers the week's signal — the
// candidate pool (any status, score ≥ cutoff), Simon's pick/pass/defer
// decisions WITH typed reasons (finally consumed: they were write-only
// since Phase 4), and the trending themes — makes the one
// frontier-model call (src/scoring/brief.ts), and upserts the result
// into `briefs` keyed on week_of. Delivery is RSS-first per interview
// Q5: the brief feed + /brief/:date page regenerate at the tail; no
// push.
//
// Mirrors runScoring's conventions: runs-row lifecycle (kind='brief'),
// assertWithinCeiling gate against the 'brief' bucket, recordCost with
// stage='weekly_brief', parse errors record their spend before failing.

import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { BUCKET_BRIEF } from '../cost/buckets.js';
import { assertWithinCeiling, CostCeilingHitError } from '../cost/ceiling.js';
import { recordCost } from '../cost/ledger.js';
import { generateAllFeeds } from '../rss/generate.js';
import { isValidIsoDate } from '../lib/iso-date.js';
import { findCollisionPairs } from '../scoring/collisions.js';
import {
  BriefParseError,
  generateBrief as defaultGenerateBrief,
  renderBriefMarkdown,
  type BriefCandidate,
  type BriefDecision,
  type BriefInput,
  type BriefResult,
} from '../scoring/brief.js';
import { computeTrending } from '../scoring/trending.js';

/** Ceiling-gate projection: Sonnet 4.5 at ~30k input + ~4k output
 *  tokens ≈ $0.15; $0.60 bounds a pathological max-token completion on
 *  the fallback path with the same "true bound" rationale as
 *  CURATE_PROJECTED_USD. */
const BRIEF_PROJECTED_USD = 0.6;
/** Prompt-size governor: the top-N by curation score enter the brief
 *  context. ~80 candidates × ~150 tokens lands ~12k input tokens. */
const BRIEF_MAX_CANDIDATES = 80;
const BRIEF_WINDOW_DAYS = 7;
const BRIEF_SOURCE_URLS_PER_CANDIDATE = 5;
const BRIEF_TRENDING_THEMES = 10;

export interface BriefRunOptions {
  /** Override the week_of date (YYYY-MM-DD); defaults to today (UTC). */
  weekOf?: string;
}

export interface BriefRunDependencies {
  /** LLM call; tests stub. Defaults to src/scoring/brief.ts. */
  generate?: (input: BriefInput) => Promise<BriefResult>;
  /** Post-run feed regeneration (same default gate as runScoring:
   *  no-op when RSS_PATH is empty). */
  regenerateFeeds?: (db: Db) => Promise<void>;
}

export interface BriefRunResult {
  runId: string;
  briefId: string | null;
  weekOf: string;
  pitchCount: number;
  totalCostUsd: number;
  status: 'completed' | 'failed';
  error?: string;
}

export async function runWeeklyBrief(
  db: Db,
  opts: BriefRunOptions = {},
  deps: BriefRunDependencies = {},
): Promise<BriefRunResult> {
  // Default generate threads the operator-configurable model through —
  // BRIEF_MODEL must actually reroute the call (codex review on #157),
  // while src/scoring/brief.ts stays env-free like the other pure
  // scoring modules.
  const generate =
    deps.generate ??
    ((input: BriefInput) => defaultGenerateBrief(input, { model: env.briefModel() }));
  const regenerateFeeds = deps.regenerateFeeds ?? defaultRegenerateFeeds;
  const weekOf = opts.weekOf ?? new Date().toISOString().slice(0, 10);
  // Guard before the ::date casts below AND before a runs row exists —
  // an invalid caller-supplied week is a programming error, not a run.
  if (!isValidIsoDate(weekOf)) {
    throw new Error(`runWeeklyBrief: invalid weekOf ${JSON.stringify(weekOf)}`);
  }

  const runId = uuidv7();
  await db.execute(sql`
    INSERT INTO runs (id, kind, status) VALUES (${runId}, 'brief', 'running')
  `);

  let totalCostUsd = 0;
  try {
    const input = await gatherBriefInput(db, weekOf);
    if (input.candidates.length === 0) {
      // A quiet week produces no brief rather than a padded one — same
      // no-padding stance as the curation cutoff (SPEC §9.4).
      await finalise(db, runId, 'completed', 0, totalCostUsd, 'empty_week');
      return {
        runId,
        briefId: null,
        weekOf,
        pitchCount: 0,
        totalCostUsd,
        status: 'completed',
        error: 'empty_week',
      };
    }

    await assertWithinCeiling(db, BRIEF_PROJECTED_USD, BUCKET_BRIEF);

    let result: BriefResult;
    try {
      result = await generate(input);
    } catch (err) {
      // Parse failures still cost money — record before failing (same
      // contract as the curate skip path, codex review on PR #107).
      if (err instanceof BriefParseError) {
        totalCostUsd += await recordCost(db, {
          runId,
          model: err.llm.model,
          inputTokens: err.llm.inputTokens,
          outputTokens: err.llm.outputTokens,
          usd: err.llm.usd,
          stage: 'weekly_brief',
        });
      }
      throw err;
    }
    totalCostUsd += await recordCost(db, {
      runId,
      model: result.llm.model,
      inputTokens: result.llm.inputTokens,
      outputTokens: result.llm.outputTokens,
      usd: result.llm.usd,
      stage: 'weekly_brief',
    });

    const briefId = uuidv7();
    const contentMd = renderBriefMarkdown(weekOf, result.pitches);
    const pitchesJsonb = sql.raw(
      "'" + JSON.stringify(result.pitches).replace(/'/g, "''") + "'",
    );
    // Upsert on week_of: a manual re-run regenerates the week's brief
    // in place (fresh id kept out of the conflict so the ORIGINAL id —
    // the feed GUID — survives regeneration).
    await db.execute(sql`
      INSERT INTO briefs (id, week_of, pitches, content_md, model, cost_usd)
      VALUES (
        ${briefId}, ${weekOf}::date, ${pitchesJsonb}::jsonb,
        ${contentMd}, ${result.llm.model}, ${result.llm.usd.toFixed(6)}
      )
      ON CONFLICT (week_of) DO UPDATE SET
        pitches = EXCLUDED.pitches,
        content_md = EXCLUDED.content_md,
        model = EXCLUDED.model,
        cost_usd = EXCLUDED.cost_usd,
        updated_at = NOW()
    `);

    // Tail: refresh feeds so brief.xml carries the new entry. Failure
    // is recorded but doesn't fail the run — the brief row is durable
    // and the next scoring run's regen tail will pick it up.
    let feedError: string | undefined;
    try {
      await regenerateFeeds(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[brief] feed regeneration failed:', err);
      feedError = `rss_regeneration_failed: ${msg.slice(0, 200)}`;
    }

    await finalise(db, runId, 'completed', result.pitches.length, totalCostUsd, feedError);
    return {
      runId,
      briefId,
      weekOf,
      pitchCount: result.pitches.length,
      totalCostUsd,
      status: 'completed',
      error: feedError,
    };
  } catch (err) {
    const msg =
      err instanceof CostCeilingHitError
        ? err.code
        : err instanceof Error
          ? err.message
          : String(err);
    await finalise(db, runId, 'failed', 0, totalCostUsd, msg.slice(0, 1_000));
    return {
      runId,
      briefId: null,
      weekOf,
      pitchCount: 0,
      totalCostUsd,
      status: 'failed',
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// input gathering
// ---------------------------------------------------------------------------

type CandidateRow = {
  id: string;
  headline: string;
  context_summary: string;
  primary_domain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  curation_score: number;
  curation_rationale: string | null;
  keywords: string[];
  tags: string[];
  is_exclusive: boolean;
  runs_seen: number;
  status: string;
  archive_overlap_links: unknown;
  source_urls: Array<{ title: string; url: string }> | null;
};

type DecisionRow = {
  action: 'pick' | 'pass' | 'defer';
  reason: string | null;
  headline: string;
};

async function gatherBriefInput(db: Db, weekOf: string): Promise<BriefInput> {
  // The week's pool: anything minted OR refreshed in the window,
  // regardless of status — a passed story is still context (the model
  // is told to treat passes as dead absent a new angle). Top-N by
  // curation score bounds the prompt.
  //
  // The window is anchored to weekOf, NOT NOW() (codex review on #157):
  // a manual rerun/backfill of an older week must gather THAT week —
  // an upsert keyed on week_of fed from NOW()'s window would overwrite
  // the old brief with current-week stories. Bounds: (weekOf - 7d,
  // weekOf + 1d) so the weekOf day itself is included. On the cron
  // path weekOf defaults to today, making this equivalent to the old
  // NOW()-anchored query.
  const windowEnd = sql`(${weekOf}::date + 1)`;
  const windowStart = sql`(${weekOf}::date - ${BRIEF_WINDOW_DAYS - 1}::int)`;
  const rows = await db.execute<CandidateRow>(sql`
    SELECT c.id, c.headline, c.context_summary, c.primary_domain, c.domains,
           c.temperature, c.trajectory, c.curation_score, c.curation_rationale,
           c.keywords, c.tags, c.is_exclusive, c.runs_seen, c.status,
           c.archive_overlap_links,
           (
             SELECT json_agg(json_build_object('title', s.title, 'url', s.url))
             FROM (
               SELECT ri.title, ri.url
               FROM items i
               JOIN raw_items ri ON ri.id = i.raw_item_id
               WHERE i.cluster_id = c.cluster_id
               ORDER BY ri.published_at DESC
               LIMIT ${BRIEF_SOURCE_URLS_PER_CANDIDATE}
             ) s
           ) AS source_urls
    FROM candidates c
    WHERE ((c.created_at >= ${windowStart} AND c.created_at < ${windowEnd})
           OR (c.updated_at >= ${windowStart} AND c.updated_at < ${windowEnd}))
    ORDER BY c.curation_score DESC, c.created_at DESC
    LIMIT ${BRIEF_MAX_CANDIDATES}
  `);

  const decisions = await db.execute<DecisionRow>(sql`
    SELECT f.action, f.reason, c.headline
    FROM feedback f
    JOIN candidates c ON c.id = f.candidate_id
    WHERE f.created_at >= ${windowStart}
      AND f.created_at < ${windowEnd}
    ORDER BY f.created_at DESC
  `);

  // NOTE: trending reflects the CURRENT in-window pool — on a backfill
  // of an older week it describes today's waves, not that week's.
  // Acceptable: it's garnish, and historical trending isn't stored.
  let trendingThemes: BriefInput['trendingThemes'] = [];
  try {
    const board = await computeTrending(db);
    trendingThemes = board.themes.slice(0, BRIEF_TRENDING_THEMES).map((t) => ({
      term: t.term,
      clusterCount: t.cluster_count,
      leadDomain: t.domains[0] ?? '',
    }));
  } catch (err) {
    // Trending is garnish — a failure degrades to a boardless brief.
    console.error('[brief] trending computation failed:', err);
  }

  // P2: computed cross-domain rhyme-band pairs. Degrades open — a
  // failure means the model falls back to P1 behavior (collisions it
  // notices itself). Log the matched distribution so the band
  // constants can be tuned against real Sundays (§5.3).
  let collisionPairs: BriefInput['collisionPairs'] = [];
  try {
    collisionPairs = await findCollisionPairs(db, weekOf, {
      windowDays: BRIEF_WINDOW_DAYS,
    });
    if (collisionPairs.length > 0) {
      const sims = collisionPairs.map((p) => p.similarity);
      console.log(
        `[brief] collision pairs in band: ${collisionPairs.length} ` +
          `(sim ${Math.min(...sims).toFixed(3)}-${Math.max(...sims).toFixed(3)})`,
      );
    } else {
      console.log('[brief] collision pairs in band: 0');
    }
  } catch (err) {
    console.error('[brief] collision detection failed:', err);
  }

  return {
    weekOf,
    candidates: rows.map(toBriefCandidate),
    decisions: decisions.map((d): BriefDecision => ({
      action: d.action,
      headline: d.headline,
      reason: d.reason,
    })),
    trendingThemes,
    collisionPairs,
  };
}

function toBriefCandidate(row: CandidateRow): BriefCandidate {
  // archive_overlap_links payload shape: { overlap, flagRelatedToRecentWork,
  // links: [{title, url, similarity, type}] } (run.ts archivePayload).
  const payload = row.archive_overlap_links as
    | { links?: Array<{ title?: unknown; url?: unknown; similarity?: unknown }> }
    | null;
  const archiveLinks = (payload?.links ?? [])
    .filter(
      (l): l is { title: string; url: string; similarity: number } =>
        typeof l.title === 'string' &&
        typeof l.url === 'string' &&
        typeof l.similarity === 'number',
    )
    .map((l) => ({ title: l.title, url: l.url, similarity: l.similarity }));
  return {
    id: row.id,
    headline: row.headline,
    contextSummary: row.context_summary,
    primaryDomain: row.primary_domain,
    domains: row.domains,
    temperature: row.temperature,
    trajectory: row.trajectory,
    curationScore: row.curation_score,
    curationRationale: row.curation_rationale,
    keywords: row.keywords,
    tags: row.tags,
    isExclusive: row.is_exclusive,
    runsSeen: row.runs_seen,
    status: row.status,
    sourceUrls: row.source_urls ?? [],
    archiveLinks,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function defaultRegenerateFeeds(db: Db): Promise<void> {
  const outputDir = env.rssPath();
  if (!outputDir) return;
  await generateAllFeeds(db, outputDir, env.publicHost());
}

async function finalise(
  db: Db,
  runId: string,
  status: 'completed' | 'failed',
  pitchCount: number,
  totalCostUsd: number,
  error: string | undefined,
): Promise<void> {
  await db.execute(sql`
    UPDATE runs
    SET completed_at = NOW(),
        status = ${status},
        candidates_count = ${pitchCount},
        total_cost_usd = ${totalCostUsd.toFixed(6)},
        error = ${error ?? null}
    WHERE id = ${runId}
      AND status = 'running'
  `);
}
