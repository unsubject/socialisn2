// MCP run-management tools.
//
// run_now triggers an ad-hoc scoring run AND returns the run id
// synchronously per SPEC §11.4. The tool inserts the runs row
// inline (so the row exists when we return) and kicks off
// runScoring() in the background without awaiting. runScoring's
// opts.runId tells it to skip its own initial INSERT and use the
// already-existing row.
//
// system_status returns the lightweight snapshot the bot's /status
// command and external clients both consume.

import { sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../../db/client.js';
import { dailyTotalUsd } from '../../cost/ledger.js';
import { RUN_LOCK_KEY } from '../../orchestrator/lock.js';
import { runScoring } from '../../orchestrator/run.js';

type LastRunRow = {
  id: string;
  kind: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  candidates_count: number | null;
  total_cost_usd: string | null;
  error: string | null;
};

export async function runNow(
  db: Db,
  raw: Sql,
  _rawArgs: unknown,
): Promise<
  | { run_id: string; status: 'started' }
  | { run_id: null; status: 'skipped_locked' }
> {
  const runId = uuidv7();

  // Acquire the orchestrator run lock BEFORE inserting the runs row.
  // The reserve+lock happens on a pinned connection that we hand to the
  // background promise; the lock stays held until runScoring resolves
  // (success or failure). If the lock is already held (cron tick or a
  // previous run_now in flight), return skipped_locked WITHOUT
  // inserting a row so we don't leave a stuck 'running' row behind.
  const reserved = await raw.reserve();
  let locked = false;
  try {
    const rows = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${RUN_LOCK_KEY}) AS locked
    `;
    locked = rows[0]?.locked === true;
  } catch (err) {
    reserved.release();
    throw err;
  }
  if (!locked) {
    reserved.release();
    return { run_id: null, status: 'skipped_locked' };
  }

  // Lock held. INSERT the row so MCP callers can poll it immediately.
  try {
    await db.execute(sql`
      INSERT INTO runs (id, kind, status)
      VALUES (${runId}, 'manual', 'running')
    `);
  } catch (err) {
    // Failed to insert the row → release the lock so the next caller
    // isn't blocked by our half-aborted attempt.
    try {
      await reserved`SELECT pg_advisory_unlock(${RUN_LOCK_KEY})`;
    } catch {
      // ignored
    }
    reserved.release();
    throw err;
  }

  // Fire-and-forget. runScoring() runs the full Stages 3-7 pipeline
  // (~minutes for a real run). We deliberately don't await — the
  // MCP client gets the run id immediately and polls /status / queries
  // runs.<id> to see when status transitions to completed/failed.
  // The catch logs to stderr; runScoring already finalises the runs
  // row internally so the DB stays consistent. The finally releases
  // the advisory lock + pinned connection so subsequent runs (cron or
  // run_now) aren't blocked.
  runScoring(db, { kind: 'manual', runId })
    .catch((err: unknown) => {
      console.error(`[mcp run_now] run ${runId} failed:`, err);
    })
    .finally(async () => {
      try {
        await reserved`SELECT pg_advisory_unlock(${RUN_LOCK_KEY})`;
      } catch {
        // ignored — connection-end auto-releases anyway
      }
      try {
        reserved.release();
      } catch {
        // reserved.release() can throw if the underlying connection
        // ended (SIGTERM teardown closes raw via close(); the
        // background runScoring's finally races that). Swallow so the
        // fire-and-forget chain doesn't emit an unhandled rejection.
        // The connection is already gone; release() throwing means
        // there's nothing to release.
      }
    });

  return { run_id: runId, status: 'started' };
}

export async function systemStatus(
  db: Db,
  _rawArgs: unknown,
): Promise<{
  last_run: {
    id: string;
    kind: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    candidates_count: number | null;
    total_cost_usd: number | null;
    error: string | null;
  } | null;
  cost_today_usd: number;
  queue_depth: number;
  candidate_pool_size: number;
}> {
  // Parallel — the three reads are independent, and small enough that
  // the three round trips are noise vs the LLM-touching tools.
  const [lastRunRows, spentUsd, pendingRows, poolRows] = await Promise.all([
    db.execute<LastRunRow>(sql`
      SELECT id, kind, status, started_at, completed_at,
             candidates_count, total_cost_usd, error
      FROM runs
      ORDER BY started_at DESC
      LIMIT 1
    `),
    dailyTotalUsd(db),
    db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM raw_items
      WHERE processed_at IS NULL
        AND processing_attempts < 3
    `),
    db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM candidates
      WHERE status = 'new' AND expires_at > NOW()
    `),
  ]);

  const lastRunRow = lastRunRows[0];
  const lastRun = lastRunRow
    ? {
        id: lastRunRow.id,
        kind: lastRunRow.kind,
        status: lastRunRow.status,
        started_at: new Date(lastRunRow.started_at).toISOString(),
        completed_at: lastRunRow.completed_at
          ? new Date(lastRunRow.completed_at).toISOString()
          : null,
        candidates_count: lastRunRow.candidates_count,
        // total_cost_usd is numeric in PG (string in JS land per the
        // codebase's gotcha note). Convert to number for the wire.
        total_cost_usd:
          lastRunRow.total_cost_usd === null ? null : Number(lastRunRow.total_cost_usd),
        error: lastRunRow.error,
      }
    : null;

  return {
    last_run: lastRun,
    cost_today_usd: spentUsd,
    queue_depth: pendingRows[0]?.n ?? 0,
    candidate_pool_size: poolRows[0]?.n ?? 0,
  };
}
