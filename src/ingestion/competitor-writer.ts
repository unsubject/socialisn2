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

export async function markCompetitorFetched(
  db: Db,
  competitorId: string,
  lastVideoAt: Date | null,
): Promise<void> {
  // The competitors table tracks last_video_at (newest published_at seen) for
  // scheduling heuristics; there is no last_fetched_at / last_status column on
  // competitors. Update only when we actually saw a video newer than what's
  // currently stored.
  if (!lastVideoAt) return;
  await db
    .update(competitors)
    .set({ lastVideoAt })
    .where(eq(competitors.id, competitorId));
}
