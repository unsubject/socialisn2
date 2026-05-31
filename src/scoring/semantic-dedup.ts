// Stage 1b of the scoring pipeline (SPEC §7.2 step 2) — semantic dedup.
//
// After embedding a candidate raw_item, find an existing `items` row whose
// embedding has cosine similarity ≥ 0.93 (distance ≤ 0.07) within the same
// `primary_domain` in a recency window (default 7 days). If found, the
// candidate is a near-duplicate of the existing item and should NOT be
// re-ingested as a new `items` row — per SPEC §7.2 step 2, the raw_item is
// "merged into the same cluster without creating new items rows". The
// caller threads the existing item's cluster_id onto the candidate's
// raw_item (`raw_items.dedup_cluster_id`, added in migration 011); see
// `src/scoring/process-raw-item.ts` for the runtime wiring.
//
// This is a pure query — no writes. The decision to skip insertion is the
// caller's. The HNSW index on `items.embedding` (idx_items_embedding) makes
// the ORDER BY ... LIMIT 1 lookup cheap.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { EMBEDDING_DIM } from '../db/schema.js';

// SPEC §7.2 default: cosine similarity ≥ 0.93. Stored as distance
// (1 - similarity) since pgvector's `<=>` operator returns distance.
const DEFAULT_SIMILARITY_THRESHOLD = 0.93;
const DEFAULT_RECENCY_DAYS = 7;

export interface FindDuplicateInput {
  /** 1536-dim embedding produced by text-embedding-3-small. */
  embedding: number[];
  /** SPEC §3 domain — must match the existing item's `primary_domain`. */
  primaryDomain: string;
}

export interface FindDuplicateOptions {
  /** Cosine similarity threshold (≥). Default 0.93 per SPEC §7.2 step 2. */
  similarityThreshold?: number;
  /** Recency window in days. Default 7. */
  recencyDays?: number;
}

export interface DuplicateMatch {
  /** The existing items row that the candidate is a near-duplicate of. */
  itemId: string;
  /** The cluster the existing item belongs to, or null if it's unclustered. */
  clusterId: string | null;
  /** Cosine similarity to the existing item (≥ similarityThreshold). */
  similarity: number;
  /** Cosine distance (1 - similarity). */
  distance: number;
}

/**
 * Return the nearest existing `items` row whose embedding is at cosine
 * similarity ≥ threshold (default 0.93), within the same `primary_domain`
 * and recency window (default 7 days). Returns null if nothing qualifies.
 *
 * Read-only. The caller uses the result to decide whether to skip
 * insertion of a new items row and re-point the raw_item to the existing
 * item's cluster.
 */
export async function findSemanticDuplicate(
  db: Db,
  input: FindDuplicateInput,
  opts: FindDuplicateOptions = {},
): Promise<DuplicateMatch | null> {
  if (input.embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `findSemanticDuplicate: embedding length ${input.embedding.length} !== EMBEDDING_DIM ${EMBEDDING_DIM}`,
    );
  }

  const similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const distanceThreshold = 1 - similarityThreshold;
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;
  const vecLit = toPgvectorLiteral(input.embedding);

  // pgvector's `<=>` is cosine distance (1 - cosine similarity). HNSW index
  // on `items.embedding` makes ORDER BY ... LIMIT 1 cheap.
  const rows = await db.execute<{
    id: string;
    cluster_id: string | null;
    distance: number;
  }>(sql`
    SELECT id,
           cluster_id,
           (embedding <=> ${vecLit}::vector(${sql.raw(String(EMBEDDING_DIM))})) AS distance
    FROM items
    WHERE primary_domain = ${input.primaryDomain}
      AND published_at > NOW() - make_interval(days => ${recencyDays})
    ORDER BY embedding <=> ${vecLit}::vector(${sql.raw(String(EMBEDDING_DIM))}) ASC
    LIMIT 1
  `);

  const nearest = rows[0];
  if (!nearest) return null;
  // Audit D-P1-2: guard against NaN distance from a zero-vector poison.
  // pgvector's `<=>` is `1 - cosine_similarity`; cosine between two
  // zero vectors is 0/0 = NaN, which pgvector surfaces as the distance.
  // `NaN > threshold` is `false`, so without this guard a bogus
  // zero-vector items row would steal every incoming item as a "dup".
  if (!Number.isFinite(nearest.distance)) return null;
  if (nearest.distance > distanceThreshold) return null;

  return {
    itemId: nearest.id,
    clusterId: nearest.cluster_id,
    similarity: 1 - nearest.distance,
    distance: nearest.distance,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Format a number[] as a pgvector text literal `[1,2,3]`. We send the vector
 * as a `text` parameter and cast to `::vector(N)` at use-site, which sidesteps
 * postgres-js's array stringification (`{1,2,3}`, the wrong shape for
 * pgvector — it wants `[1,2,3]`).
 */
function toPgvectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
