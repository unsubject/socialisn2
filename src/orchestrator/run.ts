// Stages 3-7 of the scoring pipeline (SPEC §9) — the twice-daily run
// orchestrator. Cron-triggered at 05:00 ET (morning) and 14:00 ET
// (afternoon) per SPEC §9.
//
// What this runs:
//
//   Stage 3 — heuristic ranking of active clusters; top 200 advance.
//   Stage 4 — cluster summarisation via Gemini Flash-Lite (headline.ts).
//   Stage 5 — archive_overlap via 2nd-brain MCP. Drops clusters with
//             overlap > 0.85 AND match within 90d; flags 0.70-0.85.
//   Stage 6 — curation via Sonnet (curate.ts). Persists only clusters
//             scoring ≥ 60.
//   Stage 7 — INSERT candidates row.
//   Post-run — when env.rssPath() is set, regenerate the 6 RSS feeds
//             per SPEC §11.2 ("Regenerated on every notify-telegram
//             event, i.e. after every scoring run"). Failures here
//             populate runs.error but do NOT roll back persisted
//             candidates — feed regeneration is a delivery concern.
//
// Cost ceiling per SPEC §12 — assertWithinCeiling fires BEFORE each
// Gemini / Sonnet call, with a conservative per-call projection.
// CostCeilingHitError halts the loop; partial candidates already
// persisted remain (SPEC §12 "partial candidates are still persisted").
// The run row is updated with status='completed' + error='cost_ceiling_hit'
// so /status surfaces the halt without treating it as a runtime failure.
//
// External dependencies (summarise, curate, archiveSearcher) are
// dependency-injected so tests can stub the LLM + MCP surface without
// touching the env or fetch globals.

import { type SQL, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { DOMAIN_CONFIGS, domainWeight } from '../../config/domains.js';
import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { assertWithinCeiling, CostCeilingHitError } from '../cost/ceiling.js';
import { recordCost } from '../cost/ledger.js';
import { generateAllFeeds } from '../rss/generate.js';
import {
  archiveOverlapDecision,
  computeArchiveOverlap,
  type ArchiveOverlapResult,
} from '../scoring/archive.js';
import {
  curateCluster,
  type CurateInput,
  type CurateResult,
} from '../scoring/curate.js';
import {
  computeExclusive,
  type ExclusiveResult,
} from '../scoring/exclusive.js';
import {
  computeHeuristic,
  selectTopN,
  type HeuristicResult,
} from '../scoring/heuristic.js';
import {
  summariseCluster,
  type SummariseInput,
  type SummariseResult,
} from '../scoring/headline.js';
import type { Domain } from '../scoring/normalize.js';
import {
  computeTemperature,
  type TemperatureResult,
} from '../scoring/temperature.js';
import {
  computeTrajectory,
  type TrajectoryResult,
} from '../scoring/trajectory.js';
import { archiveSearch as defaultArchiveSearch } from '../lib/two_brain_client.js';

// Conservative pre-call projections so a single call can't sneak under
// an exact-ceiling check. Real cost is recorded post-call.
//   Gemini Flash-Lite: ~$0.0006/call empirically (5K input + 250 output).
//   Sonnet 4.5:        ~$0.007/call empirically (1.5K input + 200 output).
const GEMINI_PROJECTED_USD = 0.001;
const SONNET_PROJECTED_USD = 0.008;

/** SPEC §9 active-cluster window — reuse the recency floor from the
 *  clustering join (7 days). Older clusters are not considered for scoring. */
const ACTIVE_WINDOW_DAYS = 7;

/** SPEC §9.4 cutoff — curate must score ≥ 60 to become a candidate. */
const CURATION_CUTOFF = 60;

export type RunKind = 'morning' | 'afternoon' | 'manual';

export interface RunOptions {
  kind: RunKind;
  /** Cap on clusters advanced to Stage 4. Default 200 per SPEC §9.1. */
  topN?: number;
}

export interface RunDependencies {
  /** Override Stage 4 (Gemini) — tests stub here. */
  summarise?: (input: SummariseInput) => Promise<SummariseResult>;
  /** Override Stage 6 (Sonnet) — tests stub here. */
  curate?: (input: CurateInput) => Promise<CurateResult>;
  /** Override Stage 5 (2nd-brain) — tests stub here. Same signature as
   *  src/lib/two_brain_client.archiveSearch. */
  archiveSearcher?: typeof defaultArchiveSearch;
  /** Override the post-run RSS regeneration — tests inject this when
   *  they want to assert the hook fired without touching the disk. The
   *  default reads env.rssPath() + env.publicHost() and writes to the
   *  configured static-output directory. */
  regenerateFeeds?: (db: Db) => Promise<void>;
}

export interface RunResult {
  runId: string;
  clustersConsidered: number;
  clustersAdvancedToStage4: number;
  clustersDroppedByArchive: number;
  clustersFlaggedRelatedToRecentWork: number;
  clustersBelowCutoff: number;
  candidatesPersisted: number;
  totalCostUsd: number;
  status: 'completed' | 'failed';
  /** Non-empty when status='completed' with halt reason ('cost_ceiling_hit')
   *  OR a post-run feed-regeneration failure. Multiple causes are joined
   *  with `; ` so the surface field carries both signals. */
  error?: string;
}

// Row shapes for db.execute<T>. Declared as `type` aliases (not
// `interface`) because drizzle's execute<T> requires T extends
// Record<string, unknown> and TS treats interface declarations as
// closed — no implicit index signature — so an interface here would
// fail to satisfy the constraint and the typecheck would reject the
// call. Type aliases of object literals are structurally Record-compatible.
type ClusterRow = {
  id: string;
  centroid: string;
  primary_domain: string;
  domains: string[];
  item_count: number;
  first_seen_at: string;
};

interface ScoredCluster extends ClusterRow {
  heuristicScore: number;
  heuristic: HeuristicResult;
  temperature: TemperatureResult;
  trajectory: TrajectoryResult;
  exclusive: ExclusiveResult;
}

export async function runScoring(
  db: Db,
  opts: RunOptions,
  deps: RunDependencies = {},
): Promise<RunResult> {
  const summarise = deps.summarise ?? summariseCluster;
  const curate = deps.curate ?? curateCluster;
  const archiveSearcher = deps.archiveSearcher ?? defaultArchiveSearch;
  const regenerateFeeds = deps.regenerateFeeds ?? defaultRegenerateFeeds;
  const topN = opts.topN ?? 200;

  const runId = uuidv7();
  await db.execute(sql`
    INSERT INTO runs (id, kind, status)
    VALUES (${runId}, ${opts.kind}, 'running')
  `);

  const stats = {
    clustersConsidered: 0,
    clustersAdvancedToStage4: 0,
    clustersDroppedByArchive: 0,
    clustersFlaggedRelatedToRecentWork: 0,
    clustersBelowCutoff: 0,
    candidatesPersisted: 0,
    totalCostUsd: 0,
  };
  let halt: { reason: string; err: Error } | null = null;

  try {
    // Stage 3 — fetch active clusters in the recency window.
    const clusters = await db.execute<ClusterRow>(sql`
      SELECT id,
             centroid::text AS centroid,
             primary_domain,
             domains,
             item_count,
             first_seen_at
      FROM clusters
      WHERE status = 'active'
        AND last_seen_at > NOW() - make_interval(days => ${ACTIVE_WINDOW_DAYS})
    `);
    stats.clustersConsidered = clusters.length;

    // Per-cluster signal computation. We score in-memory so the top-N
    // selection is a single sort — no second DB pass.
    const scored: ScoredCluster[] = [];
    for (const c of clusters) {
      const [temperature, trajectory, exclusive] = await Promise.all([
        computeTemperature(db, {
          clusterId: c.id,
          primaryDomain: c.primary_domain,
          itemCount: c.item_count,
        }),
        computeTrajectory(db, {
          clusterId: c.id,
          firstSeenAt: new Date(c.first_seen_at),
        }),
        computeExclusive(db, c.id),
      ]);
      const heuristic = await computeHeuristic(db, c.id, {
        isExclusive: exclusive.isExclusive,
        domainWeight: domainWeight(c.primary_domain as Domain),
      });
      scored.push({
        ...c,
        heuristicScore: heuristic.heuristicScore,
        heuristic,
        temperature,
        trajectory,
        exclusive,
      });
    }

    const top = selectTopN(scored, topN);

    // Stage 4-7 per cluster. We break on CostCeilingHitError but let
    // other errors propagate — the outer try/catch marks the run failed.
    for (const cluster of top) {
      try {
        await assertWithinCeiling(db, GEMINI_PROJECTED_USD);
      } catch (err) {
        if (err instanceof CostCeilingHitError) {
          halt = { reason: err.code, err };
          break;
        }
        throw err;
      }

      const summariseItems = await loadClusterItems(db, cluster.id);
      if (summariseItems.length === 0) {
        // Cluster has no items rows (shouldn't happen post-Phase 2 but be
        // defensive). Skip silently; the cluster will be re-evaluated
        // next run.
        continue;
      }

      const summary = await summarise({
        primaryDomain: cluster.primary_domain as Domain,
        items: summariseItems.map((i) => ({
          summaryEn: i.summary_en,
          contextEn: i.context_en,
          source: i.source_name,
          publishedAt: i.published_at,
        })),
      });
      stats.clustersAdvancedToStage4 += 1;
      stats.totalCostUsd += await recordCost(db, {
        runId,
        model: summary.llm.model,
        inputTokens: summary.llm.inputTokens,
        outputTokens: summary.llm.outputTokens,
        usd: summary.llm.usd,
        stage: 'stage4_summarise',
      });

      // Stage 5 — archive overlap. Graceful by construction (returns
      // {overlap: 0, links: []} when 2nd-brain is unreachable / missing
      // tool), so no cost or ceiling check needed here.
      const centroidVec = parsePgvectorLiteral(cluster.centroid);
      const overlap: ArchiveOverlapResult = await computeArchiveOverlap(
        centroidVec,
        { searcher: archiveSearcher },
      );
      const decision = archiveOverlapDecision(overlap);
      if (decision.drop) {
        stats.clustersDroppedByArchive += 1;
        continue;
      }
      if (decision.flagRelatedToRecentWork) {
        stats.clustersFlaggedRelatedToRecentWork += 1;
      }

      try {
        await assertWithinCeiling(db, SONNET_PROJECTED_USD);
      } catch (err) {
        if (err instanceof CostCeilingHitError) {
          halt = { reason: err.code, err };
          break;
        }
        throw err;
      }

      const curation = await curate({
        headline: summary.output.headline,
        contextSummary: summary.output.contextSummary,
        keywords: summary.output.keywords,
        tags: summary.output.tags,
        primaryDomain: cluster.primary_domain as Domain,
        sources: dedupeSources(summariseItems),
        temperature: cluster.temperature.temperature,
        trajectory: cluster.trajectory.trajectory,
        archiveOverlap: overlap.overlap,
        archiveOverlapLinks: overlap.links.map((l) => ({
          title: l.title,
          url: l.url,
          similarity: l.similarity,
          type: l.type,
        })),
        isExclusive: cluster.exclusive.isExclusive,
      });
      stats.totalCostUsd += await recordCost(db, {
        runId,
        model: curation.llm.model,
        inputTokens: curation.llm.inputTokens,
        outputTokens: curation.llm.outputTokens,
        usd: curation.llm.usd,
        stage: 'stage6_curate',
      });

      if (curation.output.curationScore < CURATION_CUTOFF) {
        stats.clustersBelowCutoff += 1;
        continue;
      }

      await insertCandidate(db, {
        runId,
        cluster,
        summary: summary.output,
        overlap,
        flagRelatedToRecentWork: decision.flagRelatedToRecentWork,
        curation: curation.output,
      });
      stats.candidatesPersisted += 1;
    }

    // Post-run: regenerate RSS feeds per SPEC §11.2. Wrapped in its own
    // try so a feed-write failure becomes a recorded error rather than a
    // run rollback — candidates are already persisted, the feed file
    // can be regenerated on the next run.
    const feedError = await safeRegenerateFeeds(db, regenerateFeeds);
    const finalError = combineErrors(halt?.reason, feedError);

    await finaliseRun(db, runId, 'completed', stats, finalError);
    return {
      runId,
      ...stats,
      status: 'completed',
      error: finalError,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await finaliseRun(db, runId, 'failed', stats, msg.slice(0, 1_000));
    return {
      runId,
      ...stats,
      status: 'failed',
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Default RSS regenerate hook. Reads `env.rssPath()` and `env.publicHost()`
 * at call time so a per-run env change (test fixtures setting `RSS_PATH`
 * before invoking) is picked up. No-ops when `RSS_PATH` is empty — that's
 * the contract for non-prod environments that don't need static feeds.
 */
async function defaultRegenerateFeeds(db: Db): Promise<void> {
  const outputDir = env.rssPath();
  if (!outputDir) return;
  await generateAllFeeds(db, outputDir, env.publicHost());
}

/**
 * Run the regenerate hook, never throwing. Returns a short error
 * description if it failed, or `undefined` on success / no-op. Logged
 * to stderr so ops sees the cause; the `runs.error` field carries the
 * short form.
 */
async function safeRegenerateFeeds(
  db: Db,
  hook: (db: Db) => Promise<void>,
): Promise<string | undefined> {
  try {
    await hook(db);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orchestrator] RSS regeneration failed:', err);
    // Cap so a 5-line stack doesn't blow up runs.error and crowd out
    // the halt reason in the same field.
    return `rss_regeneration_failed: ${msg.slice(0, 200)}`;
  }
}

function combineErrors(...parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length === 0 ? undefined : filtered.join('; ');
}

// Same `type` (not `interface`) treatment as ClusterRow above — see
// the comment there for why db.execute<T> rejects closed interfaces.
type ClusterItemRow = {
  id: string;
  summary_en: string;
  context_en: string;
  source_id: string;
  source_name: string;
  authority_score: number;
  published_at: string;
};

async function loadClusterItems(db: Db, clusterId: string): Promise<ClusterItemRow[]> {
  return db.execute<ClusterItemRow>(sql`
    SELECT i.id,
           i.summary_en,
           i.context_en,
           s.id            AS source_id,
           s.name          AS source_name,
           s.authority_score,
           ri.published_at
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    JOIN sources s    ON s.id  = ri.source_id
    WHERE i.cluster_id = ${clusterId}
    ORDER BY ri.published_at ASC
  `);
}

function dedupeSources(
  items: ClusterItemRow[],
): Array<{ name: string; authorityScore: number }> {
  const map = new Map<string, { name: string; authorityScore: number }>();
  for (const i of items) {
    if (!map.has(i.source_id)) {
      map.set(i.source_id, { name: i.source_name, authorityScore: i.authority_score });
    }
  }
  return Array.from(map.values());
}

function parsePgvectorLiteral(s: string): number[] {
  const parsed = JSON.parse(s) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'number')) {
    throw new Error(`runScoring: not a number array centroid: ${s.slice(0, 80)}`);
  }
  return parsed as number[];
}

interface CandidateInsertInput {
  runId: string;
  cluster: ScoredCluster;
  summary: {
    headline: string;
    contextSummary: string;
    keywords: string[];
    tags: string[];
  };
  overlap: ArchiveOverlapResult;
  flagRelatedToRecentWork: boolean;
  curation: { curationScore: number; curationRationale: string };
}

async function insertCandidate(db: Db, input: CandidateInsertInput): Promise<void> {
  const candidateId = uuidv7();
  // expires_at per SPEC §9.6: "compute from domain decay". v1 picks the
  // half-life so the candidate decays to 50% relevance at expiry —
  // matches the spec's example ("economy: NOW + 48h").
  const halfLifeHours = DOMAIN_CONFIGS[input.cluster.primary_domain as Domain]
    .recencyHalfLifeHours;
  const expiresIso = new Date(
    Date.now() + halfLifeHours * 3_600_000,
  ).toISOString();

  // archive_overlap_links includes the flag in a wrapper so downstream
  // RSS / MCP can render the "related to recent work" UX without an extra
  // candidate-side column. Mirrors how PR 51 designed the flag to project
  // into the existing candidates schema.
  const archivePayload = {
    overlap: input.overlap.overlap,
    flagRelatedToRecentWork: input.flagRelatedToRecentWork,
    links: input.overlap.links,
  };

  await db.execute(sql`
    INSERT INTO candidates (
      id, cluster_id, headline, context_summary,
      primary_domain, domains,
      temperature, trajectory,
      is_exclusive, exclusive_source_id,
      similarity_score, archive_overlap, archive_overlap_links,
      curation_score, curation_rationale,
      keywords, tags, status,
      generated_run_id, expires_at
    ) VALUES (
      ${candidateId},
      ${input.cluster.id},
      ${input.summary.headline},
      ${input.summary.contextSummary},
      ${input.cluster.primary_domain},
      ${textArrayLiteral(input.cluster.domains)},
      ${input.cluster.temperature.temperature},
      ${input.cluster.trajectory.trajectory},
      ${input.cluster.exclusive.isExclusive},
      ${input.cluster.exclusive.exclusiveSourceId},
      ${input.cluster.heuristicScore},
      ${input.overlap.overlap},
      ${sql.raw("'" + JSON.stringify(archivePayload).replace(/'/g, "''") + "'")}::jsonb,
      ${input.curation.curationScore},
      ${input.curation.curationRationale},
      ${textArrayLiteral(input.summary.keywords)},
      ${textArrayLiteral(input.summary.tags)},
      'new',
      ${input.runId},
      ${expiresIso}::timestamptz
    )
  `);
}

async function finaliseRun(
  db: Db,
  runId: string,
  status: 'completed' | 'failed',
  stats: {
    clustersConsidered: number;
    clustersAdvancedToStage4: number;
    clustersDroppedByArchive: number;
    clustersFlaggedRelatedToRecentWork: number;
    clustersBelowCutoff: number;
    candidatesPersisted: number;
    totalCostUsd: number;
  },
  error: string | undefined,
): Promise<void> {
  const metadata = {
    clusters_dropped_by_archive: stats.clustersDroppedByArchive,
    clusters_flagged_related_to_recent_work: stats.clustersFlaggedRelatedToRecentWork,
    clusters_below_cutoff: stats.clustersBelowCutoff,
    clusters_advanced_to_stage4: stats.clustersAdvancedToStage4,
  };
  await db.execute(sql`
    UPDATE runs
    SET completed_at   = NOW(),
        status         = ${status},
        clusters_count = ${stats.clustersConsidered},
        candidates_count = ${stats.candidatesPersisted},
        total_cost_usd = ${stats.totalCostUsd.toFixed(6)},
        error          = ${error ?? null},
        metadata       = ${sql.raw("'" + JSON.stringify(metadata).replace(/'/g, "''") + "'")}::jsonb
    WHERE id = ${runId}
  `);
}

function textArrayLiteral(items: string[]): SQL {
  if (items.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    items.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;
}

// Re-export for callers that want to construct a SummariseInput or
// CurateInput from cluster items directly (smoke fixtures, tests).
export type { SummariseInput, SummariseResult } from '../scoring/headline.js';
export type { CurateInput, CurateResult } from '../scoring/curate.js';
export type { ArchiveMatch } from '../lib/two_brain_client.js';
