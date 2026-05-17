// Continuous Phase 2 worker entry. Boots two crons that share one DB
// handle:
//
//   - Tick cron  (default `* * * * *`) — pulls a batch of pending
//     raw_items and runs `processRawItem` on each. SPEC §7.2 + §7.3 +
//     §7.4 normalise → embed → dedup → cluster pipeline lives in
//     src/scoring/process-raw-item.ts; this file is the polling glue.
//
//   - Compaction cron (default `0 4 * * *`, daily 04:00 UTC) — runs
//     `compactClusters` across all domains, the unwired half of
//     SPEC §7.4 step 4. Lands at 04:00 UTC so it has ~5-6h slack
//     before the 05:00 ET (~09:00-10:00 UTC) orchestrator run.
//
// One process runs both. The docker-compose `scoring-worker` service
// entry runs this file. The Phase 5 deploy script (out of scope for
// this PR) is what brings it up on the VPS.
//
// Tick cadence rationale: per-item cost is ~$0.0006 (normalise) +
// ~$0.00002 (embed). At BATCH_SIZE=20 and TICK=1min, the worst-case
// per-minute spend is ~$0.012 — well inside the default
// $1.50/day ceiling. The cost-ceiling gate (in processRawItem itself)
// is what enforces the daily cap; the tick budget here is just
// throughput.

import cron, { type ScheduledTask } from 'node-cron';
import { sql } from 'drizzle-orm';

import { createDb, type Db } from '../db/client.js';
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
// boot
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

interface WorkerHandles {
  tickTask: ScheduledTask;
  compactionTask: ScheduledTask;
  inFlight: () => Promise<void>;
}

function startCrons(db: Db): WorkerHandles {
  const batchSize = env.scoringWorkerBatchSize();
  const maxAttempts = env.scoringWorkerMaxAttempts();
  // Both crons append onto the same in-flight chain so shutdown can await
  // a single promise. Compaction won't kick in mid-tick; a tick won't
  // overlap a long-running compaction.
  let inFlight: Promise<void> = Promise.resolve();
  const chain = (job: () => Promise<unknown>) => {
    inFlight = inFlight.then(async () => {
      try {
        await job();
      } catch (err) {
        console.error('[scoring-worker] chained job failed:', err);
      }
    });
  };

  const tickTask = cron.schedule(env.scoringWorkerTickCron(), () => {
    chain(async () => {
      const stats = await tickOnce(db, { batchSize, maxAttempts });
      // Quiet ticks (nothing pulled) don't log — avoids minute-by-minute
      // noise in journalctl. Anything with work or a halt does log.
      if (
        stats.pulled > 0 ||
        stats.failures > 0 ||
        stats.ceilingHit
      ) {
        console.log(
          `[scoring-worker] tick pulled=${stats.pulled} normal=${stats.normalProcessed} dedup=${stats.dedupProcessed} failed=${stats.failures} cost=$${stats.costUsd.toFixed(6)}${stats.ceilingHit ? ' CEILING_HIT' : ''}`,
        );
      }
    });
  });

  const compactionTask = cron.schedule(
    env.scoringWorkerCompactionCron(),
    () => {
      chain(async () => {
        const result = await compactOnce(db);
        console.log(`[scoring-worker] compaction merges=${result.merges}`);
      });
    },
  );

  return { tickTask, compactionTask, inFlight: () => inFlight };
}

async function main(): Promise<void> {
  const { db, close } = createDb();
  const handles = startCrons(db);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[scoring-worker] ${signal} received; shutting down`);
    handles.tickTask.stop();
    handles.compactionTask.stop();
    // Drain whatever's mid-flight (best effort — chain swallows errors).
    await handles.inFlight();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    `[scoring-worker] started tick="${env.scoringWorkerTickCron()}" compaction="${env.scoringWorkerCompactionCron()}" batch=${env.scoringWorkerBatchSize()} maxAttempts=${env.scoringWorkerMaxAttempts()}`,
  );
}

// Boot only when invoked directly — tests import { tickOnce, compactOnce }
// without triggering the cron registration.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/dist/workers/scoring.js') === true ||
  process.argv[1]?.endsWith('/src/workers/scoring.ts') === true;
if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[scoring-worker] fatal:', err);
    process.exit(1);
  });
}
