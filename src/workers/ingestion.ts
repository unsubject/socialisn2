// Ingestion worker entry. Boots:
//   - BullMQ Worker that consumes the ingestion queue and runs the adapter
//     for each due source, writes results to raw_items.
//   - node-cron scheduler that enqueues fetches by source cadence.
//
// One process runs both — they share the Redis connection and DB handle. The
// docker-compose `ingestion-worker` service entry runs this file. Phase 5 may
// split scheduler and worker into separate processes if scaling demands it.

import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';

import { createDb, type Db } from '../db/client.js';
import { competitors, sources } from '../db/schema.js';
import { env } from '../config/env.js';
import { fetchAndParseArxiv } from '../ingestion/arxiv.js';
import {
  markCompetitorFetched,
  writeCompetitorVideos,
} from '../ingestion/competitor-writer.js';
import { fetchAndParseEmailBridge } from '../ingestion/email-bridge.js';
import { filterHnIngestion } from '../ingestion/hn-filter.js';
import { fetchAndParseRss } from '../ingestion/rss.js';
import { markSourceFetched } from '../ingestion/source-loader.js';
import type { RawItemInput } from '../ingestion/types.js';
import { writeRawItems } from '../ingestion/writer.js';
import { fetchAndParseYouTube } from '../ingestion/youtube.js';
import { startHeartbeat } from '../lib/worker-heartbeat.js';
import { createRedis } from '../queue/connection.js';
import {
  INGESTION_QUEUE,
  createIngestionQueue,
  type IngestionJobData,
} from '../queue/ingestion-queue.js';
import { startScheduler } from '../scheduler/cron.js';
import { startOrchestratorCron } from '../scheduler/orchestrator-cron.js';
import { startRecalibrationCron } from '../scheduler/recalibrate.js';
import {
  reapOrphanedRunsOnBoot,
  startStuckRunsWatchdog,
} from '../scheduler/stuck-runs-watchdog.js';

type SourceJob = Extract<IngestionJobData, { target: 'source' }>;
type CompetitorJob = Extract<IngestionJobData, { target: 'competitor' }>;

async function fetchForSource(
  kind: SourceJob['kind'],
  url: string,
): Promise<RawItemInput[]> {
  switch (kind) {
    case 'rss':
      return fetchAndParseRss(url);
    case 'arxiv':
      return fetchAndParseArxiv(url);
    case 'email_bridge':
      return fetchAndParseEmailBridge(url);
  }
}

async function processSourceJob(db: Db, data: SourceJob): Promise<void> {
  const [row] = await db
    .select({
      id: sources.id,
      kind: sources.kind,
      url: sources.url,
      name: sources.name,
      enabled: sources.enabled,
    })
    .from(sources)
    .where(eq(sources.id, data.sourceId))
    .limit(1);
  if (!row) {
    console.warn(`[ingestion-worker] source ${data.sourceId} not found; skipping`);
    return;
  }
  if (!row.enabled) {
    console.log(`[ingestion-worker] source ${row.name} disabled; skipping`);
    return;
  }
  if (row.kind !== 'rss' && row.kind !== 'arxiv' && row.kind !== 'email_bridge') {
    console.warn(
      `[ingestion-worker] source kind ${row.kind} not yet handled (skipping)`,
    );
    return;
  }

  try {
    const fetchedItems = await fetchForSource(row.kind, row.url);
    // SPEC §6.3 / migration 010 follow-up: hnrss feeds get a domain
    // whitelist post-filter; every other source passes through unchanged.
    // `filterHnIngestion` is a no-op for non-HN sources.
    const { kept: items, droppedCount } = filterHnIngestion(row.url, fetchedItems);
    const result = await writeRawItems(db, row.id, items);
    await markSourceFetched(db, row.id, `ok:${result.insertedCount}/${result.fetched}`);
    const filterTag = droppedCount > 0 ? ` whitelist_dropped=${droppedCount}` : '';
    console.log(
      `[ingestion-worker] ${row.kind} ${row.name} fetched=${fetchedItems.length} inserted=${result.insertedCount} dup=${result.duplicateCount}${filterTag}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSourceFetched(db, row.id, `err:${msg.slice(0, 240)}`);
    throw err;
  }
}

async function processCompetitorJob(db: Db, data: CompetitorJob): Promise<void> {
  const [row] = await db
    .select({
      id: competitors.id,
      platform: competitors.platform,
      externalId: competitors.externalId,
      name: competitors.name,
      enabled: competitors.enabled,
    })
    .from(competitors)
    .where(eq(competitors.id, data.competitorId))
    .limit(1);
  if (!row) {
    console.warn(`[ingestion-worker] competitor ${data.competitorId} not found; skipping`);
    return;
  }
  if (!row.enabled) {
    console.log(`[ingestion-worker] competitor ${row.name} disabled; skipping`);
    return;
  }
  if (row.platform !== 'youtube') {
    console.warn(
      `[ingestion-worker] competitor platform ${row.platform} not yet handled (skipping)`,
    );
    return;
  }

  try {
    const videos = await fetchAndParseYouTube(row.externalId);
    const result = await writeCompetitorVideos(db, row.id, videos);
    const newest = videos.reduce<Date | null>(
      (acc, v) => (acc === null || v.publishedAt > acc ? v.publishedAt : acc),
      null,
    );
    await markCompetitorFetched(db, row.id, {
      status: `ok:${result.insertedCount}/${result.fetched}`,
      newestVideoAt: newest,
    });
    console.log(
      `[ingestion-worker] youtube ${row.name} fetched=${result.fetched} inserted=${result.insertedCount} dup=${result.duplicateCount}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Always stamp last_fetched_at, even on failure — otherwise a
    // perpetually-failing channel keeps re-enqueuing on every tick.
    await markCompetitorFetched(db, row.id, {
      status: `err:${msg.slice(0, 240)}`,
      newestVideoAt: null,
    });
    throw err;
  }
}

async function processJob(db: Db, job: Job<IngestionJobData>): Promise<void> {
  if (job.data.target === 'source') {
    await processSourceJob(db, job.data);
  } else {
    await processCompetitorJob(db, job.data);
  }
}

async function main(): Promise<void> {
  const connection = createRedis();
  const { db, raw, close } = createDb();
  const queue = createIngestionQueue(connection);

  // Phase 2.c: start the heartbeat FIRST, before any DB work that
  // could hang. Reviewer flagged that boot reaper / Redis-connect /
  // scheduler-register can all stall on a first deploy (unmigrated
  // DB, network blip, etc.). Without an early heartbeat the
  // start_period=60s elapses with no file → healthcheck CLI sees
  // ENOENT → container marked unhealthy → and since `restart:
  // unless-stopped` doesn't recover on health transitions, the
  // container is stuck. By touching the heartbeat before any awaits,
  // we guarantee the file exists from t=0, and the autoheal sidecar
  // can later recover from a stale file.
  const heartbeat = startHeartbeat('ingestion');

  // Phase 2.b: boot-time orphan-runs reaper, relocated from
  // src/index.ts where it used to incorrectly nuke runs the
  // ingestion-worker process was actively running. The ingestion
  // worker is the only process that fires orchestrator runs on cron
  // tick, so a restart of THIS process is the actual orphan-creating
  // event. Runs before scheduler/orchestrator-cron come up so a stale
  // 'running' row can't survive into the next tick.
  //
  // Wrapped in a timeout so a hung reaper (unmigrated DB on first
  // deploy, lock contention, network blip) can't gate the schedulers.
  // 30s is comfortably above a real reaper SQL roundtrip; the watchdog
  // cron will catch any stuck rows on its next tick even if this
  // timeout fires.
  try {
    const reaperPromise = reapOrphanedRunsOnBoot(db);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('boot reaper timed out after 30s')),
        30_000,
      );
      t.unref();
    });
    const { reaped } = await Promise.race([reaperPromise, timeoutPromise]);
    if (reaped > 0) {
      console.log(`[ingestion-worker] reaped ${reaped} orphaned run(s) at boot`);
    }
  } catch (err) {
    // Don't crash boot on reaper failure — the watchdog cron will
    // catch any stuck rows on its next tick.
    console.error('[ingestion-worker] boot reaper failed (continuing):', err);
  }

  const worker = new Worker<IngestionJobData>(
    INGESTION_QUEUE,
    (job) => processJob(db, job),
    {
      connection,
      concurrency: env.ingestionConcurrency(),
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[ingestion-worker] job ${job?.id} failed:`, err);
  });

  const scheduler = startScheduler(db, queue);
  // ADR-013: daily 04:00 UTC Bayesian recalibration of source authority.
  // Lives on the ingestion worker process for two reasons: (1) it needs
  // the same DB handle as the scheduler, (2) the scoring worker already
  // owns the compaction cron — keeping recalibration here colocates it
  // with the schedule-only side, not the compute-heavy side.
  const recalibrationCron = startRecalibrationCron(db);
  // SPEC §9: twice-daily morning (05:00 ET) + afternoon (14:00 ET)
  // orchestrator runs. Same rationale for colocation — shares the DB
  // handle and the cron-host process with the schedulers above. The
  // run itself dispatches to the scoring stack (Stages 3-7); this layer
  // only handles the schedule. `raw` flows through to the lock layer
  // (src/orchestrator/lock.ts) so a tick that races a concurrent run
  // (the other tick or an MCP run_now) skips cleanly instead of
  // double-spending the cost ceiling on the same clusters.
  const orchestratorCron = startOrchestratorCron(db, raw);
  // Phase 2.b: stuck-runs watchdog. Every 5 min, fails any
  // runs.status='running' older than 90 min — catches the case where a
  // process is SIGKILL'd between runs.INSERT and the runScoring try
  // block, OR where some future change reorders the finalise path.
  // Complements (does not replace) the boot reaper above.
  const stuckRunsWatchdog = startStuckRunsWatchdog(db);
  // (heartbeat is started at the top of main() before any awaits —
  // see comment there.)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[ingestion-worker] ${signal} received; shutting down`);
    heartbeat.stop();
    scheduler.stop();
    recalibrationCron.stop();
    orchestratorCron.stop();
    stuckRunsWatchdog.stop();
    await worker.close();
    await queue.close();
    await connection.quit();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[ingestion-worker] started');
}

main().catch((err: unknown) => {
  console.error('[ingestion-worker] fatal:', err);
  process.exit(1);
});
