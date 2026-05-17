// First-publisher / "exclusive scoop" detection (SPEC §6.1 note).
//
// A cluster is exclusive when:
//   1. The first-published source has authority ≥ 75
//   2. AND that source published > 4 hours before the second source
//      in the cluster.
//
// A single-item / single-source cluster cannot be exclusive yet — we
// need a second DISTINCT source landing AFTER the 4-hour gap to confirm
// the scoop wasn't just slow syndication. Re-evaluated on every scoring
// run, so a single-source cluster on run N becomes exclusive on run N+1
// when a different source lands.
//
// "Second DISTINCT source" is the key word — if the first publisher
// drops multiple items into the cluster before any other outlet picks
// it up, the head start is between FIRST_PUBLISHER and SECOND_PUBLISHER,
// NOT between the first publisher's first and second post.

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
  /** Hours between first and second DISTINCT source's earliest publication; null when <2 sources. */
  headStartHours: number | null;
}

/**
 * Collapse the cluster's items to one row per source (each source's
 * EARLIEST publication), then take the two earliest sources. This
 * guarantees the head-start measurement is between DISTINCT publishers
 * — if the first publisher contributes multiple items before anyone
 * else, those repeats don't poison the second-source slot.
 */
export async function computeExclusive(
  db: Db,
  clusterId: string,
): Promise<ExclusiveResult> {
  const rows = await db.execute<{
    source_id: string;
    authority_score: number;
    earliest_published_at: string;
  }>(sql`
    WITH first_per_source AS (
      SELECT DISTINCT ON (s.id)
        s.id              AS source_id,
        s.authority_score AS authority_score,
        ri.published_at   AS earliest_published_at
      FROM items i
      JOIN raw_items ri ON ri.id = i.raw_item_id
      JOIN sources s    ON s.id  = ri.source_id
      WHERE i.cluster_id = ${clusterId}
      ORDER BY s.id, ri.published_at ASC
    )
    SELECT source_id, authority_score, earliest_published_at
    FROM first_per_source
    ORDER BY earliest_published_at ASC
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
  const firstPub = new Date(first.earliest_published_at).getTime();
  const secondPub = new Date(second.earliest_published_at).getTime();
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
