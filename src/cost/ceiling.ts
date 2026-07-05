// SPEC §12 cost ceiling enforcement.
//
// Two responsibilities:
//   1. assertWithinCeiling — called by the orchestrator BEFORE each
//      Stage 4/6 cluster batch. Throws CostCeilingHitError when adding
//      the projected stage cost would push today's total over the
//      configured daily ceiling. Caller catches, marks the run as
//      `failed` with `cost_ceiling_hit` reason, and persists whatever
//      candidates Stage 7 already wrote ("partial candidates are still
//      persisted" per SPEC §12).
//   2. checkCeiling — read-only status snapshot for the Telegram
//      /status surface (SPEC §11.3) and for the 80% alert hook.
//
// Ceiling and alert threshold come from env (COST_CEILING_DAILY_USD,
// COST_ALERT_THRESHOLD) so deployments can tune without code changes.
// dailyTotalUsd lives in ledger.ts — this module composes on top of it
// rather than duplicating the per-day SUM query.

import { dailyTotalUsd, dailyTotalUsdByBucket } from './ledger.js';
import {
  BUCKET_BRIEF,
  BUCKET_NORMALIZE,
  BUCKET_ORCHESTRATOR,
  type CostBucket,
} from './buckets.js';
import { env } from '../config/env.js';
import type { Db } from '../db/client.js';

// FP slack at threshold boundaries. Without this, IEEE 754 surprises
// like 1.2 / 1.5 = 0.7999999999999999 make a spend that's operationally
// AT 80% of ceiling fail the >= alertThreshold check. 1e-9 is six orders
// of magnitude below the smallest USD amount we'd ever ledger
// (cost_ledger.usd is numeric(10,6), so the minimum representable
// non-zero spend is $0.000001), so the epsilon cannot mask a real spend
// crossing the threshold.
const COMPARISON_EPSILON = 1e-9;

export interface CeilingStatus {
  /** USD spent so far in the current UTC day. */
  spent: number;
  /** COST_CEILING_DAILY_USD (default 2.20). */
  ceiling: number;
  /** COST_ALERT_THRESHOLD as a fraction (default 0.80). */
  alertThreshold: number;
  /** spent / ceiling, can exceed 1.0 if a single call pushed past. */
  pctOfCeiling: number;
  /** True when pctOfCeiling ≥ alertThreshold (with FP slack) — caller fires the alert. */
  atAlertThreshold: boolean;
  /** True when pctOfCeiling ≥ 1.0 (with FP slack) — ceiling already breached. */
  hitCeiling: boolean;
}

export class CostCeilingHitError extends Error {
  /** SPEC §12 reason code, scope-suffixed so the orchestrator's
   *  `halt.reason = err.code` path (src/orchestrator/run.ts) carries
   *  the scope into `runs.error`. Pre-Phase-3 the code was just the
   *  constant `'cost_ceiling_hit'`; that meant a per-bucket trip
   *  surfaced as a generic `cost_ceiling_hit` in runs.error with no
   *  signal as to which tier ran away. */
  readonly code: 'cost_ceiling_hit' | `cost_ceiling_hit:${'daily' | CostBucket}`;
  constructor(
    public readonly spent: number,
    public readonly projected: number,
    public readonly ceiling: number,
    /** Phase 3: which budget tripped — 'daily', 'normalize', or
     *  'orchestrator'. 'daily' for the overall ceiling. */
    public readonly scope: 'daily' | CostBucket = 'daily',
  ) {
    super(
      `Cost ceiling hit (${scope}): spent=$${spent.toFixed(4)} + projected=$${projected.toFixed(4)} >= ceiling=$${ceiling.toFixed(2)}`,
    );
    this.name = 'CostCeilingHitError';
    this.code = `cost_ceiling_hit:${scope}`;
  }
}

/** Resolve the per-bucket ceiling from env. Used by assertWithinCeiling
 *  when a bucket is provided. The `never` branch is an exhaustiveness
 *  check — adding a third bucket without updating this switch becomes a
 *  TS compile error rather than a runtime silent-pass (where bucketCap
 *  would be `undefined`, then NaN >= NaN === false → the gate would
 *  silently let the call through). */
function bucketCeiling(bucket: CostBucket): number {
  switch (bucket) {
    case BUCKET_NORMALIZE:
      return env.costCeilingNormalizeDailyUsd();
    case BUCKET_ORCHESTRATOR:
      return env.costCeilingOrchestratorDailyUsd();
    case BUCKET_BRIEF:
      return env.costCeilingBriefDailyUsd();
    default: {
      const _exhaustive: never = bucket;
      throw new Error(`bucketCeiling: unhandled bucket ${String(_exhaustive)}`);
    }
  }
}

/**
 * Read-only snapshot of today's spend vs ceiling. Use this for status
 * dashboards and for the 80% alert check. Does not throw.
 */
export async function checkCeiling(db: Db): Promise<CeilingStatus> {
  const spent = await dailyTotalUsd(db);
  return buildStatus(spent);
}

/**
 * Guard a pending stage / call. Throws CostCeilingHitError if today's
 * spent + projectedCostUsd would meet or exceed the ceiling. Returns the
 * pre-call CeilingStatus on success so the caller can fire the
 * 80%-of-ceiling alert.
 *
 * Use `≥` (not `>`) at the boundary: a call that exactly hits the
 * ceiling is treated as a hit. The intent is to NOT spend the marginal
 * cent that takes us across. COMPARISON_EPSILON folds FP slack into the
 * same direction — a sum that's mathematically at the ceiling but lands
 * one ulp below in floats still trips.
 *
 * Phase 3: when `bucket` is provided, checks BOTH the per-bucket daily
 * ceiling (from env.costCeilingNormalizeDailyUsd / OrchestratorDailyUsd)
 * AND the overall daily ceiling. Either tripping throws CostCeilingHitError
 * with the corresponding scope. Without a bucket, behavior is unchanged
 * from pre-Phase 3 — overall daily ceiling only. The returned status
 * always describes the OVERALL ceiling (the bucket sub-budget is a
 * runtime check, not user-facing telemetry surface — for now).
 */
export async function assertWithinCeiling(
  db: Db,
  projectedCostUsd: number,
  bucket?: CostBucket,
): Promise<CeilingStatus> {
  if (!Number.isFinite(projectedCostUsd) || projectedCostUsd < 0) {
    throw new Error(
      `assertWithinCeiling: projectedCostUsd must be a non-negative finite number (got ${projectedCostUsd})`,
    );
  }

  // Phase 3: bucket check FIRST when provided. A normalize run that
  // blew its sub-budget should fail loud with scope='normalize' even if
  // the overall daily ceiling is still under — the operator wants to
  // see WHICH stage went runaway, not just "we hit the ceiling".
  if (bucket) {
    const bucketCap = bucketCeiling(bucket);
    const bucketSpent = await dailyTotalUsdByBucket(db, bucket);
    if (bucketSpent + projectedCostUsd + COMPARISON_EPSILON >= bucketCap) {
      throw new CostCeilingHitError(
        bucketSpent,
        projectedCostUsd,
        bucketCap,
        bucket,
      );
    }
  }

  // Overall daily ceiling — always checked.
  const ceiling = env.costCeilingDailyUsd();
  const spent = await dailyTotalUsd(db);
  if (spent + projectedCostUsd + COMPARISON_EPSILON >= ceiling) {
    throw new CostCeilingHitError(spent, projectedCostUsd, ceiling, 'daily');
  }
  return buildStatus(spent);
}

function buildStatus(spent: number): CeilingStatus {
  const ceiling = env.costCeilingDailyUsd();
  const alertThreshold = env.costAlertThreshold();
  const pctOfCeiling = ceiling > 0 ? spent / ceiling : 0;
  return {
    spent,
    ceiling,
    alertThreshold,
    pctOfCeiling,
    atAlertThreshold: pctOfCeiling + COMPARISON_EPSILON >= alertThreshold,
    hitCeiling: pctOfCeiling + COMPARISON_EPSILON >= 1,
  };
}
