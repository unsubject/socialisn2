// Daily Bayesian recalibration of source authority scores (ADR-013, Obs-3).
//
// For each enabled source we count pick/pass feedback rows from the last 30
// days attributable to that source (via candidates → clusters → items →
// raw_items → sources). 'defer' rows are intentionally ignored per ADR-013
// — they mean "not yet judged" rather than a negative signal.
//
// The new authority is the posterior mean of a Beta(α, β) distribution with
// α = α₀ + picks, β = β₀ + passes, where the prior Beta(α₀, β₀) is anchored
// on each source's authority_score_seed:
//
//   α₀ = k × seed/100
//   β₀ = k × (1 − seed/100)
//   k  = RECALIBRATE_PRIOR_STRENGTH (default 20)
//
// Posterior mean × 100 → rounded → clamped to [1, 100] → written to
// sources.authority_score. sources.authority_score_calibrated_at is
// stamped. A runs row with kind='recalibrate' frames the pass for /status.
//
// Cron schedule defaults to 04:00 UTC (env RECALIBRATE_CRON). node-cron's
// default tz is the system local tz, so we pin `timezone: 'UTC'` here —
// the VPS runs TZ=America/New_York which would otherwise shift the cron
// by hours.

import cron, { type ScheduledTask } from 'node-cron';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { createLogger, type Logger } from '../lib/logger.js';

/** Lookback window for feedback aggregation (ADR-013). */
const WINDOW_DAYS = 30;

export interface RecalibrationOptions {
  /** Prior strength k. Defaults to env.recalibratePriorStrength(). */
  priorStrength?: number;
  /** Bound-injected logger; defaults to the module logger. */
  logger?: Logger;
}

export interface RecalibrationResult {
  runId: string;
  sourcesConsidered: number;
  sourcesUpdated: number;
}

/** Row shape returned by the per-source feedback-aggregation query.
 *  `type` alias (not `interface`) — drizzle's `db.execute<T>` requires
 *  T extends Record<string, unknown>, which interfaces don't auto-satisfy.
 *  Memory: [[drizzle_execute_type_alias]]. */
type SourceAggregateRow = {
  source_id: string;
  authority_score_seed: number;
  picks: number;
  passes: number;
};

/**
 * Walk every enabled source, compute the Beta-Bernoulli posterior over the
 * last 30 days of pick/pass feedback, and update authority_score in one
 * transaction-less batch (per-row UPDATEs are fine — the cron runs once a
 * day and contention is nil). Returns a summary suitable for logging.
 *
 * Always writes exactly one `runs` row regardless of outcome:
 *   - `status='running'` at the start
 *   - flipped to `status='completed'` with metadata.sources_updated on success
 *   - flipped to `status='failed'` with the error text on throw
 */
export async function runRecalibration(
  db: Db,
  options: RecalibrationOptions = {},
): Promise<RecalibrationResult> {
  const k = options.priorStrength ?? env.recalibratePriorStrength();
  const log = options.logger ?? createLogger('recalibrate');
  const runId = uuidv7();

  await db.execute(sql`
    INSERT INTO runs (id, kind, status, started_at)
    VALUES (${runId}, 'recalibrate', 'running', NOW())
  `);

  try {
    // Two-step aggregation:
    //   1. (feedback × candidates × cluster's items × raw_items) → DISTINCT
    //      (feedback_id, source_id) so the cluster having N items from
    //      source S doesn't count one feedback row as N decisions.
    //   2. Group those distinct pairs per source, counting picks/passes.
    //      'defer' is filtered out at step 1 — it never enters the count.
    //
    // LEFT JOIN from sources ensures every enabled source appears in the
    // result, even one with no feedback in the window (picks=0, passes=0
    // → posterior = prior mean = seed/100 → unchanged authority).
    const rows = await db.execute<SourceAggregateRow>(sql`
      WITH per_decision AS (
        SELECT DISTINCT
          f.id    AS feedback_id,
          f.action AS action,
          ri.source_id AS source_id
        FROM feedback f
        JOIN candidates c ON c.id = f.candidate_id
        JOIN items i ON i.cluster_id = c.cluster_id
        JOIN raw_items ri ON ri.id = i.raw_item_id
        WHERE f.action IN ('pick', 'pass')
          AND f.created_at >= NOW() - INTERVAL '${sql.raw(String(WINDOW_DAYS))} days'
      ),
      per_source AS (
        SELECT
          source_id,
          COUNT(*) FILTER (WHERE action = 'pick')::int AS picks,
          COUNT(*) FILTER (WHERE action = 'pass')::int AS passes
        FROM per_decision
        GROUP BY source_id
      )
      SELECT
        s.id                       AS source_id,
        s.authority_score_seed     AS authority_score_seed,
        COALESCE(ps.picks, 0)::int AS picks,
        COALESCE(ps.passes, 0)::int AS passes
      FROM sources s
      LEFT JOIN per_source ps ON ps.source_id = s.id
      WHERE s.enabled = true
    `);

    let updated = 0;
    for (const row of rows) {
      const newScore = posteriorScore({
        seed: row.authority_score_seed,
        picks: row.picks,
        passes: row.passes,
        k,
      });

      // db.execute<T> returns Postgres numerics as JS numbers when small;
      // authority_score is an INT. Using a strict integer in the bind
      // path avoids the "invalid input syntax for type integer" failure
      // mode if a numeric ever sneaks through.
      await db.execute(sql`
        UPDATE sources
        SET authority_score = ${newScore},
            authority_score_calibrated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${row.source_id}
      `);
      updated++;
    }

    await db.execute(sql`
      UPDATE runs
      SET status = 'completed',
          completed_at = NOW(),
          metadata = jsonb_build_object(
            'sources_updated', ${updated}::int,
            'window_days', ${WINDOW_DAYS}::int,
            'prior_strength', ${k}::int
          )
      WHERE id = ${runId}
    `);

    log.info('recalibration complete', {
      run_id: runId,
      sources_updated: updated,
      window_days: WINDOW_DAYS,
      prior_strength: k,
    });

    return {
      runId,
      sourcesConsidered: rows.length,
      sourcesUpdated: updated,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE runs
      SET status = 'failed',
          completed_at = NOW(),
          error = ${msg.slice(0, 4_000)}
      WHERE id = ${runId}
    `);
    log.error('recalibration failed', { run_id: runId, error: msg });
    throw err;
  }
}

/**
 * Beta-Bernoulli posterior mean → integer score in [1, 100].
 *
 * Exported for unit tests / future direct callers — the cron path goes
 * through runRecalibration. Pure function, no DB.
 *
 * Edge cases the function defends against:
 *   - seed=0 or seed=100 → α₀ or β₀ becomes 0. With no feedback the
 *     posterior mean is 0 or 1, which the clamp pulls into [1, 100].
 *   - α + β must be > 0 for the mean to be defined. With k>0 (positive
 *     int guarantee from env.recalibratePriorStrength) and seed in
 *     [0, 100], α₀ + β₀ = k > 0 always.
 */
export function posteriorScore(input: {
  seed: number;
  picks: number;
  passes: number;
  k: number;
}): number {
  const { seed, picks, passes, k } = input;
  const alpha0 = (k * seed) / 100;
  const beta0 = k * (1 - seed / 100);
  const alpha = alpha0 + picks;
  const beta = beta0 + passes;
  const mean = alpha / (alpha + beta);
  const rounded = Math.round(mean * 100);
  return Math.max(1, Math.min(100, rounded));
}

export interface RecalibrationCronHandle {
  task: ScheduledTask;
  /** Manually run one pass (returns its summary). Exported for tests. */
  runOnce: () => Promise<RecalibrationResult>;
  stop: () => void;
}

export interface StartRecalibrationCronOptions {
  /**
   * Issue #122: called at the end of every cron tick (success OR
   * thrown). Recalibration is daily and quick — it adds little value
   * as a progress signal vs. the per-minute scheduler tick — but
   * wiring it for symmetry means a future change to the cron cadence
   * doesn't silently lose coverage.
   */
  onTick?: () => void;
}

/**
 * Register the daily recalibration cron. The schedule is read at call time
 * (default '0 4 * * *') and pinned to UTC explicitly — node-cron defaults
 * to system TZ, which on the VPS is America/New_York.
 *
 * Use the returned handle's `.stop()` from the worker shutdown path so the
 * cron tick stops firing before the DB connection closes.
 */
export function startRecalibrationCron(
  db: Db,
  opts: StartRecalibrationCronOptions = {},
): RecalibrationCronHandle {
  const log = createLogger('recalibrate');
  const onTick = opts.onTick;
  const runOnce = (): Promise<RecalibrationResult> => runRecalibration(db, { logger: log });

  const task = cron.schedule(
    env.recalibrateCron(),
    () => {
      runOnce()
        .catch((err: unknown) => {
          // runRecalibration already logged + persisted the failure via the
          // runs row. Swallow here so an unhandled rejection doesn't take
          // down the host process; the next tick will retry on schedule.
          log.error('cron tick threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => onTick?.());
    },
    {
      timezone: 'UTC',
    },
  );

  return {
    task,
    runOnce,
    stop: () => task.stop(),
  };
}
