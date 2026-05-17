// Stage temperature annotation (SPEC §9.5) — current discussion intensity
// for a cluster, derived from its item_count relative to the SAME
// primary_domain's 30-day distribution. The over_saturated upgrade
// requires the cluster's items to also be highly self-similar.
//
// One single trip to PG for the per-domain stats; a second trip ONLY
// when the cluster lands in the hot band (z >= 2.5 candidate). The
// pairwise similarity is O(n²) over cluster items and we don't want to
// pay it for a cold/warm cluster.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

export type Temperature = 'cold' | 'warm' | 'hot' | 'over_saturated';

const WARM_FLOOR_Z = 0;     // z < 0 → cold
const HOT_FLOOR_Z = 1;      // 0 ≤ z < 1 → warm
const OVER_SAT_FLOOR_Z = 2.5; // 1 ≤ z < 2.5 → hot; z ≥ 2.5 + sim > 0.75 → over_saturated
const OVER_SAT_SIM = 0.75;
const DOMAIN_WINDOW_DAYS = 30;

export interface ComputeTemperatureInput {
  clusterId: string;
  primaryDomain: string;
  itemCount: number;
}

export interface TemperatureResult {
  /** Z-score of cluster's item_count vs domain 30-day distribution. */
  volumeZ: number;
  /** Cardinal label per SPEC §9.5. */
  temperature: Temperature;
  /**
   * Average pairwise cosine similarity across cluster items. Undefined
   * when the cluster never qualifies for the over_saturated check (cold
   * / warm / hot-but-below-2.5) — we skip the O(n²) similarity SQL
   * since the result wouldn't influence the label anyway.
   */
  avgPairwiseSimilarity?: number;
}

export async function computeTemperature(
  db: Db,
  input: ComputeTemperatureInput,
): Promise<TemperatureResult> {
  // Exclude the target cluster itself from the domain distribution —
  // otherwise a high-count outlier inflates its own baseline and tugs
  // its z-score toward 0. For single-cluster domains the exclusion
  // leaves zero rows, which we handle below as "no signal → z = 0".
  const stats = await db.execute<{ mean: number | null; stddev: number | null }>(sql`
    SELECT
      AVG(item_count)::float AS mean,
      COALESCE(STDDEV(item_count), 0)::float AS stddev
    FROM clusters
    WHERE primary_domain = ${input.primaryDomain}
      AND id != ${input.clusterId}
      AND status = 'active'
      AND first_seen_at > NOW() - make_interval(days => ${DOMAIN_WINDOW_DAYS})
  `);

  const meanRow = stats[0]?.mean;
  const stddevRow = stats[0]?.stddev;
  const stddev = stddevRow ?? 0;

  // Guard against:
  //   - no other clusters in domain → mean is null → z = 0 (warm baseline)
  //   - zero-variance domain → stddev = 0 → division would yield Infinity
  const volumeZ =
    meanRow !== null && meanRow !== undefined && stddev > 0
      ? (input.itemCount - meanRow) / stddev
      : 0;

  if (volumeZ < OVER_SAT_FLOOR_Z) {
    return { volumeZ, temperature: bucketBaseTemperature(volumeZ) };
  }

  // z ≥ 2.5 — candidate for over_saturated. Now pay for the pairwise
  // similarity SQL. a.id < b.id picks distinct pairs (n*(n-1)/2 of them).
  const simRow = await db.execute<{ avg_sim: number | null }>(sql`
    WITH items_in AS (
      SELECT id, embedding
      FROM items
      WHERE cluster_id = ${input.clusterId}
    )
    SELECT AVG(1 - (a.embedding <=> b.embedding))::float AS avg_sim
    FROM items_in a
    JOIN items_in b ON a.id < b.id
  `);
  const avgSim = simRow[0]?.avg_sim;
  const upgradedToOverSaturated = avgSim !== null && avgSim !== undefined && avgSim > OVER_SAT_SIM;
  return {
    volumeZ,
    temperature: upgradedToOverSaturated ? 'over_saturated' : 'hot',
    avgPairwiseSimilarity: avgSim ?? undefined,
  };
}

/**
 * Pure bucketing for z-scores BELOW the over_saturated floor. Exposed
 * for unit testing; the integration function handles the over_saturated
 * upgrade since it needs the second SQL trip.
 */
export function bucketBaseTemperature(volumeZ: number): Exclude<Temperature, 'over_saturated'> {
  if (volumeZ < WARM_FLOOR_Z) return 'cold';
  if (volumeZ < HOT_FLOOR_Z) return 'warm';
  return 'hot';
}
