// Dedup pass 1 + bulk INSERT into raw_items per SPEC §7.2 step 1.
//
// Layers:
//   1. In-batch fold — hash collisions within the same fetch (same article
//      emitted under two <item> entries) are collapsed.
//   2. Cross-source url_hash — always matches, any age. Same canonical URL
//      across sources is unambiguously a re-syndication.
//   3. Cross-source title_hash — only matches against rows in the recent
//      window (default 48h). Catches near-simultaneous re-syndication
//      under the same headline; doesn't reject legitimate recurring titles
//      ("Morning Briefing", podcast episode templates, "Live Updates")
//      whose previous edition was days/weeks ago.
//   4. INSERT with ON CONFLICT (source_id, external_id) DO NOTHING —
//      catches republishes of the same feed-item id within the same source.
//
// The title-window default mirrors the spirit of SPEC §7.2 step 2's
// 7-day semantic-dedup window but is much tighter; cross-source title
// collision after 48h is dominated by templates, not re-syndication.

import { and, gte, inArray, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { rawItems } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { titleHash, urlHash } from './dedup.js';
import type { RawItemInput } from './types.js';

export const TITLE_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface WriteResult {
  fetched: number;
  insertedCount: number;
  duplicateCount: number;
}

interface PreparedRow {
  id: string;
  sourceId: string;
  externalId: string;
  url: string;
  urlHash: string;
  title: string;
  titleHash: string;
  content: string | null;
  author: string | null;
  publishedAt: Date;
  language: string | null;
  rawMeta: Record<string, unknown>;
}

function prepareRows(sourceId: string, items: RawItemInput[]): PreparedRow[] {
  const seenInBatch = new Set<string>();
  const rows: PreparedRow[] = [];
  for (const item of items) {
    const uh = urlHash(item.url);
    const th = titleHash(item.title);
    const batchKey = `${uh}|${th}`;
    if (seenInBatch.has(batchKey)) continue;
    seenInBatch.add(batchKey);
    rows.push({
      id: uuidv7(),
      sourceId,
      externalId: item.externalId,
      url: item.url,
      urlHash: uh,
      title: item.title,
      titleHash: th,
      content: item.content,
      author: item.author,
      publishedAt: item.publishedAt,
      language: item.language,
      rawMeta: item.rawMeta,
    });
  }
  return rows;
}

export async function writeRawItems(
  db: Db,
  sourceId: string,
  items: RawItemInput[],
): Promise<WriteResult> {
  const fetched = items.length;
  const prepared = prepareRows(sourceId, items);
  if (prepared.length === 0) {
    return { fetched, insertedCount: 0, duplicateCount: fetched };
  }

  const urlHashes = prepared.map((r) => r.urlHash);
  const titleHashes = prepared.map((r) => r.titleHash);
  const titleWindowCutoff = new Date(Date.now() - TITLE_DEDUP_WINDOW_MS);

  // url_hash matches any age (same canonical URL is always a dup).
  // title_hash matches only against rows in the recent window — anything
  // older is treated as coincidental template reuse rather than
  // syndication. Use drizzle's typed inArray + gte — wrapping the Date
  // in `sql\`${cutoff}\`` makes postgres.js choke on the bind format;
  // gte takes the column's TS type directly (Date for timestamptz).
  const existing = await db
    .select({
      urlHash: rawItems.urlHash,
      titleHash: rawItems.titleHash,
      publishedAt: rawItems.publishedAt,
    })
    .from(rawItems)
    .where(
      or(
        inArray(rawItems.urlHash, urlHashes),
        and(
          inArray(rawItems.titleHash, titleHashes),
          gte(rawItems.publishedAt, titleWindowCutoff),
        ),
      ),
    );
  const existingUrlHashes = new Set<string>();
  const existingTitleHashes = new Set<string>();
  for (const row of existing) {
    // url_hash collision is unconditional. Always add it to the dedup set.
    existingUrlHashes.add(row.urlHash);
    // title_hash collision only counts when the existing row is itself
    // within the window. The URL-match branch of the WHERE clause
    // intentionally returns rows of any age, so without this guard a
    // stale row pulled in by a url-hash match would leak its title-hash
    // into the title-dedup set and reject a legitimate recurring-title
    // entry from a different URL.
    if (row.publishedAt >= titleWindowCutoff) {
      existingTitleHashes.add(row.titleHash);
    }
  }

  const fresh = prepared.filter(
    (r) => !existingUrlHashes.has(r.urlHash) && !existingTitleHashes.has(r.titleHash),
  );

  if (fresh.length === 0) {
    return { fetched, insertedCount: 0, duplicateCount: fetched };
  }

  const result = await db
    .insert(rawItems)
    .values(fresh)
    .onConflictDoNothing({ target: [rawItems.sourceId, rawItems.externalId] })
    .returning({ id: rawItems.id });

  return {
    fetched,
    insertedCount: result.length,
    duplicateCount: fetched - result.length,
  };
}
