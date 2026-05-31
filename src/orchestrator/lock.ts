// Postgres advisory-lock helper for the twice-daily scoring run.
//
// Why: pre-2026-05-30 a duplicate trigger could race a real orchestrator
// pass — cron firing twice (TZ confusion, container restart mid-tick) or
// an MCP run_now landing while a cron-triggered run was already in
// flight. Two runs racing on the same `clusters` rows would double-spend
// the cost ceiling, double-INSERT candidates, and corrupt the runs-row
// timing. There was no DB-level interlock to prevent this — the only
// thing that "kept it from happening" was rarity.
//
// Shape: pg_try_advisory_lock(key) on a RESERVED connection (via
// `raw.reserve()` in postgres-js). Pinning matters: advisory locks are
// session-scoped, and the pooled `db.execute(...)` calls inside
// runScoring would each grab a different connection — the lock would
// release the moment the acquiring connection idles back. The reserved
// connection stays out of the pool for the duration of the work, so the
// lock is held continuously.
//
// The lock guards the BOUNDARY (cron tick, MCP run_now) rather than
// runScoring's internals so the 13 existing runScoring tests don't need
// to plumb a lock through their dependency-injection surface — the lock
// is purely an "is anyone else running?" check at the entry point.

import type { Sql } from 'postgres';

/**
 * Stable int4 key for the socialisn2 orchestrator run lock. Chosen as
 * a distinctive constant (date the lock landed, 2026-05-30, prefixed
 * with the year for human recognition in `pg_locks`). Collision with
 * another system using advisory locks on the same DB would only matter
 * for orchestrator concurrency; nothing else in this schema uses
 * advisory locks today.
 */
export const RUN_LOCK_KEY = 2_026_053_001;

export type WithRunLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false };

/**
 * Run `work()` while holding the orchestrator run lock. If the lock is
 * already held by another session, returns `{ acquired: false }`
 * WITHOUT running `work`. The caller (cron / MCP) decides what to do
 * with a skip — typically: log, leave any pre-inserted runs row to the
 * watchdog, return early.
 *
 * Reserves a dedicated postgres-js connection for the duration so the
 * advisory lock stays held even though the inner work grabs unrelated
 * connections from the pool for its own queries.
 *
 * On any error in `work()`, the finally block releases the lock + the
 * reserved connection so a thrown run doesn't wedge the next tick.
 * Errors propagate to the caller.
 */
export async function withRunLock<T>(
  raw: Sql,
  work: () => Promise<T>,
  key: number = RUN_LOCK_KEY,
): Promise<WithRunLockResult<T>> {
  const reserved = await raw.reserve();
  try {
    const rows = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS locked
    `;
    const locked = rows[0]?.locked === true;
    if (!locked) {
      return { acquired: false };
    }
    try {
      const result = await work();
      return { acquired: true, result };
    } finally {
      // Best-effort release. If the reserved connection died mid-work
      // the unlock would throw; the lock auto-releases on session end
      // anyway, so we swallow rather than mask the original error.
      try {
        await reserved`SELECT pg_advisory_unlock(${key})`;
      } catch {
        // ignored — see comment above
      }
    }
  } finally {
    reserved.release();
  }
}
