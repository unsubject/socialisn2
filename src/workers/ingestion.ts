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
import { sources } from '../db/schema.js';
import { env } from '../config/env.js';
import { fetchAndParseRss } from '../ingestion/rss.js';
import { markSourceFetched } from '../ingestion/source-loader.js';
import { writeRawItems } from '../ingestion/writer.js';
import { createRedis } from '../queue/connection.js';
import {
  INGESTION_QUEUE,
  createIngestionQueue,
  type IngestionJobData,
} from '../queue/ingestion-queue.js';
import { startScheduler } from '../scheduler/cron.js';

async function processJob(db: Db, job: Job<IngestionJobData>): Promise<void> {
  const [row] = await db
    .select({
      id: sources.id,
      kind: sources.kind,
      url: sources.url,
      name: sources.name,
      enabled: sources.enabled,
    })
    .from(sources)
    .where(eq(sources.id, job.data.sourceId))
    .limit(1);
  if (!row) {
    console.warn(`[ingestion-worker] source ${job.data.sourceId} not found; skipping`);
    return;
  }
  if (!row.enabled) {
    console.log(`[ingestion-worker] source ${row.name} disabled; skipping`);
    return;
  }

  if (row.kind !== 'rss') {
    // PR 2 wires arxiv / youtube / email_bridge adapters here.
    console.warn(
      `[ingestion-worker] source kind ${row.kind} not yet handled (Phase 1 PR 1); skipping`,
    );
    return;
  }

  try {
    const items = await fetchAndParseRss(row.url);
    const result = await writeRawItems(db, row.id, items);
    await markSourceFetched(db, row.id, `ok:${result.insertedCount}/${result.fetched}`);
    console.log(
      `[ingestion-worker] ${row.name} fetched=${result.fetched} inserted=${result.insertedCount} dup=${result.duplicateCount}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSourceFetched(db, row.id, `err:${msg.slice(0, 240)}`);
    throw err;
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

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[ingestion-worker] ${signal} received; shutting down`);
    scheduler.stop();
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
