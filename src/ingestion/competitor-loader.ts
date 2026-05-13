// Competitor-due loader for the scheduler. YouTube competitor channels run
// on a 4-hour cadence per SPEC §7.1 — that's not stored per-row in the
// competitors table (no fetch_interval_min column there), so we apply a
// fixed interval at the scheduler layer. If a future competitor platform
// needs a different cadence the constant graduates to a per-row column.

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { competitors } from '../db/schema.js';

export const YOUTUBE_COMPETITOR_INTERVAL_MIN = 240; // 4h per SPEC §7.1

// v1 is YouTube-only by policy (ADR-003 / SPEC §6.7). Platform is narrowed
// to the single supported value so the downstream queue type stays tight;
// when v2.7 adds Facebook this widens.
export interface DueCompetitor {
  id: string;
  platform: 'youtube';
  externalId: string;
  name: string;
}

export async function loadDueCompetitors(db: Db): Promise<DueCompetitor[]> {
  const rows = await db
    .select({
      id: competitors.id,
      platform: competitors.platform,
      externalId: competitors.externalId,
      name: competitors.name,
      lastVideoAt: competitors.lastVideoAt,
    })
    .from(competitors)
    .where(
      and(
        eq(competitors.enabled, true),
        // YouTube only in v1 per ADR-003 / SPEC §6.7.
        eq(competitors.platform, 'youtube'),
        or(
          isNull(competitors.lastVideoAt),
          lte(
            sql`${competitors.lastVideoAt} + (${YOUTUBE_COMPETITOR_INTERVAL_MIN} || ' minutes')::interval`,
            sql`NOW()`,
          ),
        ),
      ),
    );

  // The WHERE filter pins platform to 'youtube'; the cast reflects the
  // narrowed DueCompetitor shape.
  return rows.map((r) => ({
    id: r.id,
    platform: 'youtube' as const,
    externalId: r.externalId,
    name: r.name,
  }));
}
