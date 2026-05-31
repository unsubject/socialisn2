// Stuck-runs watchdog. Periodically fails any runs row stuck in
// status='running' beyond a sane upper bound.
//
// Two ways a runs row gets stuck:
//   1. Container restart mid-run (SIGKILL, OOM, deploy). The orphan
//      reaper at ingestion-worker boot handles this on the next start,
//      but only for runs the EARLIER incarnation of that process
//      started — and only on restart. A run started from THIS process
//      and aborted mid-flight (process kill -9) won't be cleaned until
//      the next boot reads it.
//   2. The orchestrator throws inside `try`, the outer catch in
//      runScoring writes status='failed' — that path is covered. But
//      a throw OUTSIDE the try (between INSERT runs and the try block)
//      leaves status='running' with no path to update. Today there's
//      no such throw, but the watchdog protects against future
//      reordering breaking that invariant silently.
//
// The watchdog complements (not replaces) the boot reaper: boot reaper
// cleans on container start (0-min latency); watchdog catches what
// happens between boots (≤90-min latency at threshold).
//
// Threshold: 90 minutes. A real orchestrator pass with the v1 cluster
// volume completes in <30 min; 90 min gives 3× headroom so a slow-but-
// legit run isn't false-positive-failed.

import cron, { type ScheduledTask } from 'node-cron';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { createLogger, type Logger } from '../lib/logger.js';

export interface StuckRunsWatchdogDependencies {
  scheduleFn?: (
    cronExpression: string,
    func: () => void,
    options?: { scheduled?: boolean; timezone?: string },
  ) => ScheduledTask;
  logger?: Logger;
  /** Cron pattern. Default: every 5 minutes. */
  pattern?: string;
  /** Threshold in minutes. Default: 90. */
  maxAgeMinutes?: number;
}

export interface StuckRunsWatchdogHandle {
  task: ScheduledTask;
  stop: () => void;
  /**
   * Run one watchdog pass synchronously. Exposed so a process can
   * invoke the reaper at boot (same SQL as the cron tick) without
   * waiting for the first scheduled fire.
   */
  reapNow: () => Promise<{ reaped: number }>;
}

export function startStuckRunsWatchdog(
  db: Db,
  deps: StuckRunsWatchdogDependencies = {},
): StuckRunsWatchdogHandle {
  const schedule = deps.scheduleFn ?? cron.schedule;
  const log = deps.logger ?? createLogger('stuck-runs-watchdog');
  const pattern = deps.pattern ?? '*/5 * * * *';
  const maxAgeMinutes = deps.maxAgeMinutes ?? 90;

  const reapNow = async (): Promise<{ reaped: number }> => {
    // Returns the count of rows we actually flipped so the log line
    // distinguishes "tick fired, nothing stuck" from "tick fired,
    // killed N stuck runs" (the latter is the operationally interesting
    // signal).
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE runs
      SET status = 'failed',
          error = COALESCE(error || '; ', '') || 'stuck_run_watchdog',
          completed_at = NOW()
      WHERE status = 'running'
        AND started_at < NOW() - make_interval(mins => ${maxAgeMinutes})
      RETURNING id
    `);
    return { reaped: rows.length };
  };

  const task = schedule(
    pattern,
    () => {
      reapNow()
        .then(({ reaped }) => {
          if (reaped > 0) {
            log.warn('stuck runs watchdog reaped runs', {
              reaped,
              max_age_minutes: maxAgeMinutes,
            });
          }
        })
        .catch((err: unknown) => {
          log.error('stuck runs watchdog tick threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    { scheduled: true },
  );

  return {
    task,
    stop: () => task.stop(),
    reapNow,
  };
}

/**
 * Boot-time orphan reaper. Marks `runs.status='running'` rows OWNED BY
 * THIS PROCESS as failed with reason 'process_restart'. Distinguished
 * from the watchdog reason ('stuck_run_watchdog') so an operator
 * scanning runs.error can tell "we restarted while a run was in flight"
 * from "a run hung past the threshold". Runs unconditionally at boot —
 * there's no time window check because the restart itself IS the signal.
 *
 * Kind-scoped: this reaper runs in the ingestion-worker process, which
 * owns 'morning' + 'afternoon' (orchestrator-cron) runs only. MCP
 * `run_now` produces 'manual' runs and lives in the *app* process — a
 * separate container with an independent lifecycle. If we reaped
 * 'manual' rows here, an ingestion-worker restart (deploy, OOM)
 * mid-MCP-run would mark the in-flight app-process run as
 * 'failed/process_restart' while the lock is still held + candidates
 * keep being inserted; the eventual finaliseRun no-ops (predicate
 * `AND status='running'`) and the row ends as a phantom failure even
 * though candidates shipped.
 *
 * The 'manual' run's process — the app — does its own orphan handling
 * via the stuck-runs watchdog cron, which also runs in this process
 * but waits the 90-min threshold rather than reaping unconditionally.
 * That's the right cadence for cross-process orphans.
 */
export async function reapOrphanedRunsOnBoot(db: Db): Promise<{ reaped: number }> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE runs
    SET status = 'failed',
        error = COALESCE(error || '; ', '') || 'process_restart',
        completed_at = NOW()
    WHERE status = 'running'
      AND kind IN ('morning', 'afternoon')
    RETURNING id
  `);
  return { reaped: rows.length };
}
