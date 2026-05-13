// Loads source rows for the scheduler. Only `rss` sources are fetched in
// Phase 1 PR 1; the other kinds (arxiv, youtube_channel, email_bridge) get
// their own adapters in subsequent PRs and the scheduler will filter them in
// once those adapters exist.

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { sources } from '../db/schema.js';

export interface DueSource {
  id: string;
  kind: 'rss' | 'youtube_channel' | 'arxiv' | 'email_bridge';
  url: string;
  name: string;
  fetchIntervalMin: number;
}

export async function loadDueSources(
  db: Db,
  kinds: ReadonlyArray<DueSource['kind']>,
): Promise<DueSource[]> {
  const rows = await db
    .select({
      id: sources.id,
      kind: sources.kind,
      url: sources.url,
      name: sources.name,
      fetchIntervalMin: sources.fetchIntervalMin,
      lastFetchedAt: sources.lastFetchedAt,
    })
    .from(sources)
    .where(
      and(
        eq(sources.enabled, true),
        // sources.kind is `text` in PG (with a CHECK enum) — narrow with `inArray`-equivalent.
        // drizzle's `inArray` works on text just fine.
        or(...kinds.map((k) => eq(sources.kind, k))),
        or(
          isNull(sources.lastFetchedAt),
          // last_fetched_at + (fetch_interval_min || ' minutes')::interval <= NOW()
          lte(
            sql`${sources.lastFetchedAt} + (${sources.fetchIntervalMin} || ' minutes')::interval`,
            sql`NOW()`,
          ),
        ),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as DueSource['kind'],
    url: r.url,
    name: r.name,
    fetchIntervalMin: r.fetchIntervalMin,
  }));
}

export async function markSourceFetched(
  db: Db,
  sourceId: string,
  status: string,
): Promise<void> {
  await db
    .update(sources)
    .set({
      lastFetchedAt: new Date(),
      lastStatus: status,
      updatedAt: new Date(),
    })
    .where(eq(sources.id, sourceId));
}
