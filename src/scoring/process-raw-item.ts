// Per-item Phase 2 orchestrator (SPEC §7.2 + §7.3 + §7.4).
//
// Takes one pending raw_item, runs:
//
//   normalise (Gemini Flash-Lite, §7.3)
//     → embed (OpenAI text-embedding-3-small, §7.2 step 2 / §7.4)
//       → semantic-dedup lookup (§7.2 step 2)
//         → if dup: mark raw_item processed with dedup_cluster_id, done
//         → else:   assignCluster (§7.4) + insert items row + mark processed
//
// All external dependencies (normalise, embed, dedup, cluster assign,
// cost ledger, ceiling check) are dependency-injected so the unit /
// integration tests can stub the LLM + OpenAI surface without env or
// fetch globals. The DB is real — every test goes through vitest +
// real-PG, matching the rest of the scoring/* test suite.
//
// What this module does NOT do:
//   - Poll for pending rows (that's src/workers/scoring.ts).
//   - Run compaction (src/workers/scoring.ts cron).
//   - Stages 3-7 (src/orchestrator/run.ts).
//
// Cost / ceiling discipline:
//
//   The cost ceiling (SPEC §12) is checked BEFORE the normalise call —
//   that's the expensive one (~$0.0006). Embedding is sub-cent so we
//   don't gate it separately. If the ceiling is already hit we return
//   `ceiling_hit` and the caller short-circuits the rest of its batch
//   (the daily total resets at midnight UTC; next tick after that will
//   resume cleanly). Cost rows ARE recorded as the calls happen — even
//   if the path fails between normalise + embed, the normalise spend is
//   real and the ledger must reflect it.
//
// Failure modes — what consumes a retry attempt vs what doesn't:
//
//   - **Caught exceptions** (LLM 5xx, schema violation, dim mismatch,
//     UNIQUE(items.raw_item_id) violation under multi-worker race) flow
//     through the outer catch → `markProcessingAttempt` →
//     `processing_attempts += 1` and the error message is stashed in
//     `raw_meta.last_processing_error`. Three transient errors in a row
//     therefore poisons a legit raw_item. That's the right pressure
//     relief in v1 — manual triage queries on poisoned rows
//     (`WHERE processed_at IS NULL AND processing_attempts >= 3`) are
//     how operators surface upstream LLM / API issues — but it does
//     mean transient-failure tolerance is exactly 3 by default.
//   - **Process death** (SIGKILL, OOM, container restart) between
//     `recordCost` and the items insert leaves the raw_item pending with
//     attempts UNCHANGED — the catch never runs. Next tick re-runs from
//     scratch and re-pays ~$0.0006. Acceptable for v1.
//   - **Successful processing** (normal-path OR dedup-hit) does NOT
//     bump attempts. The polling query filters on
//     `processed_at IS NULL` so the row stops being pulled regardless.
//
// Manual replay of a successfully-processed normal-path row requires
// clearing `processed_at` AND deleting the corresponding `items` row
// (`DELETE FROM items WHERE raw_item_id = $1` then
//  `UPDATE raw_items SET processed_at = NULL WHERE id = $1`).
// Skipping the DELETE means the next tick re-runs through to the items
// insert, hits the UNIQUE constraint, rolls back, attempts++ — three
// such retries poisons the row, which is the wrong failure mode for an
// intentional replay. See ADR-009 for the rationale.

import { type SQL, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../db/client.js';
import { BUCKET_NORMALIZE } from '../cost/buckets.js';
import { CostCeilingHitError, assertWithinCeiling as defaultAssertWithinCeiling } from '../cost/ceiling.js';
import { recordCost as defaultRecordCost } from '../cost/ledger.js';
import { EMBEDDING_DIM } from '../db/schema.js';
import { embed as defaultEmbed } from '../lib/embeddings.js';
import {
  assignCluster as defaultAssignCluster,
} from './cluster.js';
import {
  buildEmbeddingInput,
  normalizeItem as defaultNormalize,
} from './normalize.js';
import {
  findSemanticDuplicate as defaultFindSemanticDuplicate,
  type DuplicateMatch,
} from './semantic-dedup.js';

/**
 * Conservative pre-call projection for the cost-ceiling gate. The empirical
 * Gemini Flash-Lite normalise call clocks ~$0.0006 at our prompt sizes; the
 * 0.001 projection sits ~1.6× above so the ceiling check can't underestimate
 * a runaway prompt. Real cost is recorded post-call from the LlmCallResult.
 */
const NORMALIZE_PROJECTED_USD = 0.001;

/**
 * Subset of a raw_items row the orchestrator needs. The caller (worker) is
 * responsible for the SELECT that produces these — keeping the signature
 * narrow makes the unit-test fixture for `processRawItem` trivial.
 */
export interface PendingRawItem {
  id: string;
  title: string;
  content: string | null;
  language: string | null;
  publishedAt: Date;
}

export type ProcessOutcome =
  | {
      kind: 'normal';
      itemId: string;
      clusterId: string;
      isNewCluster: boolean;
      costUsd: number;
    }
  | {
      kind: 'dedup_hit';
      /** Cluster the duplicate items row belonged to. Nullable because
       *  items.cluster_id is itself nullable in the schema (defensive — in
       *  practice the scoring path always sets it). */
      dedupClusterId: string | null;
      dedupItemId: string;
      similarity: number;
      costUsd: number;
    }
  | {
      /** Cost ceiling already hit before normalise. No DB writes. Caller
       *  should stop iterating its batch and try again next tick. */
      kind: 'ceiling_hit';
    }
  | {
      /** Any other failure (LLM 5xx, schema violation, etc). The raw_item's
       *  processing_attempts has been bumped and the error stashed in
       *  raw_meta.last_processing_error. */
      kind: 'failed';
      error: Error;
    };

export interface ProcessDependencies {
  normalize?: typeof defaultNormalize;
  embed?: typeof defaultEmbed;
  findDuplicate?: typeof defaultFindSemanticDuplicate;
  assignCluster?: typeof defaultAssignCluster;
  recordCost?: typeof defaultRecordCost;
  assertWithinCeiling?: typeof defaultAssertWithinCeiling;
}

/**
 * Process one pending raw_item end-to-end. See module header for the
 * pipeline shape. Always returns a `ProcessOutcome`; only re-throws on
 * truly exceptional control-flow conditions that the worker shouldn't
 * mask (e.g., a deps function violating its declared signature).
 */
export async function processRawItem(
  db: Db,
  row: PendingRawItem,
  deps: ProcessDependencies = {},
): Promise<ProcessOutcome> {
  const normalize = deps.normalize ?? defaultNormalize;
  const embed = deps.embed ?? defaultEmbed;
  const findDuplicate = deps.findDuplicate ?? defaultFindSemanticDuplicate;
  const assignClusterFn = deps.assignCluster ?? defaultAssignCluster;
  const recordCostFn = deps.recordCost ?? defaultRecordCost;
  const assertCeiling = deps.assertWithinCeiling ?? defaultAssertWithinCeiling;

  // Pre-normalise ceiling gate. If hit, return without touching the row —
  // attempts counter stays put so the row will be re-tried cleanly once
  // the day rolls over.
  try {
    await assertCeiling(db, NORMALIZE_PROJECTED_USD, BUCKET_NORMALIZE);
  } catch (err) {
    if (err instanceof CostCeilingHitError) {
      return { kind: 'ceiling_hit' };
    }
    throw err;
  }

  // Idempotency pre-check. If an items row already exists for this
  // raw_item (from a successful prior pass that crashed before
  // marking processed_at, or from a multi-worker race that lost on
  // UNIQUE(items.raw_item_id)), short-circuit: mark processed and
  // return. Without this guard, assignCluster runs on every retry
  // and bumps cluster.item_count + recentroids each time, while the
  // items INSERT fails the UNIQUE constraint and the row burns
  // through to poison — cluster bookkeeping inflates by N for an
  // N-retry loop.
  const existingItem = await db.execute<{ id: string; cluster_id: string | null }>(
    sql`SELECT id, cluster_id FROM items WHERE raw_item_id = ${row.id} LIMIT 1`,
  );
  const existing = existingItem[0];
  if (existing) {
    await db.execute(sql`
      UPDATE raw_items SET processed_at = NOW() WHERE id = ${row.id}
    `);
    return {
      kind: 'normal',
      itemId: existing.id,
      // cluster_id is nullable on items; empty string is the safe
      // signal "no cluster known here" without inventing a fake id.
      clusterId: existing.cluster_id ?? '',
      isNewCluster: false,
      costUsd: 0,
    };
  }

  let totalCost = 0;
  try {
    const norm = await normalize({
      title: row.title,
      content: row.content,
      language: row.language,
    });
    totalCost += await recordCostFn(db, {
      model: norm.llm.model,
      inputTokens: norm.llm.inputTokens,
      outputTokens: norm.llm.outputTokens,
      usd: norm.llm.usd,
      stage: 'normalise',
    });

    const embedded = await embed({ inputs: [buildEmbeddingInput(norm.item)] });
    const vector = embedded.vectors[0];
    if (!vector) {
      // embed() returns null only for empty inputs — buildEmbeddingInput
      // always produces a non-empty string when summaryEn + contextEn are
      // non-empty (normalize enforces both). A null here means an invariant
      // violation, not a bad row.
      throw new Error(
        `processRawItem: embed returned null vector for raw_item ${row.id}`,
      );
    }
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `processRawItem: embed returned vector length ${vector.length} !== EMBEDDING_DIM ${EMBEDDING_DIM}`,
      );
    }
    totalCost += await recordCostFn(db, {
      model: 'text-embedding-3-small',
      inputTokens: embedded.inputTokens,
      outputTokens: 0,
      usd: embedded.usd,
      stage: 'embed',
    });

    // SPEC §7.2 step 2 — semantic dedup. If a near-duplicate (cosine ≥
    // 0.93) exists in the same domain within the recency window, this
    // raw_item is merged into the same cluster WITHOUT a new items row.
    // We intentionally skip both `items` insert and any cluster
    // bookkeeping (item_count, last_seen_at) — duplicates must not bias
    // downstream temperature z-score / curation cost models.
    const dup = await findDuplicate(db, {
      embedding: vector,
      primaryDomain: norm.item.primaryDomain,
    });
    if (dup) {
      await markProcessedDedupHit(db, row.id, dup);
      return {
        kind: 'dedup_hit',
        dedupClusterId: dup.clusterId,
        dedupItemId: dup.itemId,
        similarity: dup.similarity,
        costUsd: totalCost,
      };
    }

    // Normal path. assignCluster handles its own FOR UPDATE locking on
    // cluster join; items insert + raw_items mark-processed are wrapped
    // in a single transaction so a crash leaves no orphaned items row.
    const cluster = await assignClusterFn(db, {
      embedding: vector,
      primaryDomain: norm.item.primaryDomain,
      itemDomains: norm.item.domains,
      publishedAt: row.publishedAt,
    });
    const itemId = await insertItemAndMarkProcessed(db, {
      rawItemId: row.id,
      titleOriginal: row.title,
      summaryEn: norm.item.summaryEn,
      contextEn: norm.item.contextEn,
      languageOriginal: row.language ?? 'unknown',
      entities: norm.item.entities,
      keywords: norm.item.keywords,
      domains: norm.item.domains,
      primaryDomain: norm.item.primaryDomain,
      embedding: vector,
      publishedAt: row.publishedAt,
      clusterId: cluster.clusterId,
    });
    return {
      kind: 'normal',
      itemId,
      clusterId: cluster.clusterId,
      isNewCluster: cluster.isNew,
      costUsd: totalCost,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    await markProcessingAttempt(db, row.id, error);
    return { kind: 'failed', error };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function markProcessedDedupHit(
  db: Db,
  rawItemId: string,
  dup: DuplicateMatch,
): Promise<void> {
  // Successful path — attempts counter is NOT bumped. The polling query
  // already filters on processed_at IS NULL so a successfully-processed
  // row will never be re-picked; bumping attempts on success would conflate
  // "this row keeps failing" with "this row was tried once", defeating the
  // poison-row threshold's diagnostic value.
  await db.execute(sql`
    UPDATE raw_items
    SET processed_at     = NOW(),
        dedup_cluster_id = ${dup.clusterId}
    WHERE id = ${rawItemId}
  `);
}

interface ItemInsertParams {
  rawItemId: string;
  titleOriginal: string;
  summaryEn: string;
  contextEn: string;
  languageOriginal: string;
  entities: string[];
  keywords: string[];
  domains: string[];
  primaryDomain: string;
  embedding: number[];
  publishedAt: Date;
  clusterId: string;
}

async function insertItemAndMarkProcessed(
  db: Db,
  p: ItemInsertParams,
): Promise<string> {
  const itemId = uuidv7();
  const vecLit = `[${p.embedding.join(',')}]`;
  const publishedIso = p.publishedAt.toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      ) VALUES (
        ${itemId},
        ${p.rawItemId},
        ${p.titleOriginal},
        ${p.summaryEn},
        ${p.contextEn},
        ${p.languageOriginal},
        ${textArrayLiteral(p.entities)},
        ${textArrayLiteral(p.keywords)},
        ${textArrayLiteral(p.domains)},
        ${p.primaryDomain},
        ${vecLit}::vector(${sql.raw(String(EMBEDDING_DIM))}),
        ${publishedIso}::timestamptz,
        ${p.clusterId}
      )
    `);
    await tx.execute(sql`
      UPDATE raw_items
      SET processed_at = NOW()
      WHERE id = ${p.rawItemId}
    `);
  });
  return itemId;
}

async function markProcessingAttempt(
  db: Db,
  rawItemId: string,
  error: Error,
): Promise<void> {
  // Failure path — bump attempts and stash a short error string in
  // raw_meta for human triage. Truncate aggressively because raw_meta is
  // a jsonb document and we don't want a multi-KB stack trace bloating
  // the row.
  //
  // If THIS UPDATE itself fails (DB connection dropped mid-call), the
  // exception propagates to the worker, which logs it. The raw_item
  // stays pending with attempts unchanged — next tick re-runs the row
  // and re-fails on the same upstream issue, then attempts++ runs
  // correctly. That's acceptable: a single missed bump under DB outage
  // is better than wrapping this in its own retry loop that could
  // disagree with the worker's view of "tried N times".
  const errMsg = error.message.slice(0, 240);
  await db.execute(sql`
    UPDATE raw_items
    SET processing_attempts = processing_attempts + 1,
        raw_meta = COALESCE(raw_meta, '{}'::jsonb)
                   || jsonb_build_object('last_processing_error', ${errMsg}::text)
    WHERE id = ${rawItemId}
  `);
}

/**
 * Build an inline `ARRAY['a', 'b']::text[]` SQL fragment. Mirrors the
 * helper in src/scoring/cluster.ts — drizzle's raw-`sql`-template path
 * can emit "malformed array literal" when binding a JS string[] for a
 * cast that requires element-type inference, even for plain text.
 * Inlining with sql.join keeps each element a properly-quoted text param.
 */
function textArrayLiteral(items: string[]): SQL {
  if (items.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    items.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;
}
