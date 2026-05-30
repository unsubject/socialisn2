// Liveness / DB-reachability probe for /healthz.
//
// Why a real DB roundtrip: pre-this-PR `/healthz` returned a hardcoded
// `{ok: true}` the moment Fastify booted, so docker-compose's
// healthcheck + Traefik's loadbalancer probe both flipped to "healthy"
// even when the DB was unreachable or the app's connection pool had
// permanently broken. A `SELECT 1` with a short timeout makes /healthz
// a meaningful liveness probe — it fails when the path that actually
// matters (request → DB → response) is broken, not just when the
// process is dead.
//
// Returned shape is intentionally tiny so the route handler can pass
// it straight through with a status code: 200 on ok, 503 on not.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  /** Set when ok=false. Already redacted (no DB URI). */
  error?: string;
}

/**
 * `SELECT 1` with a timeout. Caller (route handler) translates
 * `ok=false` to HTTP 503 and `ok=true` to 200.
 *
 * Timeout defaults to 2s — generous enough that a healthy DB under
 * load won't false-positive, tight enough that a dead DB doesn't make
 * /healthz hang the probe for 30s and trip the healthcheck retry budget.
 * Kubernetes' default liveness `timeoutSeconds` is 1; ours is slightly
 * more lenient because we hit DB rather than a noop endpoint.
 */
export async function pingDatabase(
  db: Db,
  opts: { timeoutMs?: number } = {},
): Promise<PingResult> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queryPromise = db.execute<{ one: number }>(sql`SELECT 1::int AS one`);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`pingDatabase timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const rows = await Promise.race([queryPromise, timeoutPromise]);
    const latencyMs = Date.now() - startedAt;
    if (rows[0]?.one !== 1) {
      return {
        ok: false,
        latencyMs,
        error: 'unexpected SELECT 1 result (driver/schema mismatch)',
      };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    // Strip anything that could resemble a DB URI from the error
    // message. postgres-js parse errors can leak the connection string
    // — see src/lib/connect-with-redacted-errors.ts and the 2026-05-19
    // incident. We don't need full redaction here (this isn't the
    // bootstrap path), but truncating + scrubbing typical URI shapes
    // is a cheap belt-and-braces.
    const raw = err instanceof Error ? err.message : String(err);
    const redacted = raw
      .replace(/postgres(ql)?:\/\/[^\s]+/gi, 'postgres://[redacted]')
      .slice(0, 240);
    return { ok: false, latencyMs, error: redacted };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
