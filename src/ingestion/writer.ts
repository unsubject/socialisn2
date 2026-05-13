// Dedup pass 1 + bulk INSERT into raw_items per SPEC §7.2 step 1.
//
// Two dedup layers, in order:
//   1. In-batch: hash-collisions within the same fetch (same article emitted
//      under two <item> entries) are folded.
//   2. Cross-source: SELECT existing url_hash + title_hash from raw_items;
//      any new item whose hash is already in the table is skipped.
// Then INSERT remaining rows with ON CONFLICT DO NOTHING against the
// (source_id, external_id) unique index — catches republishes of the same
// feed-item id within the same source.

import { inArray, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { rawItems } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { titleHash, urlHash } from './dedup.js';
import type { RawItemInput } from './types.js';

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

  // `sql\`... ANY(${arr}::text[])\`` binds postgres.js a record, not an array,
  // so the cast fails ("cannot cast type record to text[]"). Use the typed
  // inArray operator instead — drizzle expands it to a parameterised IN list.
  const existing = await db
    .select({
      urlHash: rawItems.urlHash,
      titleHash: rawItems.titleHash,
    })
    .from(rawItems)
    .where(
      or(inArray(rawItems.urlHash, urlHashes), inArray(rawItems.titleHash, titleHashes)),
    );
  const existingUrlHashes = new Set<string>();
  const existingTitleHashes = new Set<string>();
  for (const row of existing) {
    existingUrlHashes.add(row.urlHash);
    existingTitleHashes.add(row.titleHash);
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
