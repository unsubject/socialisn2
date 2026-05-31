// Pure helpers + cron registration for the continuous Phase 2 worker.
//
// Split out of src/workers/scoring.ts so the test suite can import
// `tickOnce` / `compactOnce` without triggering the boot path (which
// opens DB connections + registers crons + installs SIGTERM handlers).
//
// The entry point (src/workers/scoring.ts) imports `startCrons` from here
// and adds the SIG handlers. This mirrors the way src/scheduler/cron.ts
// exports `startScheduler` and src/workers/ingestion.ts calls it.

import cron, { type ScheduledTask } from 'node-cron';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { env } from '../config/env.js';
import { compactClusters } from '../scoring/cluster.js';
import {
  processRawItem,
  type PendingRawItem,
  type ProcessDependencies,
} from '../scoring/process-raw-item.js';

export interface TickOptions {
  batchSize: number;
  maxAttempts: number;
  /** Override processRawItem deps — tests stub the LLM + embed + dedup. */
  deps?: ProcessDependencies;
}

export interface TickStats {
  /** Rows pulled from the pending queue this tick. */
  pulled: number;
  /** Successfully processed via the normal items-insert path. */
  normalProcessed: number;
  /** Successfully processed via the SPEC §7.2 step 2 dedup-hit path. */
  dedupProcessed: number;
  /** Per-item processing failures. attempts counter has been bumped. */
  failures: number;
  /** Whether the batch short-circuited because the cost ceiling was hit. */
  ceilingHit: boolean;
  /** Sum of LLM + embed cost recorded this tick. */
  costUsd: number;
}

/**
 * Run one tick of the polling loop. Exported (mirroring scheduler.ts) so
 * tests can drive it deterministically without spinning the cron.
 *
 * Cost-ceiling handling: if `processRawItem` returns `ceiling_hit` for any
 * row, this function STOPS pulling additional rows from the batch — the
 * remaining items will be picked up by the next tick after the daily ledger
 * reset (or after manual intervention). The pulled rows that hadn't been
 * touched yet are NOT marked failed; their attempts counter stays put.
 */
export async function tickOnce(db: Db, opts: TickOptions): Promise<TickStats> {
  const stats: TickStats = {
    pulled: 0,
    normalProcessed: 0,
    dedupProcessed: 0,
    failures: 0,
    ceilingHit: false,
    costUsd: 0,
  };

  const batch = await loadBatch(db, opts.batchSize, opts.maxAttempts);
  stats.pulled = batch.length;
  if (batch.length === 0) return stats;

  for (const row of batch) {
    const outcome = await processRawItem(db, row, opts.deps);
    switch (outcome.kind) {
      case 'normal':
        stats.normalProcessed += 1;
        stats.costUsd += outcome.costUsd;
        break;
      case 'dedup_hit':
        stats.dedupProcessed += 1;
        stats.costUsd += outcome.costUsd;
        break;
      case 'failed':
        stats.failures += 1;
        // Failure already stamped in raw_meta + attempts. Log here so
        // ops can grep. Don't print the row's content — could be long.
        console.error(
          `[scoring-worker] raw_item ${row.id} failed: ${outcome.error.message}`,
        );
        break;
      case 'ceiling_hit':
        // Hard stop — daily ledger reset is the only thing that unwinds
        // this. Remaining batch is untouched and will be re-pulled at
        // the next eligible tick.
        stats.ceilingHit = true;
        return stats;
    }
  }

  return stats;
}

/**
 * Daily compaction wrapper — currently a thin pass-through to
 * `compactClusters` so we can swap default opts in one place if the cadence
 * or threshold needs deployment-time tuning. Exported for tests.
 */
export async function compactOnce(db: Db): Promise<{ merges: number }> {
  const result = await compactClusters(db);
  return { merges: result.merges };
}

// ---------------------------------------------------------------------------
// cron wiring
// ---------------------------------------------------------------------------

type PendingRawItemRow = {
  id: string;
  title: string;
  content: string | null;
  language: string | null;
  published_at: string;
};

async function loadBatch(
  db: Db,
  batchSize: number,
  maxAttempts: number,
): Promise<PendingRawItem[]> {
  // ORDER BY fetched_at ASC = FIFO across sources, so a fast publisher
  // doesn't starve slower ones. processing_attempts cap turns poison rows
  // into a noisy SELECT (still visible) rather than an infinite retry loop.
  // No FOR UPDATE SKIP LOCKED here — v1 runs a single worker process.
  // Multi-worker safety comes from the UNIQUE(items.raw_item_id) constraint
  // (migration 011): a racing second insert fails cleanly via constraint
  // violation rather than producing a duplicate items row.
  const rows = await db.execute<PendingRawItemRow>(sql`
    SELECT id, title, content, language, published_at
    FROM raw_items
    WHERE processed_at IS NULL
      AND processing_attempts < ${maxAttempts}
    ORDER BY fetched_at ASC
    LIMIT ${batchSize}
  `);
  // `db.execute<T>` does not run pg type parsers — timestamptz comes
  // back as an ISO string. Wrap with `new Date(...)` so callers get a
  // typed Date object as the field claims.
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    language: r.language,
    publishedAt: new Date(r.published_at),
  }));
}

export interface WorkerHandles {
  tickTask: ScheduledTask;
  compactionTask: ScheduledTask;
  /** Awaits whatever job is currently in flight. Used by shutdown. */
  drain: () => Promise<void>;
}

/**
 * Register both crons against the shared DB handle. The caller installs
 * SIG handlers and awaits `drain()` on shutdown. Splitting boot vs cron
 * registration keeps tests free of `process` global mutation.
 */
export function startCrons(db: Db): WorkerHandles {
  const batchSize = env.scoringWorkerBatchSize();
  const maxAttempts = env.scoringWorkerMaxAttempts();
  // Both crons append onto the same in-flight chain so shutdown can await
  // a single promise. Compaction won't kick in mid-tick; a tick won't
  // overlap a long-running compaction.
  //
  // Audit C-P1-1: skip-if-busy guard. Pre-audit, every cron fire
  // appended a `.then(...)` node to `inFlight` unconditionally. Tick
  // default is '* * * * *' (every minute); when a tick takes >60s
  // (LLM 5xx retries, embedding slowdown, large backlog), the next
  // cron fire still chains. The chain grows unboundedly — memory
  // leak AND work backlog that falls progressively further behind
  // real time. Skip if there's already a queued job: the in-flight
  // tick will resume picking up where it left off on the NEXT real
  // cron fire after it settles. Compaction is allowed to queue (it's
  // once-a-day, can't pile up).
  let inFlight: Promise<void> = Promise.resolve();
  let chainDepth = 0;
  /**
   * @param allowQueueing - when true (compaction), append even if a
   *   tick is in flight. When false (tick), skip if anything is
   *   already running so we don't pile up under slow upstreams.
   */
  const chain = (job: () => Promise<unknown>, allowQueueing: boolean): void => {
    if (!allowQueueing && chainDepth > 0) {
      console.warn(
        `[scoring-worker] tick skipped: previous job still in flight (chainDepth=${chainDepth})`,
      );
      return;
    }
    chainDepth += 1;
    inFlight = inFlight.then(async () => {
      try {
        await job();
      } catch (err) {
        console.error('[scoring-worker] chained job failed:', err);
      } finally {
        chainDepth -= 1;
      }
    });
  };

  const tickTask = cron.schedule(env.scoringWorkerTickCron(), () => {
    // Pass allowQueueing=false: skip if previous tick still running.
    chain(async () => {
      const stats = await tickOnce(db, { batchSize, maxAttempts });
      // Quiet ticks (nothing pulled) don't log — avoids minute-by-minute
      // noise in journalctl. Anything with work or a halt does log.
      if (stats.pulled > 0 || stats.failures > 0 || stats.ceilingHit) {
        console.log(
          `[scoring-worker] tick pulled=${stats.pulled} normal=${stats.normalProcessed} dedup=${stats.dedupProcessed} failed=${stats.failures} cost=$${stats.costUsd.toFixed(6)}${stats.ceilingHit ? ' CEILING_HIT' : ''}`,
        );
      }
    }, false);
  });

  const compactionTask = cron.schedule(
    env.scoringWorkerCompactionCron(),
    () => {
      // Pass allowQueueing=true: compaction is once-a-day; the operator
      // would rather have it queue behind a slow tick than skip outright.
      chain(async () => {
        const result = await compactOnce(db);
        console.log(`[scoring-worker] compaction merges=${result.merges}`);
      }, true);
    },
  );

  return {
    tickTask,
    compactionTask,
    drain: () => inFlight,
  };
}
