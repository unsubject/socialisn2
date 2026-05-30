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
// Why a dedicated probe client (not the app's pool):
//   `Promise.race(query, timeout)` rejects on timeout but the
//   underlying `SELECT 1` keeps its checked-out pool slot until the
//   server eventually responds (postgres-js has no per-query cancel
//   API). Under a sustained DB outage, every /healthz probe pins one
//   pool connection. Default postgres-js max=10; in ~5 minutes the
//   pool is exhausted and request traffic (and /healthz itself) hangs
//   at acquire. The probe you added to detect a broken pool becomes
//   the load that breaks the pool.
//
//   Fix: open a brand-new postgres-js client per probe with max=1, a
//   tight connect_timeout, and a short idle_timeout. On timeout we
//   call client.end() which tears down the socket — server-side state
//   does not survive. The app's pool is not touched.
//
// Returned shape is intentionally tiny so the route handler can pass
// it straight through with a status code: 200 on ok, 503 on not.

import postgres from 'postgres';

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  /** Set when ok=false. Already redacted (no DB URI). */
  error?: string;
}

/**
 * `SELECT 1` with a timeout, on a dedicated 1-connection client so a
 * hanging probe doesn't pin a slot in the app's request-serving pool.
 * Caller (route handler) translates `ok=false` to HTTP 503 and
 * `ok=true` to 200.
 *
 * `connectionString` defaults to `process.env.DATABASE_URL` so callers
 * don't have to thread it; tests can pass a stub explicitly.
 *
 * Timeout defaults to 2s — generous enough that a healthy DB under
 * load won't false-positive, tight enough that a dead DB doesn't make
 * /healthz hang the probe for 30s and trip the healthcheck retry budget.
 * Kubernetes' default liveness `timeoutSeconds` is 1; ours is slightly
 * more lenient because we hit DB rather than a noop endpoint.
 */
export async function pingDatabase(opts: {
  connectionString?: string;
  timeoutMs?: number;
} = {}): Promise<PingResult> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    return {
      ok: false,
      latencyMs: 0,
      error: 'pingDatabase: no connection string (DATABASE_URL unset)',
    };
  }

  const startedAt = Date.now();
  // Dedicated single-connection client. `connect_timeout` bounds the
  // initial TCP+TLS handshake; if it can't establish in 2s we don't
  // wait the full statement-timeout to fail the probe. `idle_timeout`
  // ensures a successful probe's connection actually closes promptly
  // even if .end() is delayed for any reason.
  const probe = postgres(connectionString, {
    max: 1,
    connect_timeout: Math.ceil(timeoutMs / 1000),
    idle_timeout: 5,
    // Postgres-js logs the URI on parse error by default — silence
    // that, the redaction below would otherwise miss leaks the lib
    // emits BEFORE our error handler runs.
    onnotice: () => undefined,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queryPromise = probe<{ one: number }[]>`SELECT 1::int AS one`;
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
    // is a cheap belt-and-braces. `[^\s'"]+` so a URI followed by a
    // quote in the message doesn't drag the quote into the token.
    const raw = err instanceof Error ? err.message : String(err);
    const redacted = raw
      .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
      .slice(0, 240);
    return { ok: false, latencyMs, error: redacted };
  } finally {
    if (timer) clearTimeout(timer);
    // Tear down the dedicated client unconditionally. `{ timeout: 0 }`
    // closes the socket immediately rather than waiting for in-flight
    // queries — exactly what we want when the timeout path won the
    // race: the SELECT 1 query is still pending server-side, we don't
    // care about its result, and we don't want to keep the socket open.
    try {
      await probe.end({ timeout: 0 });
    } catch {
      // ignored — connection may already be torn down
    }
  }
}
