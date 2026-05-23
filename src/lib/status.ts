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

// `type` alias (not `interface`) so it satisfies the
// `Record<string, unknown>` constraint that drizzle's `db.execute<T>`
// imposes — interfaces are open-ended and TypeScript refuses to widen
// them to the index signature. Memory: drizzle_execute_type_alias.
export type Phase2Stats = {
  /** All-time row count in raw_items. */
  raw_items_total: number;
  /** raw_items.processed_at IS NOT NULL (made it through Phase 2 — normal or dedup-hit). */
  raw_items_processed: number;
  /**
   * raw_items still NULL processed_at AND processing_attempts >= 3.
   * These drop out of `queue.pending_raw_items` without ever being
   * processed — silent-failure signal. Investigate scoring-worker
   * logs if this number is climbing.
   */
  raw_items_failed_3x: number;
  /** All-time row count in items (post-normalise + embed). */
  items_total: number;
  /** clusters.status='active' — the input pool to Stage 3 heuristic ranking. */
  clusters_active: number;
};

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
  /** Added by PR after the 2026-05-23 ingestion-worker incident — surfaces
   *  the Phase 2 (normalise + cluster) pipeline state so silent failures
   *  and dedup-heavy backlogs are externally visible. */
  phase2_stats: Phase2Stats;
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
 * The five sub-queries run in parallel, so round-trip ≈ slowest single hop.
 *
 * The `processing_attempts < 3` cap mirrors the existing Telegram /status
 * query verbatim — same predicate as the ingestion-worker retry budget
 * (see src/workers/ingestion.ts). We intentionally keep parity with that
 * surface rather than reading SCORING_WORKER_MAX_ATTEMPTS here; a future
 * refactor can centralise both.
 */
export async function buildStatus(db: Db): Promise<StatusSnapshot> {
  const [lastRunRows, ceiling, pendingRows, runsTodayRows, phase2Rows] = await Promise.all([
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
    // Phase 2 pipeline stats. Single query with five subqueries — one round
    // trip, each subquery uses its own index path. COUNT(*) on a few-tens-
    // of-thousands row table is sub-second on the live VPS PG. If raw_items
    // grows past ~1M, revisit with pg_class.reltuples or a maintained
    // counter table.
    db.execute<Phase2Stats>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM raw_items) AS raw_items_total,
        (SELECT COUNT(*)::int FROM raw_items WHERE processed_at IS NOT NULL) AS raw_items_processed,
        (SELECT COUNT(*)::int FROM raw_items
           WHERE processed_at IS NULL AND processing_attempts >= 3) AS raw_items_failed_3x,
        (SELECT COUNT(*)::int FROM items) AS items_total,
        (SELECT COUNT(*)::int FROM clusters WHERE status = 'active') AS clusters_active
    `),
  ]);

  // runsTodayRows / phase2Rows always have exactly one row — COUNT(*) on a
  // GROUP-less query never returns zero rows. The non-null assertion is
  // sound; pendingRows[0] uses the same pattern via optional chaining.
  return {
    version: STATUS_SNAPSHOT_VERSION,
    taken_at: new Date().toISOString(),
    last_run: lastRunRows[0] ?? null,
    cost: ceiling,
    queue: {
      pending_raw_items: pendingRows[0]?.n ?? 0,
    },
    runs_today: runsTodayRows[0]!,
    phase2_stats: phase2Rows[0]!,
  };
}
