// Twice-daily orchestrator cron — fires runScoring (Stages 3-7) at the
// morning + afternoon slots described in SPEC §9 and src/orchestrator/run.ts.
//
// Two cron tasks register here:
//   - morning   — env.orchestratorMorningCron()   (default '0 5 * * *')
//   - afternoon — env.orchestratorAfternoonCron() (default '0 14 * * *')
//
// Both are pinned to env.orchestratorTimezone() (default 'America/New_York').
// node-cron's default tz is the host's local tz; pinning here makes the
// schedule independent of however TZ is set on the runtime container, so
// '0 5 * * *' always means 05:00 ET — never drifts if someone flips the
// container TZ in a deploy.
//
// Each fire calls runScoring(db, { kind }) with the matching kind. If the
// underlying run throws, the cron-tick wrapper logs via createLogger and
// SWALLOWS — the next scheduled tick will retry. runScoring itself owns the
// runs-row lifecycle (status='failed' + error column) for the durable
// record. The cost-alert pusher and Telegram digest/exclusive hooks are
// runScoring's concern; we do NOT plumb them through this layer.

import cron, { type ScheduledTask } from 'node-cron';
import type { Sql } from 'postgres';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { createLogger, type Logger } from '../lib/logger.js';
import { withRunLock } from '../orchestrator/lock.js';
import {
  runScoring as defaultRunScoring,
  type RunKind,
  type RunOptions,
  type RunResult,
} from '../orchestrator/run.js';

/** Subset of cron.schedule's signature we actually call. Lets tests pass a
 *  spy without dragging in the full node-cron typing surface. */
export type ScheduleFn = (
  cronExpression: string,
  func: () => void,
  options?: { scheduled?: boolean; timezone?: string },
) => ScheduledTask;

export interface OrchestratorCronDependencies {
  /** Inject a stub in tests; defaults to the real runScoring import. */
  runScoring?: (
    db: Db,
    opts: RunOptions,
  ) => Promise<RunResult>;
  /** Inject a spy in tests to assert pattern + timezone + callback wiring
   *  without registering a real cron. Defaults to node-cron's `schedule`. */
  scheduleFn?: ScheduleFn;
  /** Bound-injected logger; defaults to the module logger. */
  logger?: Logger;
  /**
   * Issue #122: called BEFORE the runScoring promise starts and AFTER
   * it settles. The "before" call covers long-running runs (5-30 min)
   * that exceed `progressStaleMs` — the heartbeat would otherwise
   * stall mid-run despite work actively happening. Both ends signal
   * because withRunLock can also reject the lock acquisition (skip),
   * and we want that path to mark progress too.
   */
  onTick?: () => void;
}

export interface OrchestratorCronHandle {
  morning: ScheduledTask;
  afternoon: ScheduledTask;
  stop: () => void;
}

/**
 * Register morning + afternoon orchestrator cron tasks. Returns a handle
 * whose `.stop()` cancels both — wire that into the worker's SIGTERM/SIGINT
 * shutdown so the ticks stop firing before the DB connection closes.
 *
 * Both tasks call runScoring(db, { kind }) with their respective kind. A
 * throw inside runScoring is logged and swallowed — runScoring has already
 * flipped its runs row to status='failed' and stored the error, so the
 * cron layer's only remaining responsibility is to keep the schedule alive
 * for the next tick. We deliberately do NOT crash the host process.
 */
export function startOrchestratorCron(
  db: Db,
  raw: Sql,
  deps: OrchestratorCronDependencies = {},
): OrchestratorCronHandle {
  const runScoring = deps.runScoring ?? defaultRunScoring;
  const schedule = deps.scheduleFn ?? cron.schedule;
  const log = deps.logger ?? createLogger('orchestrator-cron');
  const onTick = deps.onTick;
  const timezone = env.orchestratorTimezone();

  const register = (pattern: string, kind: RunKind): ScheduledTask =>
    schedule(
      pattern,
      () => {
        // Issue #122: mark progress BEFORE withRunLock starts. A real
        // orchestrator run can take 5-30 min — longer than the default
        // progressStaleMs (120s) — so the cron firing IS the "I'm alive"
        // signal for this scheduler. Inside-run progress comes from the
        // sibling scheduler cron (`scheduler/cron.ts`) which fires every
        // minute on the same process. Marking again on settle below is
        // belt-and-braces for the lock-skipped path.
        onTick?.();
        // withRunLock wraps the entire run in pg_try_advisory_lock on a
        // reserved connection. If another tick / MCP run_now is already
        // mid-flight, the lock acquire fails and the work callback
        // doesn't run — we log + skip + keep the cron alive for the
        // next slot. No runs row is inserted on the skipped path
        // because runScoring (which owns the INSERT) never runs.
        withRunLock(raw, () => runScoring(db, { kind }))
          .then((outcome) => {
            if (!outcome.acquired) {
              log.warn('orchestrator cron tick skipped: lock held by another run', {
                kind,
              });
              return;
            }
            const result = outcome.result;
            log.info('orchestrator run complete', {
              kind,
              run_id: result.runId,
              status: result.status,
              candidates_persisted: result.candidatesPersisted,
              total_cost_usd: result.totalCostUsd,
              error: result.error,
            });
          })
          .catch((err: unknown) => {
            // runScoring writes its own failure record to the runs row;
            // we just keep the cron alive. Swallowing here prevents an
            // unhandled rejection from killing the worker process and
            // taking the next tick down with it.
            log.error('orchestrator cron tick threw', {
              kind,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            // Settled signal — covers a fast-completing run + the lock-
            // skipped path. The pre-call above covers long-running runs.
            onTick?.();
          });
      },
      {
        timezone,
      },
    );

  const morning = register(env.orchestratorMorningCron(), 'morning');
  const afternoon = register(env.orchestratorAfternoonCron(), 'afternoon');

  return {
    morning,
    afternoon,
    stop: () => {
      morning.stop();
      afternoon.stop();
    },
  };
}
