// Continuous Phase 2 worker entry. Boots two crons (tick + daily
// compaction) against a shared DB handle, then waits on SIG handlers
// for graceful shutdown.
//
// All meaningful logic lives in src/workers/scoring-core.ts so tests
// can drive `tickOnce` / `compactOnce` directly without spinning the
// cron or installing SIG handlers. This file is the deployment
// entry only — the docker-compose `scoring-worker` service runs it
// via `node dist/workers/scoring.js`.

import process from 'node:process';

import { createDb } from '../db/client.js';
import { env } from '../config/env.js';
import { startCrons } from './scoring-core.js';

async function main(): Promise<void> {
  const { db, close } = createDb();
  const handles = startCrons(db);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[scoring-worker] ${signal} received; shutting down`);
    handles.tickTask.stop();
    handles.compactionTask.stop();
    // Drain whatever's mid-flight (best effort — the chain swallows
    // errors so this can't throw).
    await handles.drain();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    `[scoring-worker] started tick="${env.scoringWorkerTickCron()}" compaction="${env.scoringWorkerCompactionCron()}" batch=${env.scoringWorkerBatchSize()} maxAttempts=${env.scoringWorkerMaxAttempts()}`,
  );
}

main().catch((err: unknown) => {
  console.error('[scoring-worker] fatal:', err);
  process.exit(1);
});
