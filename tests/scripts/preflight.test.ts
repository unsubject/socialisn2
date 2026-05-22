// Tests for the Obs-4 preflight gate.
//
// The load-bearing test is `redaction`: it asserts that no part of the
// connection string — protocol-stripped URI, username, password — can
// appear in the thrown Error's message OR stack. That property is
// what makes the 2026-05-19 incident class (URL parse error leaking
// POSTGRES_PASSWORD to the GitHub Actions log) impossible to repeat.
//
// We also drive the preflight CLI via a child process to assert the
// `::error::` annotation prefix lands on stderr and the exit code is
// non-zero on red.

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { connectWithRedactedErrors } from '../../src/lib/connect-with-redacted-errors.js';

const PREFLIGHT_TSX = fileURLToPath(
  new URL('../../scripts/preflight.ts', import.meta.url),
);

// A distinctive password that wouldn't show up by accident anywhere
// else in our error messages. Used for both username and password so
// either leak shows the same way.
const SECRET_USER = 'sec-user-c9f1';
const SECRET_PASS = 's3kr3t-pa55-D0nt-leak-/+abc=';

function asSafeRegexLiteral(s: string): RegExp {
  // Escape regex metacharacters so we can match the literal string.
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function assertNoSecretsLeaked(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  const e = err as Error & { cause?: unknown };
  const message = e.message;
  const stack = e.stack ?? '';
  for (const needle of [SECRET_USER, SECRET_PASS]) {
    expect(message).not.toMatch(asSafeRegexLiteral(needle));
    expect(stack).not.toMatch(asSafeRegexLiteral(needle));
  }
  // Belt-and-braces: confirm we did NOT chain `cause`. If we ever
  // did, `.cause.message` could re-leak the URI in default error
  // printers.
  expect(e.cause).toBeUndefined();
}

describe('connectWithRedactedErrors', () => {
  it('redacts a malformed URL (no host) and never leaks user/password in message or stack', async () => {
    // `postgres://u:p/no-host` is one of postgres-js's classic
    // parse-error inputs; WHATWG URL may even parse this with an
    // empty hostname (advisor note 5).
    const url = `postgres://${SECRET_USER}:${SECRET_PASS}/no-host`;
    let caught: unknown;
    try {
      await connectWithRedactedErrors(url);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    assertNoSecretsLeaked(caught);
    // We should still get a useful clue. The wrapper's parse branch
    // surfaces a postgres-shaped where-clause OR the prefix-only
    // fallback; either way no creds.
    const msg = (caught as Error).message;
    expect(msg).toMatch(/parse|malformed/);
  });

  it('redacts a totally-broken URL with the prefix-only fallback', async () => {
    // Not parseable as a URL at all — wrapper should still produce
    // a redacted error without leaking what it can't parse.
    const url = `not-a-url-at-all://${SECRET_USER}:${SECRET_PASS}@nowhere`;
    let caught: unknown;
    try {
      await connectWithRedactedErrors(url);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    assertNoSecretsLeaked(caught);
  });

  it('redacts a connection failure to an unreachable host without leaking creds', async () => {
    // Port 1 is always closed/refused, so the connect attempt fails
    // synchronously without hanging the test (advisor note 3). Use a
    // URL-safe password here so we drive the connect branch, not the
    // parse branch — the parse branch with a `/`-bearing password is
    // covered by the redaction test above (that IS the 2026-05-19
    // incident class).
    const urlSafePass = 'urlSafePassSec123';
    const url = `postgres://${SECRET_USER}:${urlSafePass}@127.0.0.1:1/somedb`;
    let caught: unknown;
    try {
      await connectWithRedactedErrors(url);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { cause?: unknown };
    expect(e.message).not.toMatch(asSafeRegexLiteral(SECRET_USER));
    expect(e.message).not.toMatch(asSafeRegexLiteral(urlSafePass));
    expect((e.stack ?? '')).not.toMatch(asSafeRegexLiteral(SECRET_USER));
    expect((e.stack ?? '')).not.toMatch(asSafeRegexLiteral(urlSafePass));
    expect(e.cause).toBeUndefined();
    // Should at least mention the redacted host:port so an operator
    // can correlate to a target without seeing the URI.
    expect(e.message).toMatch(/127\.0\.0\.1:1/);
    expect(e.message).toMatch(/somedb/);
  }, 15_000);

  it('connects + runs SELECT 1 when given a reachable DATABASE_URL (skipped if unset)', async () => {
    const real = process.env.DATABASE_URL;
    if (!real) {
      // In CI the postgres service is always up; this branch is only
      // hit for local runs without one. Skip rather than fail.
      return;
    }
    const client = await connectWithRedactedErrors(real);
    try {
      const rows = await client<{ ok: number }[]>`SELECT 1::int AS ok`;
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await client.end({ timeout: 1 });
    }
  });
});

// The preflight CLI is built into dist/scripts/preflight.js for prod;
// in tests we drive the TS source via `tsx` so we don't depend on a
// build artefact.
function runPreflight(extraEnv: Record<string, string | undefined>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  // Build an env that inherits the test runner's vars (incl. PATH,
  // node_modules resolution) then layers our overrides + deletions.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      PREFLIGHT_TSX,
    ],
    {
      env,
      encoding: 'utf-8',
      timeout: 20_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('preflight CLI', () => {
  // These tests assume DATABASE_URL is inherited from the environment
  // and points at a reachable database (CI: the postgres service).
  // Without it, the preflight short-circuits at the DB check and the
  // LITELLM/COST branches are never exercised.
  it('exits non-zero with ::error:: annotation when LITELLM_BASE_URL is missing', () => {
    const out = runPreflight({
      LITELLM_BASE_URL: undefined,
      // Keep DATABASE_URL pointing at the CI postgres so the first
      // check passes and we drive the missing-litellm branch.
      // Other required vars stub-filled so we isolate the failure.
      LITELLM_API_KEY: 'stub',
      OPENAI_API_KEY: 'stub',
      COST_CEILING_DAILY_USD: '1.50',
      COST_ALERT_THRESHOLD: '0.80',
      PUBLIC_HOST: 'example.test',
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.stderr).toMatch(/LITELLM_BASE_URL/);
  });

  it('exits non-zero when COST_CEILING_DAILY_USD is not a positive number', () => {
    const out = runPreflight({
      LITELLM_BASE_URL: 'http://litellm.test:4000/',
      LITELLM_API_KEY: 'stub',
      OPENAI_API_KEY: 'stub',
      COST_CEILING_DAILY_USD: 'abc',
      COST_ALERT_THRESHOLD: '0.80',
      PUBLIC_HOST: 'example.test',
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.stderr).toMatch(/COST_CEILING_DAILY_USD/);
  });
});
