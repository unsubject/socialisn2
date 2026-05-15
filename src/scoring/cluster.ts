// Stage 2 of the scoring pipeline (SPEC §7.4) — clustering.
//
// Two entry points:
//
// - `assignCluster(db, input, opts)` — for each normalised item, find the
//   nearest active cluster in the same `primary_domain` within a 7-day
//   window and either join it (running-mean centroid update) or create a
//   new cluster. Single SQL UPDATE per join — atomic at the row level.
//
// - `compactClusters(db, opts)` — daily compaction (SPEC §7.4 step 4):
//   merge active clusters in the same domain whose centroids drifted
//   close (cosine distance < 0.15) AND whose member items share at least
//   one entity. The shared-entity guard is the safety net against false
//   merges (two distinct stories that happen to have similar centroids).
//
// Both functions take an optional `threshold` so Phase 3 PR 3 can wire in
// the per-domain values from SPEC §8's table via `config/domains.ts`
// without editing this module.
//
// See ADR-007 for the running-mean rationale.

import { type SQL, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../db/client.js';
import { EMBEDDING_DIM } from '../db/schema.js';

// SPEC §7.4 defaults. The §8 per-domain table tightens / loosens these per
// domain (0.68 – 0.72 similarity, i.e. 0.28 – 0.32 distance); Phase 3 PR 3
// loads those via config/domains.ts and passes the override here.
const DEFAULT_JOIN_THRESHOLD = 0.30;
const DEFAULT_COMPACTION_THRESHOLD = 0.15;
const DEFAULT_RECENCY_DAYS = 7;

export interface AssignClusterInput {
  /** 1536-dim embedding produced by text-embedding-3-small. */
  embedding: number[];
  /** SPEC §3 domain — must match an item's `primary_domain`. */
  primaryDomain: string;
  /** Multi-label domain set from normalisation. Merged into cluster.domains. */
  itemDomains: string[];
  /** The item's publication time. Used for first_seen / last_seen book-keeping. */
  publishedAt: Date;
}

export interface AssignClusterOptions {
  /** Cosine distance below which we join an existing cluster. Default 0.30. */
  threshold?: number;
  /** Recency window in days. Default 7. */
  recencyDays?: number;
}

export interface AssignClusterResult {
  clusterId: string;
  /** True iff a new cluster row was inserted; false iff an existing one was updated. */
  isNew: boolean;
  /** Cosine distance to the matched cluster — null when isNew=true. Useful for telemetry. */
  distance: number | null;
}

/**
 * Find-or-create a cluster for the given item. The running-mean centroid
 * update happens in a single SQL UPDATE using pgvector arithmetic
 * (`(centroid * n + new) / (n + 1)`), so the operation is atomic at the
 * row level without an explicit transaction. See ADR-007.
 */
export async function assignCluster(
  db: Db,
  input: AssignClusterInput,
  opts: AssignClusterOptions = {},
): Promise<AssignClusterResult> {
  if (input.embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `assignCluster: embedding length ${input.embedding.length} !== EMBEDDING_DIM ${EMBEDDING_DIM}`,
    );
  }

  const threshold = opts.threshold ?? DEFAULT_JOIN_THRESHOLD;
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;
  const vec = toPgvectorLiteral(input.embedding);

  // Find the closest active cluster in the same domain within the window.
  // pgvector's `<=>` is cosine distance (1 - cosine similarity). HNSW index
  // on `clusters.centroid` makes ORDER BY ... LIMIT 1 cheap.
  const found = await db.execute<{
    id: string;
    domains: string[];
    distance: number;
  }>(sql`
    SELECT id, domains, (centroid <=> ${vec}::vector(${sql.raw(String(EMBEDDING_DIM))})) AS distance
    FROM clusters
    WHERE primary_domain = ${input.primaryDomain}
      AND status = 'active'
      AND last_seen_at > NOW() - make_interval(days => ${recencyDays})
    ORDER BY centroid <=> ${vec}::vector(${sql.raw(String(EMBEDDING_DIM))}) ASC
    LIMIT 1
  `);

  const match = found[0];
  if (match && match.distance < threshold) {
    // Merge the new item's domain labels into the cluster's existing set.
    // Sorted+deduped so the column has a stable, comparable shape across
    // updates (helps tests and downstream array overlap queries).
    const mergedDomains = sortedUnique([...match.domains, ...input.itemDomains]);

    await db.execute(sql`
      UPDATE clusters
      SET centroid = (centroid * item_count::float + ${vec}::vector(${sql.raw(String(EMBEDDING_DIM))}))
                     / ((item_count + 1)::float),
          item_count = item_count + 1,
          last_seen_at = GREATEST(last_seen_at, ${input.publishedAt.toISOString()}::timestamptz),
          domains = ${textArrayLiteral(mergedDomains)}
      WHERE id = ${match.id}
    `);

    return { clusterId: match.id, isNew: false, distance: match.distance };
  }

  // No match — create a new cluster with this item as the seed. domains is
  // pre-sorted+deduped for the same reason as the merge path above.
  const newId = uuidv7();
  const seedDomains = sortedUnique(input.itemDomains);
  const publishedIso = input.publishedAt.toISOString();
  await db.execute(sql`
    INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
    VALUES (
      ${newId},
      ${vec}::vector(${sql.raw(String(EMBEDDING_DIM))}),
      ${publishedIso}::timestamptz,
      ${publishedIso}::timestamptz,
      1,
      ${textArrayLiteral(seedDomains)},
      ${input.primaryDomain},
      'active'
    )
  `);

  return { clusterId: newId, isNew: true, distance: null };
}

// ---------------------------------------------------------------------------
// Compaction (SPEC §7.4 step 4)
// ---------------------------------------------------------------------------

export interface CompactOptions {
  /** Cosine distance below which two clusters are merge candidates. Default 0.15. */
  threshold?: number;
  /** Only compact clusters seen in the last N days. Default 7. */
  recencyDays?: number;
  /** Optional domain filter; default is all domains. */
  primaryDomain?: string;
}

export interface CompactResult {
  merges: number;
  /** Pairs that were merged, in the order they were applied. */
  pairs: Array<{ source: string; target: string; distance: number }>;
}

/**
 * Merge close-centroid cluster pairs that share at least one entity. The
 * shared-entity requirement is SPEC §7.4's safeguard against merging two
 * unrelated stories whose centroids happen to drift near each other.
 *
 * Strategy:
 *   1. Find all candidate (a, b) pairs where a.id < b.id, same
 *      primary_domain, both active and in the recency window, centroid
 *      distance < threshold, and at least one shared entity (via items).
 *   2. Sort candidates by distance ascending — tightest pair merged first.
 *   3. For each candidate in order, skip if either side has already been
 *      merged in this pass; otherwise merge (smaller item_count → larger,
 *      ties broken by older first_seen_at preserved as target).
 *
 * O(N²) within a domain in step 1. With <100 active clusters per domain in
 * any 7-day window, that's fine. Phase 5 can revisit if profiling flags it.
 */
export async function compactClusters(
  db: Db,
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const threshold = opts.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;

  // Pairwise candidate join + entity-overlap check, all in one query so the
  // application code only iterates the surviving pairs.
  const candidates = await db.execute<{
    id_a: string;
    id_b: string;
    n_a: number;
    n_b: number;
    fs_a: Date;
    fs_b: Date;
    ls_a: Date;
    ls_b: Date;
    d_a: string[];
    d_b: string[];
    distance: number;
  }>(sql`
    SELECT c1.id AS id_a, c2.id AS id_b,
           c1.item_count AS n_a, c2.item_count AS n_b,
           c1.first_seen_at AS fs_a, c2.first_seen_at AS fs_b,
           c1.last_seen_at AS ls_a, c2.last_seen_at AS ls_b,
           c1.domains AS d_a, c2.domains AS d_b,
           (c1.centroid <=> c2.centroid) AS distance
    FROM clusters c1
    JOIN clusters c2
      ON c1.id < c2.id
     AND c1.primary_domain = c2.primary_domain
     AND c1.status = 'active'
     AND c2.status = 'active'
    WHERE c1.last_seen_at > NOW() - make_interval(days => ${recencyDays})
      AND c2.last_seen_at > NOW() - make_interval(days => ${recencyDays})
      AND (c1.centroid <=> c2.centroid) < ${threshold}
      ${opts.primaryDomain ? sql`AND c1.primary_domain = ${opts.primaryDomain}` : sql``}
      AND EXISTS (
        SELECT 1
        FROM items i_a
        JOIN items i_b ON i_a.entities && i_b.entities
        WHERE i_a.cluster_id = c1.id
          AND i_b.cluster_id = c2.id
      )
    ORDER BY (c1.centroid <=> c2.centroid) ASC
  `);

  const consumed = new Set<string>();
  const pairs: CompactResult['pairs'] = [];

  for (const c of candidates) {
    if (consumed.has(c.id_a) || consumed.has(c.id_b)) continue;

    // Pick target (the one we keep) as the larger cluster; ties broken by
    // older first_seen_at preserved. Keeps the longer-lived id stable and
    // avoids re-merging the same row repeatedly.
    const aIsTarget =
      c.n_a > c.n_b ||
      (c.n_a === c.n_b && new Date(c.fs_a).getTime() <= new Date(c.fs_b).getTime());
    const targetId = aIsTarget ? c.id_a : c.id_b;
    const sourceId = aIsTarget ? c.id_b : c.id_a;
    const targetDomains = aIsTarget ? c.d_a : c.d_b;
    const sourceDomains = aIsTarget ? c.d_b : c.d_a;
    const mergedDomains = sortedUnique([...targetDomains, ...sourceDomains]);

    // One transaction per merge: weighted-mean centroid update (using a
    // CTE that captures the source row before we mark it merged), then
    // re-point items, then mark source.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        WITH src AS (
          SELECT centroid, item_count, first_seen_at, last_seen_at
          FROM clusters WHERE id = ${sourceId}
        )
        UPDATE clusters c
        SET centroid = (c.centroid * c.item_count::float + src.centroid * src.item_count::float)
                       / ((c.item_count + src.item_count)::float),
            item_count = c.item_count + src.item_count,
            first_seen_at = LEAST(c.first_seen_at, src.first_seen_at),
            last_seen_at = GREATEST(c.last_seen_at, src.last_seen_at),
            domains = ${textArrayLiteral(mergedDomains)}
        FROM src
        WHERE c.id = ${targetId}
      `);
      await tx.execute(sql`
        UPDATE items SET cluster_id = ${targetId} WHERE cluster_id = ${sourceId}
      `);
      await tx.execute(sql`
        UPDATE clusters
        SET status = 'merged', merged_into = ${targetId}
        WHERE id = ${sourceId}
      `);
    });

    consumed.add(sourceId);
    pairs.push({ source: sourceId, target: targetId, distance: c.distance });
  }

  return { merges: pairs.length, pairs };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Format a number[] as a pgvector text literal. We send the vector as a
 * `text` parameter and cast to `::vector(N)` at use-site, which sidesteps
 * postgres-js's array stringification (which would emit `{1,2,3}`, the
 * wrong shape for pgvector — it wants `[1,2,3]`).
 */
function toPgvectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function sortedUnique(strs: string[]): string[] {
  return Array.from(new Set(strs)).sort();
}

/**
 * Build an inline `ARRAY['a', 'b']::text[]` SQL fragment. Used in place of
 * `${jsArray}::text[]` because drizzle's raw-`sql`-template path can emit
 * "malformed array literal" when binding a JS string[] for a cast that
 * requires the array element type to be inferred — even for plain text.
 * Inlining with sql.join keeps each element a properly-quoted text param.
 */
function textArrayLiteral(items: string[]): SQL {
  if (items.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    items.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;
}
