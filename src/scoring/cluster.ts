// Stage 2 of the scoring pipeline (SPEC §7.4) — clustering.
//
// Two entry points:
//
// - `assignCluster(db, input, opts)` — for each normalised item, find the
//   nearest active cluster in the same `primary_domain` within a 7-day
//   window and either join it (running-mean centroid update) or create a
//   new cluster. The running-mean update is read-modify-write inside a
//   `SELECT … FOR UPDATE` transaction (see ADR-007 for why JS-side, not
//   SQL — pgvector does not define `vector * float` or `vector / float`,
//   only element-wise vector-vector ops).
//
// - `compactClusters(db, opts)` — daily compaction (SPEC §7.4 step 4):
//   merge active clusters in the same domain whose centroids drifted
//   close (cosine distance < 0.15) AND whose member items share at least
//   one entity. The shared-entity guard is the safety net against false
//   merges (two distinct stories that happen to have similar centroids).
//   Each merge consumes BOTH sides for the pass — a target whose centroid
//   has moved must not be re-merged using a stale precomputed distance.
//
// Both functions take an optional `threshold` so Phase 3 PR 3 can wire in
// the per-domain values from SPEC §8's table via `config/domains.ts`
// without editing this module.
//
// See ADR-007 for the centroid-update rationale.

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
 * update is computed in JS inside a `SELECT … FOR UPDATE` transaction —
 * pgvector exposes only vector-vector arithmetic, not scalar ops, so the
 * SQL form `(centroid * n + new) / (n+1)` doesn't compile. See ADR-007.
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
  const vecLit = toPgvectorLiteral(input.embedding);

  // Find the closest active cluster in the same domain within the window.
  // pgvector's `<=>` is cosine distance (1 - cosine similarity). HNSW index
  // on `clusters.centroid` makes ORDER BY ... LIMIT 1 cheap.
  const found = await db.execute<{
    id: string;
    distance: number;
  }>(sql`
    SELECT id, (centroid <=> ${vecLit}::vector(${sql.raw(String(EMBEDDING_DIM))})) AS distance
    FROM clusters
    WHERE primary_domain = ${input.primaryDomain}
      AND status = 'active'
      AND last_seen_at > NOW() - make_interval(days => ${recencyDays})
    ORDER BY centroid <=> ${vecLit}::vector(${sql.raw(String(EMBEDDING_DIM))}) ASC
    LIMIT 1
  `);

  const match = found[0];
  if (match && match.distance < threshold) {
    // Re-read the matched row under a row lock, compute the new centroid
    // in JS, and write it back — all in one tx. The lookup-then-update
    // race window between the SELECT above and the UPDATE is closed by
    // `FOR UPDATE`. Phase 5 multi-worker may also want a per-(domain)
    // advisory lock around the candidate query, but Phase 2 is single-
    // worker so this is enough.
    await db.transaction(async (tx) => {
      const locked = await tx.execute<{
        centroid: string;
        item_count: number;
        domains: string[];
        last_seen_at: Date;
      }>(sql`
        SELECT centroid::text AS centroid, item_count, domains, last_seen_at
        FROM clusters
        WHERE id = ${match.id}
        FOR UPDATE
      `);
      const row = locked[0];
      if (!row) {
        // Defensive: the row was removed between the SELECT above and the
        // FOR UPDATE here (shouldn't happen — clusters aren't deleted).
        // Treat as no-match by re-throwing; the caller can retry.
        throw new Error(`assignCluster: matched cluster ${match.id} disappeared under lock`);
      }
      const currentCentroid = parsePgvectorLiteral(row.centroid);
      const n = row.item_count;
      const newCentroid = currentCentroid.map(
        (x, i) => (x * n + (input.embedding[i] ?? 0)) / (n + 1),
      );
      const newCentroidLit = toPgvectorLiteral(newCentroid);
      const mergedDomains = sortedUnique([...row.domains, ...input.itemDomains]);
      // GREATEST defends against out-of-order arrivals — a late-fetched
      // item published before the cluster's current last_seen_at must not
      // pull the marker backwards.
      const newLastSeenIso = new Date(
        Math.max(row.last_seen_at.getTime(), input.publishedAt.getTime()),
      ).toISOString();

      await tx.execute(sql`
        UPDATE clusters
        SET centroid = ${newCentroidLit}::vector(${sql.raw(String(EMBEDDING_DIM))}),
            item_count = item_count + 1,
            last_seen_at = ${newLastSeenIso}::timestamptz,
            domains = ${textArrayLiteral(mergedDomains)}
        WHERE id = ${match.id}
      `);
    });

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
      ${vecLit}::vector(${sql.raw(String(EMBEDDING_DIM))}),
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
 *   3. For each candidate in order, skip if EITHER side has already been
 *      consumed in this pass (both the source and the kept target are
 *      marked consumed after a merge, because the kept target's centroid
 *      has moved and the precomputed distance to any third cluster is no
 *      longer accurate — applying it could over-merge). Chained merges
 *      across three or more clusters are deferred to subsequent passes,
 *      which is acceptable at the daily cadence.
 *
 * Per merge: open a transaction, lock both rows with `FOR UPDATE`, read
 * the centroids back, compute the item-count-weighted mean in JS (pgvector
 * has no scalar arithmetic — see ADR-007), then UPDATE target + items +
 * source. One commit per merge; a crash mid-pass leaves a partial state
 * that the next day's run will continue from cleanly.
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
  // application code only iterates the surviving pairs. NB: the
  // `items.entities && items.entities` between-column overlap can't use a
  // GIN index (those help for `col && const_array` only); plan is nested
  // loop, bounded by recency + domain + EXISTS short-circuit. Watch this
  // in Phase 5 if compaction wall-time grows.
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

    // One transaction per merge:
    //   1. Lock both rows in stable id order (avoids deadlock pairs even
    //      under hypothetical concurrent compaction).
    //   2. Read both centroids; compute weighted mean in JS.
    //   3. UPDATE target with new centroid + book-keeping.
    //   4. Re-point items.
    //   5. Mark source merged.
    await db.transaction(async (tx) => {
      const [firstId, secondId] =
        targetId < sourceId ? [targetId, sourceId] : [sourceId, targetId];
      const locked = await tx.execute<{
        id: string;
        centroid: string;
        item_count: number;
        first_seen_at: Date;
        last_seen_at: Date;
      }>(sql`
        SELECT id, centroid::text AS centroid, item_count, first_seen_at, last_seen_at
        FROM clusters
        WHERE id IN (${firstId}, ${secondId})
        ORDER BY id
        FOR UPDATE
      `);
      const lockedTarget = locked.find((r) => r.id === targetId);
      const lockedSource = locked.find((r) => r.id === sourceId);
      if (!lockedTarget || !lockedSource) {
        throw new Error(
          `compactClusters: rows disappeared under lock (target=${targetId}, source=${sourceId})`,
        );
      }

      const tVec = parsePgvectorLiteral(lockedTarget.centroid);
      const sVec = parsePgvectorLiteral(lockedSource.centroid);
      const nT = lockedTarget.item_count;
      const nS = lockedSource.item_count;
      const total = nT + nS;
      const merged = tVec.map((x, i) => (x * nT + (sVec[i] ?? 0) * nS) / total);
      const mergedLit = toPgvectorLiteral(merged);

      const newFirstSeen = new Date(
        Math.min(lockedTarget.first_seen_at.getTime(), lockedSource.first_seen_at.getTime()),
      ).toISOString();
      const newLastSeen = new Date(
        Math.max(lockedTarget.last_seen_at.getTime(), lockedSource.last_seen_at.getTime()),
      ).toISOString();

      await tx.execute(sql`
        UPDATE clusters
        SET centroid = ${mergedLit}::vector(${sql.raw(String(EMBEDDING_DIM))}),
            item_count = ${total},
            first_seen_at = ${newFirstSeen}::timestamptz,
            last_seen_at = ${newLastSeen}::timestamptz,
            domains = ${textArrayLiteral(mergedDomains)}
        WHERE id = ${targetId}
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

    // Consume BOTH sides — the target's centroid has moved, so any later
    // precomputed candidate distance involving it is stale and applying it
    // could over-merge. Defer chained merges to the next compaction pass.
    consumed.add(sourceId);
    consumed.add(targetId);
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

/**
 * Parse a pgvector text literal (`[1,2,3]`) back into a number[]. We read
 * centroids via `centroid::text` because the postgres-js + drizzle binding
 * path returns the vector as the same `[...]` string under `::text`.
 */
function parsePgvectorLiteral(s: string): number[] {
  // The literal is JSON-compatible: square brackets, comma-separated numbers.
  const parsed = JSON.parse(s) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'number')) {
    throw new Error(`parsePgvectorLiteral: not a number array: ${s.slice(0, 80)}`);
  }
  return parsed as number[];
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
