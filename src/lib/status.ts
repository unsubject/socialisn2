// Canonical /status snapshot. Single source of truth for the two surfaces
// that report system state:
//
//   - GET /status (HTTP, open)         — JSON; consumed by ops-digest and ad-hoc curl
//   - Telegram /status command         — same struct, MarkdownV2-formatted for chat
//
// Future Obs-2..Obs-3 PRs extend this struct (e.g. last_recalibrate_at);
// add fields, do not rename. Bump `STATUS_SNAPSHOT_VERSION` on a breaking
// change so polling consumers (ops-digest) can branch on it.

import { sql } from 'drizzle-orm';

import { checkCeiling, type CeilingStatus } from '../cost/ceiling.js';
import type { Db } from '../db/client.js';

export const STATUS_SNAPSHOT_VERSION = 1;

export interface LastRun {
  /** UUID. */
  id: string;
  /** 'morning' | 'afternoon' | 'manual' (+ 'recalibrate' once Obs-3 ships). */
  kind: string;
  /** 'running' | 'completed' | 'failed'. */
  status: string;
  /** ISO-8601. */
  started_at: string;
  /** ISO-8601 or null while running. */
  completed_at: string | null;
  candidates_count: number | null;
  /** Numeric(10,4) → string; the orchestrator writes this on completion. */
  total_cost_usd: string | null;
  error: string | null;
}

export interface StatusSnapshot {
  version: typeof STATUS_SNAPSHOT_VERSION;
  /** ISO-8601 timestamp when the snapshot was assembled. */
  taken_at: string;
  last_run: LastRun | null;
  cost: CeilingStatus;
  queue: {
    pending_raw_items: number;
  };
  runs_today: {
    total: number;
    failed: number;
  };
}

type LastRunRow = {
  id: string;
  kind: string;
  status: string;
  // db.execute<T> does not run pg type parsers; timestamptz comes back as
  // an ISO-8601 string, which is exactly the shape we want to emit.
  started_at: string;
  completed_at: string | null;
  candidates_count: number | null;
  total_cost_usd: string | null;
  error: string | null;
};

type RunsTodayRow = {
  total: number;
  failed: number;
};

type PendingRow = { n: number };

/**
 * Assemble a status snapshot from the database. Pure read; no side effects.
 * The four sub-queries run in parallel, so round-trip ≈ slowest single hop.
 *
 * The `processing_attempts < 3` cap mirrors the existing Telegram /status
 * query verbatim — same predicate as the ingestion-worker retry budget
 * (see src/workers/ingestion.ts). We intentionally keep parity with that
 * surface rather than reading SCORING_WORKER_MAX_ATTEMPTS here; a future
 * refactor can centralise both.
 */
export async function buildStatus(db: Db): Promise<StatusSnapshot> {
  const [lastRunRows, ceiling, pendingRows, runsTodayRows] = await Promise.all([
    db.execute<LastRunRow>(sql`
      SELECT id, kind, status, started_at, completed_at,
             candidates_count, total_cost_usd, error
      FROM runs
      ORDER BY started_at DESC
      LIMIT 1
    `),
    checkCeiling(db),
    db.execute<PendingRow>(sql`
      SELECT COUNT(*)::int AS n
      FROM raw_items
      WHERE processed_at IS NULL
        AND processing_attempts < 3
    `),
    db.execute<RunsTodayRow>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM runs
      WHERE started_at >= date_trunc('day', NOW(), 'UTC')
    `),
  ]);

  // runsTodayRows always has exactly one row — COUNT(*) on a GROUP-less
  // query never returns zero rows. The non-null assertion is sound; the
  // pendingRows[0] surface uses the same pattern via optional chaining.
  return {
    version: STATUS_SNAPSHOT_VERSION,
    taken_at: new Date().toISOString(),
    last_run: lastRunRows[0] ?? null,
    cost: ceiling,
    queue: {
      pending_raw_items: pendingRows[0]?.n ?? 0,
    },
    runs_today: runsTodayRows[0]!,
  };
}
