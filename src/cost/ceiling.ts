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

import { dailyTotalUsd } from './ledger.js';
import { env } from '../config/env.js';
import type { Db } from '../db/client.js';

export interface CeilingStatus {
  /** USD spent so far in the current UTC day. */
  spent: number;
  /** COST_CEILING_DAILY_USD (default 1.50). */
  ceiling: number;
  /** COST_ALERT_THRESHOLD as a fraction (default 0.80). */
  alertThreshold: number;
  /** spent / ceiling, can exceed 1.0 if a single call pushed past. */
  pctOfCeiling: number;
  /** True when pctOfCeiling ≥ alertThreshold — caller fires the alert. */
  atAlertThreshold: boolean;
  /** True when pctOfCeiling ≥ 1.0 — ceiling already breached. */
  hitCeiling: boolean;
}

export class CostCeilingHitError extends Error {
  /** SPEC §12 reason code, used for logging and runs.error. */
  readonly code = 'cost_ceiling_hit';
  constructor(
    public readonly spent: number,
    public readonly projected: number,
    public readonly ceiling: number,
  ) {
    super(
      `Cost ceiling hit: spent=$${spent.toFixed(4)} + projected=$${projected.toFixed(4)} >= ceiling=$${ceiling.toFixed(2)}`,
    );
    this.name = 'CostCeilingHitError';
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
 * cent that takes us across.
 */
export async function assertWithinCeiling(
  db: Db,
  projectedCostUsd: number,
): Promise<CeilingStatus> {
  if (!Number.isFinite(projectedCostUsd) || projectedCostUsd < 0) {
    throw new Error(
      `assertWithinCeiling: projectedCostUsd must be a non-negative finite number (got ${projectedCostUsd})`,
    );
  }
  const ceiling = env.costCeilingDailyUsd();
  const spent = await dailyTotalUsd(db);
  if (spent + projectedCostUsd >= ceiling) {
    throw new CostCeilingHitError(spent, projectedCostUsd, ceiling);
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
    atAlertThreshold: pctOfCeiling >= alertThreshold,
    hitCeiling: pctOfCeiling >= 1,
  };
}
