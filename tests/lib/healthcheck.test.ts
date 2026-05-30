// Unit tests for src/lib/healthcheck.ts.
//
// The interesting properties to cover with mocks (no PG):
//   - happy path: SELECT 1 returns the expected shape → {ok:true}
//   - bad shape: SELECT returns a row missing `.one` → {ok:false}
//   - throw path: SELECT throws → {ok:false}, error redacted of any
//     DB-URI substring
//   - timeout: query never resolves → {ok:false} after timeoutMs
//
// A real-PG test would only re-prove "SELECT 1 works", which the
// happy path already implies. Skipping it keeps this file fast.

import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { pingDatabase } from '../../src/lib/healthcheck.js';

function makeStubDb(execute: (...args: unknown[]) => Promise<unknown>): Db {
  return { execute: vi.fn(execute) } as unknown as Db;
}

describe('pingDatabase', () => {
  it('returns {ok:true, latencyMs} when SELECT 1 returns the expected row', async () => {
    const db = makeStubDb(async () => [{ one: 1 }]);
    const result = await pingDatabase(db);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns {ok:false} when SELECT 1 returns an unexpected shape', async () => {
    const db = makeStubDb(async () => [{ unexpected: 42 }]);
    const result = await pingDatabase(db);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unexpected/i);
  });

  it('returns {ok:false, error} when the query throws', async () => {
    const db = makeStubDb(async () => {
      throw new Error('connection terminated');
    });
    const result = await pingDatabase(db);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection terminated');
  });

  it('redacts a DB URI substring from the error message', async () => {
    // postgres-js parse errors sometimes include the URI verbatim. We
    // don't want that leaking into the /healthz response body.
    const leakyUrl = 'postgresql://user:s3kr3t@db.example.com:5432/socialisn2';
    const db = makeStubDb(async () => {
      throw new Error(`parse failed for ${leakyUrl}`);
    });
    const result = await pingDatabase(db);
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/s3kr3t/);
    expect(result.error).not.toMatch(/user/);
    expect(result.error).toMatch(/postgres:\/\/\[redacted\]/);
  });

  it('returns {ok:false} after timeoutMs when the query never resolves', async () => {
    const db = makeStubDb(() => new Promise(() => {}));
    const result = await pingDatabase(db, { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 50ms/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(50);
  });
});
