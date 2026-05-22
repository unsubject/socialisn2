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
import { fetchAndParseRss } from '../ingestion/rss.js';
import { markSourceFetched } from '../ingestion/source-loader.js';
import type { RawItemInput } from '../ingestion/types.js';
import { writeRawItems } from '../ingestion/writer.js';
import { fetchAndParseYouTube } from '../ingestion/youtube.js';
import { createRedis } from '../queue/connection.js';
import {
  INGESTION_QUEUE,
  createIngestionQueue,
  type IngestionJobData,
} from '../queue/ingestion-queue.js';
import { startScheduler } from '../scheduler/cron.js';
import { startRecalibrationCron } from '../scheduler/recalibrate.js';

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
    const items = await fetchForSource(row.kind, row.url);
    const result = await writeRawItems(db, row.id, items);
    await markSourceFetched(db, row.id, `ok:${result.insertedCount}/${result.fetched}`);
    console.log(
      `[ingestion-worker] ${row.kind} ${row.name} fetched=${result.fetched} inserted=${result.insertedCount} dup=${result.duplicateCount}`,
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
  const { db, close } = createDb();
  const queue = createIngestionQueue(connection);

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

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[ingestion-worker] ${signal} received; shutting down`);
    scheduler.stop();
    recalibrationCron.stop();
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
