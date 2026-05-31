// Obs-2 — fire-once-per-UTC-day Telegram alert when daily LLM spend
// crosses COST_ALERT_THRESHOLD (default 80%) of COST_CEILING_DAILY_USD.
//
// Called by the orchestrator immediately AFTER a successful
// assertWithinCeiling() (so the alert lands on the *non-throwing* path —
// when assertWithinCeiling throws, the run halts anyway and a separate
// alert would be redundant with that halt). Per-call cost: one
// checkCeiling SELECT, then at most one INSERT and one Telegram round-
// trip on the day the threshold is first crossed; below threshold or
// already-fired-today it is a single SELECT.
//
// State lives in cost_alert_state (migration 014). The primary key is
// `alert_day DATE` so ON CONFLICT (alert_day) DO NOTHING is the entire
// dedup mechanism — no application-side fired-today check is needed.
// Each UTC day re-opens (a row dated yesterday does not block today's
// INSERT), satisfying the "re-cross next day fires again" requirement
// without any cleanup job.
//
// Failure semantics — if the Telegram push fails, the alert_state row
// is DELETEd so the next call retries. The brief explicitly says "do
// not silently swallow"; cleanup-on-push-failure converts the swallow
// into a retry while keeping the at-most-once-per-day contract intact
// (a second concurrent caller in the same UTC day, between our INSERT
// and our DELETE, would see the row and short-circuit — but at the
// orchestrator's call cadence (per-stage, serially) that race window
// is closed in practice).

import { sql } from 'drizzle-orm';

import { checkCeiling, type CeilingStatus } from './ceiling.js';
import type { Db } from '../db/client.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('cost-alert');

/**
 * Telegram-push surface used by maybeFireCostAlert. The default
 * implementation in src/orchestrator/run.ts wraps src/telegram/push.ts;
 * tests inject a spy. Throws on any push failure so the caller can
 * roll back the alert_state row.
 */
export type CostAlertPusher = (text: string) => Promise<void>;

/**
 * Probe the ceiling once; if at-or-over alert threshold, attempt to
 * claim today's UTC date row in cost_alert_state. On successful claim,
 * fire the Telegram push. On push failure, delete the row so the next
 * call re-attempts.
 *
 * Returns `true` iff this call fired the push (test convenience —
 * production callers can ignore the return value).
 */
export async function maybeFireCostAlert(
  db: Db,
  pusher: CostAlertPusher,
): Promise<boolean> {
  const status = await checkCeiling(db);
  if (!status.atAlertThreshold) return false;

  // ON CONFLICT (alert_day) DO NOTHING + RETURNING tells us atomically
  // whether we won the race. rows.length === 0 means another caller (or
  // a previous invocation today) already fired. We don't read rowCount
  // because db.execute(...) over postgres-js doesn't surface it
  // reliably; existing call sites use RETURNING (see
  // src/mcp/tools/sources.ts) and we follow that convention.
  // Audit A-P1-4: clamp at 9.9999 to fit NUMERIC(5,4) (max 9.9999).
  // Without this, a runaway $15 call against a $1.50 ceiling produces
  // pctOfCeiling=10.0 → '10.0000' → INSERT throws `numeric field
  // overflow`. safeMaybeFireCostAlert in the orchestrator swallows
  // it, and the alert that exists exactly for the runaway-cost case
  // is lost. The clamped value loses precision above 9.9999×ceiling
  // but the alert still fires; widen the column in a follow-up
  // migration if higher precision matters.
  const clampedPct = Math.min(status.pctOfCeiling, 9.9999);
  const rows = await db.execute<{ alert_day: string }>(sql`
    INSERT INTO cost_alert_state (alert_day, pct_at_fire)
    VALUES (
      (NOW() AT TIME ZONE 'UTC')::date,
      ${clampedPct.toFixed(4)}
    )
    ON CONFLICT (alert_day) DO NOTHING
    RETURNING alert_day
  `);
  const claimedDay = rows[0]?.alert_day;
  if (!claimedDay) return false;
  const text = formatAlertText(status);
  try {
    await pusher(text);
  } catch (err) {
    // Push failed — release the row so the next orchestrator pass
    // re-attempts. We log at error level rather than throwing because
    // the caller is the orchestrator's per-stage loop; a push failure
    // is not a reason to abort scoring.
    await db.execute(sql`
      DELETE FROM cost_alert_state WHERE alert_day = ${claimedDay}
    `);
    log.error('cost alert push failed; rolled back state row', {
      err: err instanceof Error ? err.message : String(err),
      alertDay: claimedDay,
      pctOfCeiling: status.pctOfCeiling,
    });
    return false;
  }

  log.info('cost alert fired', {
    alertDay: claimedDay,
    pctOfCeiling: status.pctOfCeiling,
    spent: status.spent,
    ceiling: status.ceiling,
  });
  return true;
}

/**
 * Plain-text alert body. Telegram parse_mode is MarkdownV2; the
 * orchestrator's wrapper handles escaping. We keep the message plain
 * (no markdown formatting) so escape becomes a straight pass-through.
 */
function formatAlertText(status: CeilingStatus): string {
  const pct = (status.pctOfCeiling * 100).toFixed(1);
  const ceiling = status.ceiling.toFixed(2);
  return `Cost alert: today's LLM spend is at ${pct}% of $${ceiling} ceiling.`;
}
