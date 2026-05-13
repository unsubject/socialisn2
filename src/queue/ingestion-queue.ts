// BullMQ queue + job-data type for the ingestion pipeline. The scheduler
// produces jobs; the ingestion-worker consumes them. The shape is kept thin —
// jobs carry only the source id; the worker re-reads the source row to get
// current url/kind/etc, which keeps cron-enqueued jobs idempotent across
// source-config edits.

import { Queue, type ConnectionOptions } from 'bullmq';

export const INGESTION_QUEUE = 'socialisn2:ingestion';

export interface IngestionJobData {
  sourceId: string;
  // Carried for logging only — the worker re-queries the row.
  kind: 'rss' | 'youtube_channel' | 'arxiv' | 'email_bridge';
}

export function createIngestionQueue(connection: ConnectionOptions): Queue<IngestionJobData> {
  return new Queue<IngestionJobData>(INGESTION_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      // Keep the last 1k successes for visibility; drop the rest. Failed jobs
      // are kept indefinitely until the operator inspects + clears.
      removeOnComplete: { count: 1_000 },
      removeOnFail: false,
    },
  });
}
