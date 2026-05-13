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
import { type DueSource, loadDueSources } from '../ingestion/source-loader.js';
import type { IngestionJobData } from '../queue/ingestion-queue.js';
import type { Queue } from 'bullmq';

// Phase 1 PR 1 only enqueues `rss` sources. PR 2 widens this to arxiv,
// youtube_channel, email_bridge; PR 3 adds gdelt (which is on-demand, not
// cron-driven, so it'll be enqueued from elsewhere).
const ENQUEUED_KINDS: ReadonlyArray<DueSource['kind']> = ['rss'];

export interface SchedulerHandle {
  task: ScheduledTask;
  tickOnce: () => Promise<number>; // returns # enqueued; exported for tests
  stop: () => void;
}

export function startScheduler(
  db: Db,
  queue: Queue<IngestionJobData>,
): SchedulerHandle {
  const tickOnce = async (): Promise<number> => {
    const due = await loadDueSources(db, ENQUEUED_KINDS);
    if (due.length === 0) return 0;
    await queue.addBulk(
      due.map((s) => ({
        name: `fetch:${s.kind}`,
        data: { sourceId: s.id, kind: s.kind },
        // jobId per source per minute prevents the same source being enqueued
        // twice if a tick overlaps a slow previous tick.
        opts: { jobId: `${s.id}:${Math.floor(Date.now() / 60_000)}` },
      })),
    );
    return due.length;
  };

  const task = cron.schedule(
    env.schedulerTickCron(),
    () => {
      tickOnce().catch((err: unknown) => {
        console.error('[scheduler] tick failed', err);
      });
    },
    { scheduled: true },
  );

  return {
    task,
    tickOnce,
    stop: () => task.stop(),
  };
}
