// Wraps the postgres-js connect path so a parse error or connection
// failure can never leak the connection string (which contains the
// POSTGRES_PASSWORD).
//
// Background — 2026-05-19 deploy: postgres-js threw
//   `Error: ... connection string '<full URI>' ...`
// when given a DATABASE_URL whose base64-encoded password contained
// the `/` character. The full URI — and therefore the password —
// landed in the GitHub Actions log. We rotated the secret; this
// wrapper closes the structural hole so the same incident can't
// happen again on a different unparseable URL.
//
// Two guarantees this module gives you:
//
//   1. The Error we throw never contains the full connection string,
//      the username, or the password — only host, port, and database.
//   2. We never set `cause` on the thrown Error: the original error's
//      message (which DOES contain the URI) must not be reachable via
//      `.cause.message` or appear in Node's default stack output.
//
// On success the wrapper returns the connected `postgres` client.
// The caller owns its lifecycle and MUST call `client.end()`.

import postgres, { type Sql } from 'postgres';

/**
 * Extract the redacted display form `postgres://***:***@host:port/db`
 * from a URL string without throwing. If the URL can be parsed via
 * WHATWG URL AND has a non-empty hostname AND a postgres-shaped
 * protocol, return that display string; otherwise return null and let
 * the caller fall back to a prefix-only message.
 *
 * Defensive: WHATWG URL is permissive enough that
 *   new URL('postgres://u:p/no-host')
 * may succeed with hostname=''; we treat that as malformed for our
 * purposes because postgres-js can't use it anyway.
 */
function redactConnectionString(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return null;
  }
  if (!parsed.hostname) {
    return null;
  }
  const host = parsed.hostname;
  const port = parsed.port || '5432';
  const db = parsed.pathname.replace(/^\//, '') || '(no-db)';
  return `postgres://***:***@${host}:${port}/${db}`;
}

/**
 * Build the redacted "where" clause used in thrown error messages.
 * Either the postgres://***:***@host:port/db form (when we could
 * extract host/port/db) or a prefix-only fallback that still tells
 * an operator what kind of value they passed (always `postgres` or
 * `postgresql`, no creds) without ever printing the rest.
 */
function redactedWhere(connectionString: string): string {
  const redacted = redactConnectionString(connectionString);
  if (redacted !== null) {
    return redacted;
  }
  // First 8 chars of a postgres URI are deterministically one of
  // `postgres` or `postgres` (with a `ql` suffix); they never contain
  // user/pass. Surfacing them helps an operator catch `https://...`
  // or an obvious typo without leaking anything secret.
  const prefix = connectionString.slice(0, 8);
  return `DATABASE_URL is malformed; first 8 chars: ${JSON.stringify(prefix)}`;
}

/**
 * Throw an Error whose message is safe to log. We deliberately do NOT
 * set `cause` on the new Error — chaining the original would expose
 * its message (which contains the full URI) via `.cause.message` and
 * Node's default error printer.
 *
 * We copy over the original error's `code` field (libpq-style codes
 * like ECONNREFUSED / ENOTFOUND) because those are diagnostic and
 * don't contain the URI. We do NOT copy `message` or `stack`.
 */
function throwRedacted(connectionString: string, kind: string, original?: unknown): never {
  const where = redactedWhere(connectionString);
  const err: Error & { code?: string } = new Error(`[${kind}] ${where}`);
  if (
    original !== null &&
    typeof original === 'object' &&
    'code' in original &&
    typeof (original as { code?: unknown }).code === 'string'
  ) {
    err.code = (original as { code: string }).code;
  }
  throw err;
}

/**
 * Validate + connect. On success returns the client (caller must end
 * it). On any failure throws an Error whose message/stack never
 * contains the connection string, username, or password.
 */
export async function connectWithRedactedErrors(connectionString: string): Promise<Sql> {
  // Phase 1: parse-validate. We require a postgres-shaped URL with a
  // non-empty hostname before we hand the string to postgres-js,
  // because postgres-js's own parse-error path is what leaked the
  // URI on 2026-05-19.
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throwRedacted(connectionString, 'parse');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throwRedacted(connectionString, 'parse');
  }
  if (!parsed.hostname) {
    throwRedacted(connectionString, 'parse');
  }

  // Phase 2: connect. postgres-js is lazy — `postgres(url)` returns
  // immediately without contacting the server, so we MUST issue a
  // query to force the TCP/auth round-trip. Without this an
  // unreachable host slips through the wrapper unnoticed.
  //
  // connect_timeout is in SECONDS (not ms). Default is ~30s; we cap
  // at 5 so preflight fails fast in CI when the DB is genuinely
  // unreachable instead of timing out the whole job.
  let client: Sql;
  try {
    client = postgres(connectionString, {
      connect_timeout: 5,
      max: 1,
      onnotice: () => undefined,
    });
  } catch (err) {
    throwRedacted(connectionString, 'init', err);
  }

  try {
    await client`SELECT 1`;
  } catch (err) {
    // Best-effort close — ignore failures, the connect itself failed.
    try {
      await client.end({ timeout: 1 });
    } catch {
      // intentional
    }
    throwRedacted(connectionString, 'connect', err);
  }

  return client;
}
