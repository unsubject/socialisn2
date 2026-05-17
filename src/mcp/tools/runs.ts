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
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../../db/client.js';
import { dailyTotalUsd } from '../../cost/ledger.js';
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
  _rawArgs: unknown,
): Promise<{ run_id: string; status: 'started' }> {
  const runId = uuidv7();

  // Inline INSERT so the row exists by the time we return — the
  // client can immediately poll runs/<run_id> via system_status or
  // direct DB read. runScoring (called below) sees opts.runId set
  // and skips its own initial INSERT.
  await db.execute(sql`
    INSERT INTO runs (id, kind, status)
    VALUES (${runId}, 'manual', 'running')
  `);

  // Fire-and-forget. runScoring() runs the full Stages 3-7 pipeline
  // (~minutes for a real run). We deliberately don't await — the
  // MCP client gets the run id immediately and polls /status / queries
  // runs.<id> to see when status transitions to completed/failed.
  // The catch logs to stderr; runScoring already finalises the runs
  // row internally so the DB stays consistent.
  runScoring(db, { kind: 'manual', runId }).catch((err: unknown) => {
    console.error(`[mcp run_now] run ${runId} failed:`, err);
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
