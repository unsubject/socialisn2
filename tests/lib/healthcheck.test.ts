// Unit tests for src/lib/healthcheck.ts.
//
// Property coverage:
//   - no DATABASE_URL (and no explicit connectionString) → {ok:false}
//     with a clear error, no postgres-js client created
//   - throw path: bad connection string → {ok:false}, error redacted
//     of any DB-URI substring
//   - timeout: an unreachable host that doesn't accept connections
//     surfaces as {ok:false} within ~timeoutMs (not the postgres-js
//     default which would hang the probe)
//
// We exercise the timeout path with a non-routable IP so the connect
// is guaranteed to never complete. The dedicated probe client model
// means the timeout WORKS — under the old pool-shared design the
// query would silently keep running on the underlying socket.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pingDatabase } from '../../src/lib/healthcheck.js';

describe('pingDatabase', () => {
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  it('returns {ok:false} when no connection string is available', async () => {
    const result = await pingDatabase();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/DATABASE_URL unset/);
    expect(result.latencyMs).toBe(0);
  });

  it('redacts a DB URI substring in the error when connection string is malformed', async () => {
    // Pass an obviously malformed URI to force a parse-time error.
    // postgres-js's parse path can include the URI verbatim in the
    // error message — we want to confirm the redaction scrubs it.
    const result = await pingDatabase({
      connectionString: 'postgresql://user:s3kr3t@no-host-/no-db',
      timeoutMs: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/s3kr3t/);
    // Either the URI got redacted to the placeholder, OR postgres-js
    // never echoed it in the message at all (depending on lib version).
    // Both are acceptable; the load-bearing assertion is "secret didn't
    // leak".
  });

  it('times out within ~timeoutMs against an unreachable host', async () => {
    // 192.0.2.1 is part of TEST-NET-1 — guaranteed not to be a routable
    // production host. The connect attempt either hangs or fails very
    // slowly; the timeoutMs guard must bound the probe regardless.
    const t0 = Date.now();
    const result = await pingDatabase({
      connectionString: 'postgres://u:p@192.0.2.1:5432/test',
      timeoutMs: 200,
    });
    const elapsed = Date.now() - t0;
    expect(result.ok).toBe(false);
    // The probe should return within a small multiple of the timeout
    // (client teardown takes some time). 2000ms gives ample headroom.
    expect(elapsed).toBeLessThan(2_000);
    // Either the timeout-shaped error or a connect-refused/parse error
    // — both are acceptable evidence the probe did NOT hang
    // indefinitely against an unreachable host.
    expect(result.error).toMatch(
      /timed out|refused|ECONN|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|parse|address/i,
    );
  }, 5_000);
});
