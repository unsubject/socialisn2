// node-cron scheduler. Wakes on the configured tick (default every minute),
// finds sources whose fetch_interval_min has elapsed since last_fetched_at,
// and enqueues one job per due source.
//
// The scheduler only enqueues; the BullMQ ingestion-worker (src/workers/
// ingestion.ts) consumes. Decoupling the two means cron failures can't lose
// in-flight fetches and worker outages don't drop scheduling decisions.

import cron, { type ScheduledTask } from 'node-cron';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { loadDueCompetitors } from '../ingestion/competitor-loader.js';
import { type DueSource, loadDueSources } from '../ingestion/source-loader.js';
import type { IngestionJobData } from '../queue/ingestion-queue.js';
import type { JobsOptions, Queue } from 'bullmq';

// PR 1 only enqueued `rss`; PR 2 widens to arxiv + email_bridge for sources
// and adds the parallel competitor path (youtube only in v1 per SPEC §6.7).
// PR 3 will add gdelt — that's on-demand per cluster, not cron-driven, so
// it'll be enqueued from elsewhere.
const ENQUEUED_SOURCE_KINDS: ReadonlyArray<DueSource['kind']> = [
  'rss',
  'arxiv',
  'email_bridge',
];

export interface SchedulerHandle {
  task: ScheduledTask;
  tickOnce: () => Promise<number>; // returns # enqueued; exported for tests
  stop: () => void;
}

export interface StartSchedulerOptions {
  /**
   * Issue #122: called at the end of every cron tick (success OR
   * thrown). The ingestion-worker wires this to the heartbeat's
   * `markProgress()` so a wedged tickOnce body (hung loadDueSources,
   * hung BullMQ addBulk on a dead Redis) eventually stops touching the
   * heartbeat → docker healthcheck → restart.
   */
  onTick?: () => void;
}

export function startScheduler(
  db: Db,
  queue: Queue<IngestionJobData>,
  opts: StartSchedulerOptions = {},
): SchedulerHandle {
  const onTick = opts.onTick;
  const tickOnce = async (): Promise<number> => {
    const [dueSources, dueCompetitors] = await Promise.all([
      loadDueSources(db, ENQUEUED_SOURCE_KINDS),
      loadDueCompetitors(db),
    ]);

    const minuteBucket = Math.floor(Date.now() / 60_000);
    const sourceJobs = dueSources
      .filter((s): s is DueSource & { kind: 'rss' | 'arxiv' | 'email_bridge' } =>
        s.kind === 'rss' || s.kind === 'arxiv' || s.kind === 'email_bridge',
      )
      .map((s) => ({
        name: `fetch:source:${s.kind}`,
        data: {
          target: 'source' as const,
          sourceId: s.id,
          kind: s.kind,
        } satisfies IngestionJobData,
        opts: { jobId: `src:${s.id}:${minuteBucket}` } satisfies JobsOptions,
      }));

    const competitorJobs = dueCompetitors.map((c) => ({
      name: `fetch:competitor:${c.platform}`,
      data: {
        target: 'competitor' as const,
        competitorId: c.id,
        platform: c.platform,
      } satisfies IngestionJobData,
      opts: { jobId: `cmp:${c.id}:${minuteBucket}` } satisfies JobsOptions,
    }));

    const allJobs = [...sourceJobs, ...competitorJobs];
    if (allJobs.length === 0) return 0;
    await queue.addBulk(allJobs);
    return allJobs.length;
  };

  const task = cron.schedule(
    env.schedulerTickCron(),
    () => {
      tickOnce()
        .catch((err: unknown) => {
          console.error('[scheduler] tick failed', err);
        })
        .finally(() => {
          // Issue #122: progress signal fires even on a throw — a
          // failing tick is still the cron wheel turning. What we're
          // gating against is a tickOnce body that never settles.
          onTick?.();
        });
    },
    {},
  );

  return {
    task,
    tickOnce,
    stop: () => task.stop(),
  };
}
