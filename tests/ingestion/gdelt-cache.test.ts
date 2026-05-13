// Real-PG vitest covering lookupOrFetchCoverage's cache logic. Stubs the
// network via a global fetch override so the cache vs. fetch behaviour is
// observable without hitting GDELT.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { lookupOrFetchCoverage } from '../../src/ingestion/gdelt.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('lookupOrFetchCoverage cache', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf-8');
      await client.unsafe(sql);
    }
    db = drizzle(client, { schema });
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE gdelt_coverage RESTART IDENTITY CASCADE');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('writes a coverage row on first call and reads back on the second', async () => {
    const stubBody = JSON.stringify({
      articles: [
        {
          seendate: '20260512T100000Z',
          language: 'English',
          sourcecountry: 'US',
          sourcecommonname: 'Reuters',
          themes: 'ECON_CENTRALBANK',
        },
      ],
    });
    const fetchSpy = vi.fn(async () => new Response(stubBody, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const input = {
      query: 'Fed',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-13T00:00:00Z'),
    };

    const a = await lookupOrFetchCoverage(db, null, input);
    expect(a.fromCache).toBe(false);
    expect(a.coverage.totalArticleCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const b = await lookupOrFetchCoverage(db, null, input);
    expect(b.fromCache).toBe(true);
    expect(b.coverage.totalArticleCount).toBe(1);
    // No further network calls on the cache hit.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches when the cached row is older than 6h', async () => {
    const stubBody = JSON.stringify({ articles: [] });
    const fetchSpy = vi.fn(async () => new Response(stubBody, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const input = {
      query: 'Fed',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-13T00:00:00Z'),
    };

    await lookupOrFetchCoverage(db, null, input);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Backdate the just-written row to 7h ago — outside the 6h cache window.
    await client.unsafe(
      "UPDATE gdelt_coverage SET fetched_at = NOW() - INTERVAL '7 hours'",
    );

    await lookupOrFetchCoverage(db, null, input);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('queries with different date windows have independent cache rows', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ articles: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await lookupOrFetchCoverage(db, null, {
      query: 'Fed',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-13T00:00:00Z'),
    });
    await lookupOrFetchCoverage(db, null, {
      query: 'Fed',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-14T00:00:00Z'),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws on non-OK HTTP responses (caller decides retry)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      lookupOrFetchCoverage(db, null, {
        query: 'Fed',
        startDate: new Date('2026-05-12T00:00:00Z'),
        endDate: new Date('2026-05-13T00:00:00Z'),
      }),
    ).rejects.toThrow(/GKG returned 429/);
  });
});
