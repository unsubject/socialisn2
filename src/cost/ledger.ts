// cost_ledger writer + daily-total reader.
//
// Every LLM / embedding call should write a row here. The Stage 0-7 scoring
// pipeline reads `dailyTotalUsd()` before each stage and halts gracefully
// when projected stage cost would exceed `COST_CEILING_DAILY_USD` per
// SPEC §12. Hard halt — not advisory.
//
// This module is the only writer to `cost_ledger`. Code outside `src/cost/`
// should not INSERT into the table directly.

import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../db/client.js';
import { costLedger } from '../db/schema.js';
import { bucketForStage, type CostBucket } from './buckets.js';
import { computeCostUsd } from './pricing.js';

export interface CostEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Optional explicit USD override. If omitted, `computeCostUsd()` derives
   * it from the pricing table. LiteLLM-served responses sometimes carry a
   * `_response_cost` we'd want to honour; embedding calls always pass the
   * computed value.
   */
  usd?: number;
  /** Pipeline stage tag for cost breakdown — e.g. 'normalise', 'curate'. */
  stage?: string;
  /** Owning run, when called inside a scoring run. */
  runId?: string;
}

/**
 * Insert a single cost row. Returns the computed USD so callers don't have
 * to recompute for telemetry.
 *
 * Phase 3: the row's `bucket` column is derived from `entry.stage` via
 * `bucketForStage()`. Callers don't need to know about the stage→bucket
 * mapping. Stages we don't recognise produce a null bucket — the row
 * still lands but doesn't count against any sub-budget ceiling.
 */
export async function recordCost(db: Db, entry: CostEntry): Promise<number> {
  const usd =
    entry.usd ?? computeCostUsd(entry.model, entry.inputTokens, entry.outputTokens);
  await db.insert(costLedger).values({
    id: uuidv7(),
    runId: entry.runId,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    usd: usd.toFixed(6),
    stage: entry.stage,
    bucket: bucketForStage(entry.stage),
  });
  return usd;
}

/**
 * Sum USD spent today (UTC). Used by Stage gating in SPEC §12.
 *
 * UTC was chosen over America/New_York because:
 *   1. The `occurred_at` column is timestamptz, so the comparison is
 *      timezone-agnostic at the SQL level; choice of "day" boundary is a
 *      reporting decision.
 *   2. Cost-ceiling enforcement and the §11 Telegram `/status` UX both want
 *      a stable rolling 24-hour view. Anchoring to ET would create two
 *      anomalous days each year (DST), which complicates alerting.
 *
 * We use PG16's 3-arg `date_trunc(field, source, tz)`, which takes a
 * timestamptz and returns a timestamptz anchored at the start of `tz`-day.
 * The 2-arg `date_trunc('day', NOW() AT TIME ZONE 'UTC')` would return a
 * plain `timestamp` (tz stripped); comparing that to a `timestamptz` column
 * triggers an implicit cast using the SESSION's `TimeZone` GUC, NOT UTC —
 * which would silently shift the boundary on any host where the session TZ
 * isn't `Etc/UTC` (Hostinger VPS containers default to host TZ). This bug
 * was not catchable by the original test because the forged "yesterday"
 * row was 24 h before now under any boundary calculation.
 *
 * If the operator's preference shifts to ET-aligned reporting, change the
 * third argument to `'America/New_York'`.
 */
export async function dailyTotalUsd(db: Db): Promise<number> {
  const rows = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(usd), 0)::text AS total
        FROM cost_ledger
        WHERE occurred_at >= date_trunc('day', NOW(), 'UTC')`,
  );
  const total = rows[0]?.total ?? '0';
  return Number(total);
}

/**
 * Sum USD spent today (UTC) inside a given bucket. Used by Phase 3
 * per-stage sub-budget enforcement — see `assertWithinCeiling` in
 * src/cost/ceiling.ts.
 *
 * Same boundary semantics as `dailyTotalUsd` — see the comment block
 * above for why we use the 3-arg `date_trunc(..., 'UTC')`.
 *
 * The bucket-filter index (idx_cost_ledger_bucket_occurred_at, partial
 * `WHERE bucket IS NOT NULL`) makes this a thin index seek. Historical
 * rows with NULL bucket are excluded from this sum even if they fall
 * inside the current day window — they predate the bucket column.
 */
export async function dailyTotalUsdByBucket(
  db: Db,
  bucket: CostBucket,
): Promise<number> {
  const rows = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(usd), 0)::text AS total
        FROM cost_ledger
        WHERE bucket = ${bucket}
          AND occurred_at >= date_trunc('day', NOW(), 'UTC')`,
  );
  const total = rows[0]?.total ?? '0';
  return Number(total);
}
