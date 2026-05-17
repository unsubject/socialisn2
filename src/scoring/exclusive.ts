// First-publisher / "exclusive scoop" detection (SPEC §6.1 note).
//
// A cluster is exclusive when:
//   1. The first-published source has authority ≥ 75
//   2. AND that source published > 4 hours before the second source
//      in the cluster.
//
// A single-item cluster cannot be exclusive yet — we need a second
// source landing AFTER the 4-hour gap to confirm the scoop wasn't just
// slow syndication. Re-evaluated on every scoring run, so a
// single-item cluster on run N becomes exclusive on run N+1 when a
// second source lands.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

const MIN_AUTHORITY = 75;
const MIN_HEAD_START_HOURS = 4;

export interface ExclusiveResult {
  isExclusive: boolean;
  /** First-publisher source id; null when not exclusive. */
  exclusiveSourceId: string | null;
  /** First publisher's authority score; null when cluster has no items. */
  firstSourceAuthority: number | null;
  /** Hours between first and second source publication; null when <2 items. */
  headStartHours: number | null;
}

/**
 * Pull the cluster's first two items in publish-order with their source
 * authority, then evaluate the SPEC §6.1 rule. Two items minimum;
 * single-source clusters are not exclusive (we can't verify the head
 * start). The query is bounded to LIMIT 2 — we don't need anything past
 * the second-publisher row.
 */
export async function computeExclusive(
  db: Db,
  clusterId: string,
): Promise<ExclusiveResult> {
  const rows = await db.execute<{
    source_id: string;
    authority_score: number;
    published_at: string;
  }>(sql`
    SELECT
      s.id AS source_id,
      s.authority_score,
      ri.published_at
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    JOIN sources s ON s.id = ri.source_id
    WHERE i.cluster_id = ${clusterId}
    ORDER BY ri.published_at ASC
    LIMIT 2
  `);

  if (rows.length === 0) {
    return {
      isExclusive: false,
      exclusiveSourceId: null,
      firstSourceAuthority: null,
      headStartHours: null,
    };
  }
  const first = rows[0]!;
  const second = rows[1] ?? null;

  if (second === null) {
    return {
      isExclusive: false,
      exclusiveSourceId: null,
      firstSourceAuthority: first.authority_score,
      headStartHours: null,
    };
  }

  // db.execute<T> returns timestamps as strings (per memory
  // [[drizzle_pg_execute_timestamp_string]]) — wrap with new Date(…).
  const firstPub = new Date(first.published_at).getTime();
  const secondPub = new Date(second.published_at).getTime();
  const headStartHours = (secondPub - firstPub) / 3_600_000;
  const isExclusive =
    first.authority_score >= MIN_AUTHORITY && headStartHours > MIN_HEAD_START_HOURS;

  return {
    isExclusive,
    exclusiveSourceId: isExclusive ? first.source_id : null,
    firstSourceAuthority: first.authority_score,
    headStartHours,
  };
}
