// Trending themes + keywords aggregation over the in-window candidate
// pool. Two surfaces consume this:
//   - the `trending_keywords` MCP tool (on-demand board)
//   - the morning Telegram digest (auto-push) — wired separately
//
// Design notes (see the trending-board PR scope):
//   * THEMES (the editorial `tags`) are the primary axis. Tags are
//     curated at the curate stage, so they de-noise the arXiv/academic
//     flood for free — most ML churn is untagged or only `ai-safety`.
//     KEYWORDS are the secondary detail.
//   * "Trending" is a heat-weighted distinct-CLUSTER count, NOT raw
//     candidate-row frequency. Migration 018 (supersede) now guarantees
//     at most one status='new' row per cluster, but the cluster_id
//     dedup stays as defence-in-depth (pre-018 rows, one-story-two-
//     clusters forks); and a single high-volume outlet (arXiv) floods
//     many warm clusters. Weighting hot/rising above warm/declining —
//     plus the P0.5 arXiv-only exclusion in computeTrending's WHERE —
//     keeps a genuine multi-outlet hot story above the academic churn.
//   * Weights are named constants, deliberately simple for v1 — tune
//     against a week of real boards rather than guessing finer now.
//   * These are EDITORIAL descriptors for topic timeliness, not
//     platform search-volume / SEO terms (socialisn2 is RSS-only, no
//     platform data). Title/keyword shaping for YouTube/Facebook is a
//     separate, human/on-demand step.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

/** Minimal candidate shape the aggregation needs. Domain attribution is
 *  by primaryDomain only (the candidate's full `domains` array is not
 *  read), so it is deliberately absent here. */
export interface TrendingRow {
  clusterId: string;
  headline: string;
  primaryDomain: string;
  temperature: string;
  trajectory: string;
  keywords: string[];
  tags: string[];
}

export interface TrendingEntry {
  /** The tag (theme) or keyword. */
  term: string;
  /** Distinct in-window clusters carrying this term. */
  cluster_count: number;
  /** Heat-weighted score — the ranking key. */
  score: number;
  /** Mean heat (0=cold, 1=warm, 2=over_saturated, 3=hot) of those clusters. */
  mean_heat: number;
  /** Primary domains the term spans, ordered by how much each drives the
   *  term (descending summed cluster weight; alphabetical tie-break). So
   *  domains[0] is the real lead domain, not the lexically-first one. */
  domains: string[];
  /** Headline of the highest-scoring (heat×trajectory) cluster carrying this term. */
  top_headline: string;
}

export interface TrendingBoard {
  /** Distinct in-window clusters considered (post-dedup). */
  cluster_count: number;
  /** Curated editorial themes, ranked. The primary, de-noised axis. */
  themes: TrendingEntry[];
  /** Raw keywords, ranked. Secondary detail. */
  keywords: TrendingEntry[];
}

export interface TrendingOpts {
  /** Restrict to one primary domain. */
  domain?: string;
  /** Max themes and max keywords returned (each). */
  limit?: number;
  /** Min distinct clusters for a KEYWORD to qualify (themes always ≥1). */
  minClusters?: number;
}

// Heat dominates the score so a genuinely spiking story outranks a
// high-volume warm flood. `over_saturated` sits below `hot` — it's
// past peak (already everywhere), so worth less as a fresh angle.
const HEAT_WEIGHT: Record<string, number> = {
  cold: 0.25,
  warm: 1,
  over_saturated: 2,
  hot: 3,
};

// Momentum: rising/peaking beat declining. `new` is the neutral 1.
const TRAJ_WEIGHT: Record<string, number> = {
  new: 1,
  rising: 1.5,
  peaking: 1.25,
  declining: 0.5,
};

// Heat as an ordinal for the mean_heat readout (independent of the
// weight ramp above).
const HEAT_RANK: Record<string, number> = {
  cold: 0,
  warm: 1,
  over_saturated: 2,
  hot: 3,
};

function clusterWeight(row: TrendingRow): number {
  return (HEAT_WEIGHT[row.temperature] ?? 1) * (TRAJ_WEIGHT[row.trajectory] ?? 1);
}

// Lowercase + strip everything but letters/numbers (Unicode-aware, so
// it works for both English and CJK headlines), collapsing whitespace.
// Used as the secondary dedup guard for the rare case where one story
// ends up under two cluster_ids (join-threshold fork / compaction merge).
function normalizeHeadline(headline: string): string {
  return headline.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

interface Agg {
  clusterCount: number;
  score: number;
  heatSum: number;
  /** primaryDomain → summed cluster weight, so the lead domain is the
   *  one that most drives the term (not the alphabetically-first). */
  domainWeights: Map<string, number>;
  topHeadline: string;
  topWeight: number;
}

function accumulate(
  map: Map<string, Agg>,
  term: string,
  row: TrendingRow,
  weight: number,
  heat: number,
): void {
  let agg = map.get(term);
  if (!agg) {
    agg = {
      clusterCount: 0,
      score: 0,
      heatSum: 0,
      domainWeights: new Map(),
      topHeadline: row.headline,
      topWeight: -Infinity,
    };
    map.set(term, agg);
  }
  agg.clusterCount += 1;
  agg.score += weight;
  agg.heatSum += heat;
  agg.domainWeights.set(
    row.primaryDomain,
    (agg.domainWeights.get(row.primaryDomain) ?? 0) + weight,
  );
  if (weight > agg.topWeight) {
    agg.topWeight = weight;
    agg.topHeadline = row.headline;
  }
}

function finalize(map: Map<string, Agg>, minClusters: number, limit: number): TrendingEntry[] {
  const entries: TrendingEntry[] = [];
  for (const [term, agg] of map) {
    if (agg.clusterCount < minClusters) continue;
    entries.push({
      term,
      cluster_count: agg.clusterCount,
      score: Math.round(agg.score * 100) / 100,
      mean_heat: Math.round((agg.heatSum / agg.clusterCount) * 100) / 100,
      // Lead domain = largest summed weight; alphabetical tie-break for
      // determinism.
      domains: [...agg.domainWeights.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([d]) => d),
      top_headline: agg.topHeadline,
    });
  }
  // Rank by score, then cluster_count, then term (stable + deterministic).
  entries.sort(
    (a, b) =>
      b.score - a.score ||
      b.cluster_count - a.cluster_count ||
      a.term.localeCompare(b.term),
  );
  return entries.slice(0, limit);
}

/**
 * Pure aggregation: rows in (caller orders by created_at DESC so the
 * latest row wins per cluster), ranked board out. No DB — this is the
 * unit-testable core that proves news-grade themes rank above the
 * arXiv flood.
 */
export function computeTrendingFromRows(
  rows: TrendingRow[],
  opts: TrendingOpts = {},
): TrendingBoard {
  const limit = opts.limit ?? 15;
  const minClusters = opts.minClusters ?? 2;

  const scoped = opts.domain ? rows.filter((r) => r.primaryDomain === opts.domain) : rows;

  // Dedup by cluster_id (kills the per-run re-minted duplicates), with
  // a normalized-headline secondary guard for the rare one-story-two-
  // clusters case. First occurrence wins — caller orders latest-first.
  // The headline guard is intentionally lossy: a second cluster whose
  // headline normalizes identically is dropped whole (its tags/keywords
  // discarded), not merged. Acceptable because in-window normalized-
  // headline collisions between genuinely-distinct stories are rare.
  const seenCluster = new Set<string>();
  const seenHeadline = new Set<string>();
  const deduped: TrendingRow[] = [];
  for (const row of scoped) {
    if (seenCluster.has(row.clusterId)) continue;
    const hkey = normalizeHeadline(row.headline);
    if (hkey && seenHeadline.has(hkey)) continue;
    seenCluster.add(row.clusterId);
    if (hkey) seenHeadline.add(hkey);
    deduped.push(row);
  }

  const themeAgg = new Map<string, Agg>();
  const keywordAgg = new Map<string, Agg>();
  for (const row of deduped) {
    const weight = clusterWeight(row);
    const heat = HEAT_RANK[row.temperature] ?? 1;
    for (const tag of uniqueNonEmpty(row.tags)) accumulate(themeAgg, tag, row, weight, heat);
    for (const kw of uniqueNonEmpty(row.keywords)) accumulate(keywordAgg, kw, row, weight, heat);
  }

  return {
    cluster_count: deduped.length,
    // Themes always qualify at ≥1 cluster — tags are curated, so even a
    // single hot exclusive scoop is signal worth surfacing.
    themes: finalize(themeAgg, 1, limit),
    keywords: finalize(keywordAgg, minClusters, limit),
  };
}

type TrendingDbRow = {
  cluster_id: string;
  headline: string;
  primary_domain: string;
  temperature: string;
  trajectory: string;
  keywords: string[];
  tags: string[];
};

/**
 * Fetch the in-window candidate pool (status='new', not expired) and
 * compute the trending board. Mirrors list_candidates' active-window
 * filter; ordered latest-first so dedup keeps the freshest row.
 */
export async function computeTrending(db: Db, opts: TrendingOpts = {}): Promise<TrendingBoard> {
  const whereParts = [sql`status = 'new'`, sql`expires_at > NOW()`];
  // Redesign P0.5: arXiv containment. Clusters carried ONLY by arXiv
  // sources are excluded from the trending pool outright — evergreen ML
  // papers were flooding ~80% of the rising keywords ("large-language-
  // models every day", docs/handoffs/2026-06-05.md). A paper any
  // non-arXiv source corroborated still trends. The subquery yields a
  // row only for provably-all-arXiv clusters (has items AND every one
  // is arXiv), so an item-less cluster is NOT excluded. Probe hits
  // idx_items_cluster_id, so it stays indexed per candidate.
  whereParts.push(sql`NOT EXISTS (
    SELECT 1
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    JOIN sources s ON s.id = ri.source_id
    WHERE i.cluster_id = candidates.cluster_id
    GROUP BY i.cluster_id
    HAVING BOOL_AND(s.kind = 'arxiv')
  )`);
  if (opts.domain) whereParts.push(sql`primary_domain = ${opts.domain}`);
  const whereSql = sql.join(whereParts, sql` AND `);
  // No LIMIT — aggregation needs the whole in-window pool. Cost scales
  // with active-pool size; the WHERE hits idx_candidates_status /
  // idx_candidates_primary_domain_status so the scan stays indexed.
  const rows = await db.execute<TrendingDbRow>(sql`
    SELECT cluster_id, headline, primary_domain,
           temperature, trajectory, keywords, tags
    FROM candidates
    WHERE ${whereSql}
    ORDER BY created_at DESC
  `);
  return computeTrendingFromRows(
    rows.map((r) => ({
      clusterId: r.cluster_id,
      headline: r.headline,
      primaryDomain: r.primary_domain,
      temperature: r.temperature,
      trajectory: r.trajectory,
      keywords: r.keywords,
      tags: r.tags,
    })),
    opts,
  );
}
