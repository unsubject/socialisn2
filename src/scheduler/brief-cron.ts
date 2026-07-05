// Weekly-brief cron (redesign P1) — fires runWeeklyBrief at the Sunday
// slot (env WEEKLY_BRIEF_CRON, default '0 18 * * 0', pinned to
// env.orchestratorTimezone() for the same host-TZ-independence rationale
// as orchestrator-cron.ts).
//
// No advisory lock: the job is weekly, idempotent per week_of (the
// briefs upsert), and never overlaps the twice-daily scoring runs'
// cluster iteration — a concurrent scoring run only shares the read
// path. A throw inside runWeeklyBrief is logged and SWALLOWED; the run
// row (kind='brief') carries the durable failure record and the next
// Sunday retries.

import cron, { type ScheduledTask } from 'node-cron';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { createLogger, type Logger } from '../lib/logger.js';
import {
  runWeeklyBrief as defaultRunWeeklyBrief,
  type BriefRunOptions,
  type BriefRunResult,
} from '../orchestrator/brief.js';
import type { ScheduleFn } from './orchestrator-cron.js';

export interface BriefCronDependencies {
  runWeeklyBrief?: (db: Db, opts?: BriefRunOptions) => Promise<BriefRunResult>;
  scheduleFn?: ScheduleFn;
  logger?: Logger;
  /** Heartbeat hook — same before/after contract as orchestrator-cron. */
  onTick?: () => void;
}

export interface BriefCronHandle {
  task: ScheduledTask;
  stop: () => void;
}

export function startBriefCron(
  db: Db,
  deps: BriefCronDependencies = {},
): BriefCronHandle {
  const runWeeklyBrief = deps.runWeeklyBrief ?? defaultRunWeeklyBrief;
  const schedule = deps.scheduleFn ?? cron.schedule;
  const log = deps.logger ?? createLogger('brief-cron');
  const onTick = deps.onTick;

  const task = schedule(
    env.weeklyBriefCron(),
    () => {
      onTick?.();
      runWeeklyBrief(db)
        .then((result) => {
          log.info('weekly brief run complete', {
            run_id: result.runId,
            brief_id: result.briefId,
            week_of: result.weekOf,
            pitch_count: result.pitchCount,
            total_cost_usd: result.totalCostUsd,
            status: result.status,
            error: result.error,
          });
        })
        .catch((err: unknown) => {
          log.error('weekly brief cron tick threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          onTick?.();
        });
    },
    { timezone: env.orchestratorTimezone() },
  );

  return { task, stop: () => task.stop() };
}
