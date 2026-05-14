// Bulk-insert competitor video rows into competitor_videos with the (competitor_id,
// external_id) unique index handling idempotent re-fetches.
//
// Differs from writer.ts in two ways:
//   - target table is competitor_videos, FK to competitors (not raw_items / sources)
//   - no cross-row hash dedup: SPEC §7.2 step 1 hashes (url_hash / title_hash) are a
//     raw_items concept for cross-source dedup of news/articles. Competitor videos
//     are inherently per-channel and don't get cross-channel deduped.

import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../db/client.js';
import { competitors, competitorVideos } from '../db/schema.js';
import type { CompetitorVideoInput } from './youtube.js';

export interface CompetitorWriteResult {
  fetched: number;
  insertedCount: number;
  duplicateCount: number;
}

export async function writeCompetitorVideos(
  db: Db,
  competitorId: string,
  items: CompetitorVideoInput[],
): Promise<CompetitorWriteResult> {
  const fetched = items.length;
  if (fetched === 0) {
    return { fetched: 0, insertedCount: 0, duplicateCount: 0 };
  }

  const rows = items.map((v) => ({
    id: uuidv7(),
    competitorId,
    externalId: v.externalId,
    url: v.url,
    title: v.title,
    description: v.description,
    publishedAt: v.publishedAt,
  }));

  const result = await db
    .insert(competitorVideos)
    .values(rows)
    .onConflictDoNothing({
      target: [competitorVideos.competitorId, competitorVideos.externalId],
    })
    .returning({ id: competitorVideos.id });

  return {
    fetched,
    insertedCount: result.length,
    duplicateCount: fetched - result.length,
  };
}

/**
 * Stamps last_fetched_at (always — drives scheduling) and last_status
 * (free-text breadcrumb), and conditionally advances last_video_at to
 * the newest publishedAt seen this fetch.
 *
 * Always call this after a fetch attempt, including failures: scheduling
 * runs off last_fetched_at, so a perpetually-failing channel that never
 * stamps would re-enqueue every scheduler tick.
 */
export async function markCompetitorFetched(
  db: Db,
  competitorId: string,
  args: { status: string; newestVideoAt: Date | null },
): Promise<void> {
  const update: Record<string, unknown> = {
    lastFetchedAt: new Date(),
    lastStatus: args.status,
  };
  if (args.newestVideoAt) {
    update.lastVideoAt = args.newestVideoAt;
  }
  await db.update(competitors).set(update).where(eq(competitors.id, competitorId));
}
