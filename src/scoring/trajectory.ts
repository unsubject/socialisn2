// Stage trajectory annotation (SPEC §9.5) — 24-hour derivative on a
// cluster's item_count, derived from items.published_at.
//
// Buckets per SPEC:
//   first-seen within 24h               → 'new'    (short-circuit)
//   trajectoryRatio > 1.5               → 'rising'
//   0.7 ≤ trajectoryRatio ≤ 1.5         → 'peaking'
//   trajectoryRatio < 0.7               → 'declining'
//
//   trajectoryRatio = items_added_last_24h / max(items_added_24_to_48h_ago, 1)

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

export type Trajectory = 'new' | 'rising' | 'peaking' | 'declining';

const NEW_WINDOW_HOURS = 24;
const RISING_RATIO_ABOVE = 1.5;
const PEAKING_RATIO_FLOOR = 0.7;

export interface ComputeTrajectoryInput {
  clusterId: string;
  /** When the cluster was first seen — used for the 'new' short-circuit. */
  firstSeenAt: Date;
}

export interface TrajectoryResult {
  /** items_added_last_24h / max(items_added_24_to_48h_ago, 1). */
  trajectoryRatio: number;
  trajectory: Trajectory;
}

export async function computeTrajectory(
  db: Db,
  input: ComputeTrajectoryInput,
  now: Date = new Date(),
): Promise<TrajectoryResult> {
  const ageMs = now.getTime() - input.firstSeenAt.getTime();
  if (ageMs <= NEW_WINDOW_HOURS * 3_600_000) {
    return { trajectoryRatio: 0, trajectory: 'new' };
  }

  // Pass `now` as an ISO string + ::timestamptz cast so the raw SQL
  // template stays compatible with postgres-js. Per memory
  // [[drizzle_pg_date_gte]], passing a JS Date through `sql\`${d}\``
  // fails with "could not determine data type".
  const nowIso = now.toISOString();
  const counts = await db.execute<{ last_24h: number; prior_24h: number }>(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE published_at > ${nowIso}::timestamptz - interval '24 hours'
      )::int AS last_24h,
      COUNT(*) FILTER (
        WHERE published_at > ${nowIso}::timestamptz - interval '48 hours'
          AND published_at <= ${nowIso}::timestamptz - interval '24 hours'
      )::int AS prior_24h
    FROM items
    WHERE cluster_id = ${input.clusterId}
  `);

  const last24h = counts[0]?.last_24h ?? 0;
  const prior24h = counts[0]?.prior_24h ?? 0;
  const trajectoryRatio = last24h / Math.max(prior24h, 1);
  return { trajectoryRatio, trajectory: bucketTrajectory(trajectoryRatio) };
}

/**
 * Pure bucketing for trajectory ratios. Used by the integration function
 * after the 'new' short-circuit; exposed for direct unit testing.
 */
export function bucketTrajectory(trajectoryRatio: number): Exclude<Trajectory, 'new'> {
  if (trajectoryRatio > RISING_RATIO_ABOVE) return 'rising';
  if (trajectoryRatio >= PEAKING_RATIO_FLOOR) return 'peaking';
  return 'declining';
}
