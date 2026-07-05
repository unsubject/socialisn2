// Stage 3 heuristic cluster scoring (SPEC §9.1). Runs across every active
// cluster on each scoring run; the top 200 advance to Stage 4 (cluster
// summarisation, Phase 3 PR 3).
//
// Formula (verbatim from SPEC §9.1):
//
//   cluster_heuristic_score =
//       log(1 + sum_of_authority_weighted_items)
//     * domain_weight
//     * (1 + 0.5 * geographic_spread_bonus)
//     * exclusive_bonus_multiplier
//
// Inputs:
//   sum_of_authority_weighted_items — sum(items.authority_weighted) over
//     cluster items. Falls back to sum(sources.authority_score) so the
//     score is well-defined for clusters whose normalise stage hasn't yet
//     populated items.authority_weighted.
//   domain_weight — per-domain multiplier from config/domains.ts.
//     Phase 3 PR 3 ships that file; v1 here defaults missing domains to
//     1.0 (formula collapses to authority × geo × exclusive).
//   geographic_spread_bonus — distinct countries from gdelt_coverage,
//     normalised into [0, 1]. SPEC says "0-1, capped"; v1 picks a 5-
//     country saturation point and scales linearly below.
//   exclusive_bonus_multiplier — 1.5 if cluster is exclusive else 1.0.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

const EXCLUSIVE_MULTIPLIER = 1.5;
const NON_EXCLUSIVE_MULTIPLIER = 1.0;
const GEO_BONUS_COEF = 0.5;
const GEO_BONUS_SATURATION_COUNTRIES = 5;
export const TOP_N_FOR_STAGE_4 = 200;
/**
 * Redesign P0.5 (docs/redesign/2026-07-05 §6): arXiv containment.
 * Clusters whose items ALL come from kind='arxiv' sources get their
 * heuristic score halved — the arXiv firehose was flooding ~80% of the
 * rising pool with evergreen ML papers (docs/handoffs/2026-06-05.md).
 * Corroboration by ANY non-arXiv source lifts the penalty, so a paper
 * that news/newsletters actually picked up competes at full strength.
 */
export const ARXIV_ONLY_MULTIPLIER = 0.5;

export interface HeuristicSignals {
  isExclusive: boolean;
  /**
   * Per-domain weight. Defaults to 1.0 when null/undefined so missing
   * config doesn't zero out the score — the formula degrades gracefully
   * to authority × geo × exclusive.
   */
  domainWeight?: number | null;
}

export interface HeuristicResult {
  heuristicScore: number;
  sumAuthorityWeighted: number;
  geographicSpreadBonus: number;
  domainWeightUsed: number;
  exclusiveBonusMultiplier: number;
  /** True when every item in the cluster came from an arXiv source —
   *  the ARXIV_ONLY_MULTIPLIER penalty was applied to heuristicScore. */
  arxivOnly: boolean;
}

/**
 * Score a single cluster. Two read-only PG queries: one aggregate over
 * items + sources for the authority sum, one against the latest
 * gdelt_coverage row for country count. Both are point lookups with
 * existing indexes.
 */
export async function computeHeuristic(
  db: Db,
  clusterId: string,
  signals: HeuristicSignals,
): Promise<HeuristicResult> {
  const sumRow = await db.execute<{
    sum_authority: number | null;
    all_arxiv: boolean | null;
  }>(sql`
    SELECT
      COALESCE(
        SUM(COALESCE(i.authority_weighted, s.authority_score::float)),
        0
      )::float AS sum_authority,
      COALESCE(BOOL_AND(s.kind = 'arxiv'), false) AS all_arxiv
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    JOIN sources s ON s.id = ri.source_id
    WHERE i.cluster_id = ${clusterId}
  `);
  const sumAuthorityWeighted = sumRow[0]?.sum_authority ?? 0;
  const arxivOnly = sumRow[0]?.all_arxiv ?? false;

  const geoRow = await db.execute<{ country_count: number | null }>(sql`
    SELECT country_count
    FROM gdelt_coverage
    WHERE cluster_id = ${clusterId}
    ORDER BY fetched_at DESC
    LIMIT 1
  `);
  const rawCountryCount = geoRow[0]?.country_count ?? 0;
  const geographicSpreadBonus = normaliseGeoSpread(rawCountryCount);

  const domainWeightUsed =
    signals.domainWeight !== null && signals.domainWeight !== undefined
      ? signals.domainWeight
      : 1.0;
  const exclusiveBonusMultiplier = signals.isExclusive
    ? EXCLUSIVE_MULTIPLIER
    : NON_EXCLUSIVE_MULTIPLIER;

  // SPEC §9.1 formula, then the P0.5 arXiv containment on top —
  // scoreFromSignals stays the pure spec formula.
  const heuristicScore =
    scoreFromSignals({
      sumAuthorityWeighted,
      domainWeight: domainWeightUsed,
      geographicSpreadBonus,
      isExclusive: signals.isExclusive,
    }) * (arxivOnly ? ARXIV_ONLY_MULTIPLIER : 1);

  return {
    heuristicScore,
    sumAuthorityWeighted,
    geographicSpreadBonus,
    domainWeightUsed,
    exclusiveBonusMultiplier,
    arxivOnly,
  };
}

/**
 * Apply the SPEC §9.1 formula to already-collected signal numbers.
 * Pure; exposed for unit testing and for callers that have computed the
 * signals from a different source (e.g. a smoke fixture with hand-set
 * values).
 */
export function scoreFromSignals(args: {
  sumAuthorityWeighted: number;
  domainWeight: number;
  geographicSpreadBonus: number;
  isExclusive: boolean;
}): number {
  const multiplier = args.isExclusive ? EXCLUSIVE_MULTIPLIER : NON_EXCLUSIVE_MULTIPLIER;
  return (
    Math.log(1 + args.sumAuthorityWeighted) *
    args.domainWeight *
    (1 + GEO_BONUS_COEF * args.geographicSpreadBonus) *
    multiplier
  );
}

/**
 * SPEC §9.1 says geographic_spread_bonus is "0-1, capped". We pick a
 * v1 saturation point of 5 distinct countries and scale linearly below,
 * which gives a meaningful gradient at the low end (1-4 countries) while
 * still saturating at globally-covered stories.
 */
export function normaliseGeoSpread(countryCount: number): number {
  if (countryCount <= 0) return 0;
  return Math.min(1, countryCount / GEO_BONUS_SATURATION_COUNTRIES);
}

/**
 * Sort scored clusters desc by heuristicScore and take top N — SPEC
 * §9.1 "Top 200 clusters per run advance to Stage 4. Below 200 is fine
 * on quiet days; no padding."
 */
export function selectTopN<T extends { heuristicScore: number }>(
  scored: T[],
  n: number = TOP_N_FOR_STAGE_4,
): T[] {
  return [...scored].sort((a, b) => b.heuristicScore - a.heuristicScore).slice(0, n);
}
