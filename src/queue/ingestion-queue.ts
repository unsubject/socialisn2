// BullMQ queue + job-data type for the ingestion pipeline. The scheduler
// produces jobs; the ingestion-worker consumes them. The shape is kept thin —
// jobs carry only the identifier of the row to fetch; the worker re-reads
// the row to get current url / kind / enabled state, which keeps cron-
// enqueued jobs idempotent across config edits between enqueue and pickup.
//
// `target` discriminates the two parallel ingestion paths:
//   - `source` jobs (kind in rss / arxiv / email_bridge) write raw_items
//   - `competitor` jobs (youtube in v1) write competitor_videos

import { Queue, type ConnectionOptions } from 'bullmq';

// BullMQ 5.x rejects queue names containing `:` (reserved for the Redis
// key-prefix separator that BullMQ generates internally as `bull:<name>:*`).
// Earlier versions silently accepted colons. Keep this name `:`-free.
export const INGESTION_QUEUE = 'socialisn2-ingestion';

export type IngestionJobData =
  | { target: 'source'; sourceId: string; kind: 'rss' | 'arxiv' | 'email_bridge' }
  | { target: 'competitor'; competitorId: string; platform: 'youtube' };

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
