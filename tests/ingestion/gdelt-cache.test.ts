// Real-PG vitest covering lookupOrFetchCoverage's cache logic. Stubs the
// network via a global fetch override so the cache vs. fetch behaviour is
// observable without hitting GDELT. fetchGkg now makes TWO calls per
// coverage fetch (TimelineVolRaw + ArtList), so the spy is dispatch-aware.

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

const TIMELINE_BODY = JSON.stringify({
  timeline: [
    {
      series: 'Article Count',
      data: [
        { date: '20260512T100000Z', value: 612 },
        { date: '20260512T103000Z', value: 905 },
      ],
    },
  ],
});

const ARTLIST_BODY = JSON.stringify({
  articles: [
    {
      language: 'English',
      sourcecountry: 'United States',
      sourcecommonname: 'Reuters',
    },
  ],
});

function makeRoutingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('mode=TimelineVolRaw')) {
      return new Response(TIMELINE_BODY, { status: 200 });
    }
    if (u.includes('mode=ArtList')) {
      return new Response(ARTLIST_BODY, { status: 200 });
    }
    return new Response('unknown mode', { status: 400 });
  });
}

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
    const fetchSpy = makeRoutingFetch();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const input = {
      query: 'Fed',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-13T00:00:00Z'),
    };

    const a = await lookupOrFetchCoverage(db, null, input);
    expect(a.fromCache).toBe(false);
    // Timeline drives the total: 612 + 905 = 1517 (uncapped, not 1 from ArtList).
    expect(a.coverage.totalArticleCount).toBe(1517);
    // ArtList drives the country/outlet sample.
    expect(a.coverage.countryCount).toBe(1);
    expect(a.coverage.sourceOutlets).toEqual(['Reuters']);
    // Themes are always empty in v1 (DOC API doesn't return them).
    expect(a.coverage.themes).toEqual([]);
    // One coverage = two fetches (Timeline + ArtList).
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const b = await lookupOrFetchCoverage(db, null, input);
    expect(b.fromCache).toBe(true);
    expect(b.coverage.totalArticleCount).toBe(1517);
    // No further network calls on the cache hit.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('refetches both endpoints when the cached row is older than 6h', async () => {
    const fetchSpy = makeRoutingFetch();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const input = {
      query: 'Fed',
      startDate: new Date('2026-05-12T00:00:00Z'),
      endDate: new Date('2026-05-13T00:00:00Z'),
    };

    await lookupOrFetchCoverage(db, null, input);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await client.unsafe(
      "UPDATE gdelt_coverage SET fetched_at = NOW() - INTERVAL '7 hours'",
    );

    await lookupOrFetchCoverage(db, null, input);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('queries with different date windows have independent cache rows', async () => {
    const fetchSpy = makeRoutingFetch();
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
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('throws on a non-OK TimelineVolRaw response (caller decides retry)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      lookupOrFetchCoverage(db, null, {
        query: 'Fed',
        startDate: new Date('2026-05-12T00:00:00Z'),
        endDate: new Date('2026-05-13T00:00:00Z'),
      }),
    ).rejects.toThrow(/TimelineVolRaw\) returned 429/);
  });

  it('throws on a non-OK ArtList response after Timeline succeeds', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('mode=TimelineVolRaw')) {
        return new Response(TIMELINE_BODY, { status: 200 });
      }
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    await expect(
      lookupOrFetchCoverage(db, null, {
        query: 'Fed',
        startDate: new Date('2026-05-12T00:00:00Z'),
        endDate: new Date('2026-05-13T00:00:00Z'),
      }),
    ).rejects.toThrow(/ArtList\) returned 429/);
  });
});
