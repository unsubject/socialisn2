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
//   Stage 6 — curation via the curate-stage LLM (curate.ts; currently
//             gemini-3.5-flash). Persists only clusters scoring ≥ 60.
//   Stage 7 — INSERT candidates row.
//   Per-insert — for is_exclusive=true candidates, notifyExclusive
//               fires immediately (SPEC §11.3 "instant standalone
//               push, regardless of run cadence"). Errors logged but
//               not surfaced — losing one push shouldn't crowd out
//               the run-level error field.
//   Post-run — regenerate RSS feeds (SPEC §11.2) AND push the digest
//             to Telegram (SPEC §11.3). Both wrapped + their errors
//             joined into runs.error via `; ` — neither rolls back
//             persisted candidates.
//
// Cost ceiling per SPEC §12 — assertWithinCeiling fires BEFORE each
// LLM call (Stage 4 summarise + Stage 6 curate), with a conservative
// per-call projection sized to the model currently routed for that
// stage. CostCeilingHitError halts the loop; partial candidates
// already persisted remain (SPEC §12 "partial candidates are still
// persisted").
//
// External dependencies (summarise, curate, archiveSearcher,
// regenerateFeeds, notifyDigest, notifyExclusive) are dependency-
// injected so tests can stub the LLM / MCP / Telegram surface without
// touching env or fetch globals.

import { type SQL, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { DOMAIN_CONFIGS, domainWeight } from '../../config/domains.js';
import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { maybeFireCostAlert, type CostAlertPusher } from '../cost/alert.js';
import { BUCKET_ORCHESTRATOR } from '../cost/buckets.js';
import { assertWithinCeiling, CostCeilingHitError } from '../cost/ceiling.js';
import { recordCost } from '../cost/ledger.js';
import { generateAllFeeds } from '../rss/generate.js';
import { computeTrending, type TrendingBoard } from '../scoring/trending.js';
import { formatDigest, formatExclusivePush } from '../telegram/format.js';
import {
  pushPlainText as defaultPushPlainText,
  sendMessage as defaultSendTelegram,
} from '../telegram/push.js';
import {
  archiveOverlapDecision,
  computeArchiveOverlap,
  type ArchiveOverlapResult,
} from '../scoring/archive.js';
import {
  curateCluster,
  CurateParseError,
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
  SummariseParseError,
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

// Stage 4 summarise — Gemini 2.5 Flash-Lite at $0.10 / $0.40 per 1M.
// Empirical ~$0.0006/call; projection sits ~1.6× above so the gate
// can't underestimate a larger prompt.
const SUMMARISE_PROJECTED_USD = 0.001;
// Stage 6 curate — gemini-3.1-flash-lite since 2026-05-31 ($0.25/$1.50
// per 1M). A typical call lands ~$0.0006. BUT this gate must bound the
// WORST case the cap admits, not the typical: curate.ts raised maxTokens
// to 2048, and the fallback chain can serve the request via
// claude-haiku-4.5 ($1/$5 per 1M). Haiku at the full 2048-token cap +
// ~3k prompt input ≈ $0.0135, so the projection sits at $0.015 to keep
// assertWithinCeiling a true bound on the most expensive admissible
// curate call (a pathological 2048-token completion on the fallback
// path). At realistic Flash-Lite spend this never starves the queue —
// the gate only bites once orchestrator-bucket spend is within $0.015 of
// the ceiling, which day-to-day spend (~$0.50) never approaches.
const CURATE_PROJECTED_USD = 0.015;
const ACTIVE_WINDOW_DAYS = 7;
const CURATION_CUTOFF = 60;

export type RunKind = 'morning' | 'afternoon' | 'manual';

export interface RunOptions {
  kind: RunKind;
  topN?: number;
  /** Caller-supplied run id. When provided, runScoring SKIPS its own
   *  initial INSERT into runs — the caller is responsible for the row
   *  existing. Used by MCP run_now to return the runId synchronously
   *  before the (long) scoring run kicks off. */
  runId?: string;
}

/** Minimal shape passed to notifyExclusive — keeps the dep contract
 *  narrow so tests can hand-build the input without recreating the full
 *  candidate row. */
export interface ExclusivePushInput {
  id: string;
  headline: string;
  primaryDomain: string;
}

/** Aggregated input to the tail digest push — one entry per persisted
 *  candidate, with just what formatDigest needs. */
export interface DigestPushInput {
  runKind: RunKind;
  candidates: Array<{ primaryDomain: string; isExclusive: boolean }>;
  /** Trending board, computed for morning runs only — a once-a-day
   *  signal (afternoon overlaps heavily). undefined on afternoon/manual,
   *  where the digest renders the summary line alone. */
  trending?: TrendingBoard;
}

export interface RunDependencies {
  summarise?: (input: SummariseInput) => Promise<SummariseResult>;
  curate?: (input: CurateInput) => Promise<CurateResult>;
  archiveSearcher?: typeof defaultArchiveSearch;
  /** Post-run RSS regeneration. Default reads env.rssPath() and no-ops
   *  on empty. Tests stub here to assert the hook fired. */
  regenerateFeeds?: (db: Db) => Promise<void>;
  /** Tail digest push to Telegram. Default reads env.telegramBotToken()
   *  + telegramChatId() and no-ops on empty. Tests stub. */
  notifyDigest?: (input: DigestPushInput) => Promise<void>;
  /** Per-insert exclusive push to Telegram. Default reads same env
   *  and no-ops on empty. Tests stub. */
  notifyExclusive?: (input: ExclusivePushInput) => Promise<void>;
  /** Plain-text push used by the 80% cost-alert fire path (Obs-2).
   *  Default wraps src/telegram/push.ts:pushPlainText with the same
   *  env-gated no-op as the other Telegram hooks. Tests inject a spy
   *  here to assert fire/no-fire without a real round-trip. */
  notifyCostAlert?: CostAlertPusher;
}

export interface RunResult {
  runId: string;
  clustersConsidered: number;
  clustersAdvancedToStage4: number;
  clustersDroppedByArchive: number;
  clustersFlaggedRelatedToRecentWork: number;
  clustersBelowCutoff: number;
  /** Per-cluster summarise-stage (Stage 4) exceptions caught and
   *  skipped — malformed JSON, out-of-range keyword count, etc. from the
   *  summarise LLM. Mirrors clustersFailedAtCurate: the run continues
   *  with the next cluster instead of aborting. */
  clustersFailedAtSummarise: number;
  /** Per-cluster curate-stage exceptions caught and skipped — usually
   *  malformed-JSON parses from the curate LLM. The run continues with
   *  the next cluster instead of aborting; the count surfaces via
   *  /status so a spike is visible without a log dive. */
  clustersFailedAtCurate: number;
  candidatesPersisted: number;
  totalCostUsd: number;
  status: 'completed' | 'failed';
  /** Non-empty when status='completed' with halt reason
   *  ('cost_ceiling_hit') OR a tail-hook failure (RSS regen, digest
   *  push). Multiple causes joined with `; `. */
  error?: string;
}

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
  const notifyDigest = deps.notifyDigest ?? defaultNotifyDigest;
  const notifyExclusive = deps.notifyExclusive ?? defaultNotifyExclusive;
  const notifyCostAlert = deps.notifyCostAlert ?? defaultNotifyCostAlert;
  const topN = opts.topN ?? 200;

  const runId = opts.runId ?? uuidv7();
  if (!opts.runId) {
    // No caller-supplied id — runScoring owns the runs row lifecycle
    // and does the INSERT here. When opts.runId IS provided, the
    // caller (MCP run_now) has already inserted the row so the id is
    // reachable for synchronous return.
    await db.execute(sql`
      INSERT INTO runs (id, kind, status)
      VALUES (${runId}, ${opts.kind}, 'running')
    `);
  }

  const stats = {
    clustersConsidered: 0,
    clustersAdvancedToStage4: 0,
    clustersDroppedByArchive: 0,
    clustersFlaggedRelatedToRecentWork: 0,
    clustersBelowCutoff: 0,
    clustersFailedAtSummarise: 0,
    clustersFailedAtCurate: 0,
    candidatesPersisted: 0,
    totalCostUsd: 0,
  };
  let halt: { reason: string; err: Error } | null = null;
  // Aggregated per-domain + exclusive list for the tail digest push.
  const digestCandidates: DigestPushInput['candidates'] = [];

  try {
    const clusters = await db.execute<ClusterRow>(sql`
      SELECT id, centroid::text AS centroid, primary_domain,
             domains, item_count, first_seen_at
      FROM clusters
      WHERE status = 'active'
        AND last_seen_at > NOW() - make_interval(days => ${ACTIVE_WINDOW_DAYS})
    `);
    stats.clustersConsidered = clusters.length;

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

    for (const cluster of top) {
      try {
        await assertWithinCeiling(db, SUMMARISE_PROJECTED_USD, BUCKET_ORCHESTRATOR);
      } catch (err) {
        if (err instanceof CostCeilingHitError) {
          halt = { reason: err.code, err };
          break;
        }
        throw err;
      }
      // Obs-2 — fire the 80% cost alert on the *non-throwing* path so it
      // lands once we've crossed but before the next Gemini call. Wrapped
      // in safeMaybeFireCostAlert so an alert-path failure can never
      // surface to runs.error (push errors are already surfaced by
      // alert.ts internally).
      await safeMaybeFireCostAlert(db, notifyCostAlert);

      const summariseItems = await loadClusterItems(db, cluster.id);
      if (summariseItems.length === 0) continue;

      // Stage 4 summarise — mirror the curate skip-on-error: a single
      // cluster's malformed/invalid summary (e.g. the 2026-06 recurring
      // off-vocabulary-tag failure, a bad keyword count, or unparseable
      // JSON) used to abort the ENTIRE run via the outer catch, capping a
      // ~147-candidate run at whatever had persisted before the bad
      // cluster (7-13). Skip the offending cluster, record its already-
      // incurred LLM cost (SummariseParseError carries the LlmCallResult),
      // count it, and continue. Network / ceiling errors still propagate.
      let summary: Awaited<ReturnType<typeof summarise>>;
      try {
        summary = await summarise({
          primaryDomain: cluster.primary_domain as Domain,
          items: summariseItems.map((i) => ({
            summaryEn: i.summary_en,
            contextEn: i.context_en,
            source: i.source_name,
            publishedAt: i.published_at,
          })),
        });
      } catch (err: unknown) {
        if (err instanceof SummariseParseError) {
          stats.totalCostUsd += await recordCost(db, {
            runId,
            model: err.llm.model,
            inputTokens: err.llm.inputTokens,
            outputTokens: err.llm.outputTokens,
            usd: err.llm.usd,
            stage: 'stage4_summarise',
          });
          stats.clustersFailedAtSummarise += 1;
          console.warn(
            `[orchestrator] skipped cluster ${cluster.id} at Stage 4: ${err.message.slice(0, 240)} (cost recorded: $${err.llm.usd.toFixed(6)})`,
          );
          continue;
        }
        // Legacy text-predicate fallback for any future thrower that
        // forgets to wrap in SummariseParseError — skip without cost
        // recovery, logged loudly so the gap is operator-visible.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('headline:')) {
          stats.clustersFailedAtSummarise += 1;
          console.warn(
            `[orchestrator] skipped cluster ${cluster.id} at Stage 4 (UNWRAPPED, cost LOST): ${msg.slice(0, 240)}`,
          );
          continue;
        }
        throw err;
      }
      stats.clustersAdvancedToStage4 += 1;
      stats.totalCostUsd += await recordCost(db, {
        runId,
        model: summary.llm.model,
        inputTokens: summary.llm.inputTokens,
        outputTokens: summary.llm.outputTokens,
        usd: summary.llm.usd,
        stage: 'stage4_summarise',
      });

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
        await assertWithinCeiling(db, CURATE_PROJECTED_USD, BUCKET_ORCHESTRATOR);
      } catch (err) {
        if (err instanceof CostCeilingHitError) {
          halt = { reason: err.code, err };
          break;
        }
        throw err;
      }
      // Obs-2 — see note above the Stage-4 assertWithinCeiling block.
      await safeMaybeFireCostAlert(db, notifyCostAlert);

      // Curate is the only point in the loop where a parse-time
      // exception from the LLM (malformed JSON, missing required
      // field) used to abort the entire run via the outer catch.
      // Post-2026-05-30 Gemini swap, that meant one bad cluster's
      // output killed every other cluster's progress — see the
      // production incident on that date. Wrap the call so we skip
      // the offending cluster, surface it via clustersFailedAtCurate
      // / log, and continue. Network / ceiling errors still propagate.
      let curation: Awaited<ReturnType<typeof curate>>;
      try {
        curation = await curate({
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
      } catch (err: unknown) {
        // Codex review on PR #107 caught: the skip path discarded the
        // LLM usage on every parse failure. During a malformed-response
        // outage (the exact case this skip exists to tolerate), every
        // failed curate call consumed tokens but cost_ledger and
        // runs.total_cost_usd undercounted spend — the run kept making
        // LLM calls believing it was under budget when it wasn't.
        //
        // CurateParseError now carries the LlmCallResult; record the
        // cost BEFORE skipping so the ledger reflects actual spend.
        if (err instanceof CurateParseError) {
          stats.totalCostUsd += await recordCost(db, {
            runId,
            model: err.llm.model,
            inputTokens: err.llm.inputTokens,
            outputTokens: err.llm.outputTokens,
            usd: err.llm.usd,
            stage: 'stage6_curate',
          });
          stats.clustersFailedAtCurate += 1;
          console.warn(
            `[orchestrator] skipped cluster ${cluster.id} at Stage 6: ${err.message.slice(0, 240)} (cost recorded: $${err.llm.usd.toFixed(6)})`,
          );
          continue;
        }
        // Legacy text-predicate fallback for any future thrower that
        // forgets to wrap in CurateParseError. Preserves the original
        // skip semantics but without cost recovery — log loudly so the
        // gap is operator-visible.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('curate:')) {
          stats.clustersFailedAtCurate += 1;
          console.warn(
            `[orchestrator] skipped cluster ${cluster.id} at Stage 6 (UNWRAPPED, cost LOST): ${msg.slice(0, 240)}`,
          );
          continue;
        }
        throw err;
      }
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

      const candidateId = await insertCandidate(db, {
        runId,
        cluster,
        summary: summary.output,
        overlap,
        flagRelatedToRecentWork: decision.flagRelatedToRecentWork,
        curation: curation.output,
      });
      stats.candidatesPersisted += 1;
      digestCandidates.push({
        primaryDomain: cluster.primary_domain,
        isExclusive: cluster.exclusive.isExclusive,
      });

      // SPEC §11.3 — instant push for is_exclusive=true. Inside the
      // per-cluster loop, not at the tail, so the notification arrives
      // before the next cluster's LLM round-trip rather than after
      // every batch completes.
      if (cluster.exclusive.isExclusive) {
        await safeNotifyExclusive(notifyExclusive, {
          id: candidateId,
          headline: summary.output.headline,
          primaryDomain: cluster.primary_domain,
        });
      }
    }

    // Tail hooks. Each safe-wrapped; their errors are joined with the
    // halt reason (if any) into the final runs.error field.
    const feedError = await safeRegenerateFeeds(db, regenerateFeeds);
    // Trending board rides the morning digest only. Degrades to a
    // boardless digest if the aggregation throws — it must never block
    // the push (the per-domain summary is the load-bearing part).
    let trending: TrendingBoard | undefined;
    if (opts.kind === 'morning') {
      try {
        trending = await computeTrending(db);
      } catch (err) {
        console.error('[orchestrator] trending board computation failed:', err);
      }
    }
    const digestError = await safeNotifyDigest(notifyDigest, {
      runKind: opts.kind,
      candidates: digestCandidates,
      trending,
    });
    const finalError = combineErrors(halt?.reason, feedError, digestError);

    await finaliseRun(db, runId, 'completed', stats, finalError);
    return { runId, ...stats, status: 'completed', error: finalError };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await finaliseRun(db, runId, 'failed', stats, msg.slice(0, 1_000));
    return { runId, ...stats, status: 'failed', error: msg };
  }
}

// ---------------------------------------------------------------------------
// hooks — defaults + safe wrappers
// ---------------------------------------------------------------------------

async function defaultRegenerateFeeds(db: Db): Promise<void> {
  const outputDir = env.rssPath();
  if (!outputDir) return;
  await generateAllFeeds(db, outputDir, env.publicHost());
}

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
    return `rss_regeneration_failed: ${msg.slice(0, 200)}`;
  }
}

/** Default tail digest. No-ops when Telegram env unset. Reads env at
 *  call time so a per-run env change is picked up. */
async function defaultNotifyDigest(input: DigestPushInput): Promise<void> {
  if (!env.telegramBotToken() || !env.telegramChatId()) return;
  const text = formatDigest(input);
  const result = await defaultSendTelegram({ text, disableLinkPreview: true });
  if (!result.ok) {
    // Surface to safe wrapper so the failure reaches runs.error.
    throw new Error(result.description ?? 'unknown sendMessage error');
  }
}

async function safeNotifyDigest(
  hook: (input: DigestPushInput) => Promise<void>,
  input: DigestPushInput,
): Promise<string | undefined> {
  try {
    await hook(input);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orchestrator] telegram digest push failed:', err);
    return `telegram_digest_failed: ${msg.slice(0, 200)}`;
  }
}

/** Default per-insert exclusive push. Same env-gate as digest. */
async function defaultNotifyExclusive(input: ExclusivePushInput): Promise<void> {
  if (!env.telegramBotToken() || !env.telegramChatId()) return;
  // formatExclusivePush takes Pick<RenderCandidate, 'id'|'headline'|'primaryDomain'>
  // — ExclusivePushInput satisfies that shape exactly, so no hand-built
  // RenderCandidate is needed. (Pre-narrow this hand-built fake values
  // for unused fields; the narrowed type makes the contract explicit.)
  const text = formatExclusivePush(input);
  const result = await defaultSendTelegram({ text });
  if (!result.ok) {
    throw new Error(result.description ?? 'unknown sendMessage error');
  }
}

/** Default cost-alert pusher. Same env-gate as digest/exclusive — when
 *  Telegram isn't configured, swallow silently so dev environments
 *  don't trip on missing credentials. Throws on Telegram-side failure
 *  so maybeFireCostAlert can roll back the alert_state row. */
async function defaultNotifyCostAlert(text: string): Promise<void> {
  if (!env.telegramBotToken() || !env.telegramChatId()) return;
  await defaultPushPlainText(text);
}

/** Cost-alert wrapper — log only, never surface to runs.error. The
 *  push-failure rollback inside maybeFireCostAlert already handles
 *  retry semantics; the orchestrator only cares that the scoring loop
 *  continues. */
async function safeMaybeFireCostAlert(
  db: Db,
  hook: CostAlertPusher,
): Promise<void> {
  try {
    await maybeFireCostAlert(db, hook);
  } catch (err) {
    console.error('[orchestrator] cost-alert path failed:', err);
  }
}

/** Exclusive-push wrapper — log only, don't surface to runs.error.
 *  Exclusives can fail individually without contaminating the run-level
 *  signal (which would otherwise crowd out the digest error / halt
 *  reason). */
async function safeNotifyExclusive(
  hook: (input: ExclusivePushInput) => Promise<void>,
  input: ExclusivePushInput,
): Promise<void> {
  try {
    await hook(input);
  } catch (err) {
    console.error(
      `[orchestrator] telegram exclusive push failed for candidate ${input.id}:`,
      err,
    );
  }
}

function combineErrors(...parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length === 0 ? undefined : filtered.join('; ');
}

// ---------------------------------------------------------------------------
// existing helpers
// ---------------------------------------------------------------------------

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
    SELECT i.id, i.summary_en, i.context_en,
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

async function insertCandidate(
  db: Db,
  input: CandidateInsertInput,
): Promise<string> {
  const candidateId = uuidv7();
  const halfLifeHours = DOMAIN_CONFIGS[input.cluster.primary_domain as Domain]
    .recencyHalfLifeHours;
  const expiresIso = new Date(
    Date.now() + halfLifeHours * 3_600_000,
  ).toISOString();
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
  return candidateId;
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
    clustersFailedAtSummarise: number;
    clustersFailedAtCurate: number;
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
    clusters_failed_at_summarise: stats.clustersFailedAtSummarise,
    clusters_failed_at_curate: stats.clustersFailedAtCurate,
  };
  // Phase 2.b: gate the UPDATE on `status='running'` so a legitimate
  // long-running pass that the watchdog already flipped to 'failed'
  // (because it exceeded the 90-min stuck-runs threshold) can't be
  // overwritten back to 'completed' here. The watchdog's audit signal
  // — the operator's only way to see "this run took longer than the
  // agreed ceiling" — would otherwise be silently lost. With the
  // predicate, finaliseRun becomes a no-op in the race case and the
  // watchdog's verdict stands. The common (non-racing) path is
  // unchanged: the row still has status='running' when we update it.
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
      AND status = 'running'
  `);
}

function textArrayLiteral(items: string[]): SQL {
  if (items.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    items.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;
}

export type { SummariseInput, SummariseResult } from '../scoring/headline.js';
export type { CurateInput, CurateResult } from '../scoring/curate.js';
export type { ArchiveMatch } from '../lib/two_brain_client.js';
