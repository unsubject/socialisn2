// Real-PG vitest covering writeCompetitorVideos dedup against the
// (competitor_id, external_id) unique index.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import * as schema from '../../src/db/schema.js';
import { competitors } from '../../src/db/schema.js';
import {
  markCompetitorFetched,
  writeCompetitorVideos,
} from '../../src/ingestion/competitor-writer.js';
import type { CompetitorVideoInput } from '../../src/ingestion/youtube.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function makeVideo(overrides: Partial<CompetitorVideoInput> = {}): CompetitorVideoInput {
  return {
    externalId: 'VID-' + Math.random().toString(36).slice(2),
    url: 'https://www.youtube.com/watch?v=' + Math.random().toString(36).slice(2),
    title: 'Video ' + Math.random().toString(36).slice(2),
    description: 'desc',
    publishedAt: new Date('2026-05-12T12:00:00Z'),
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('writeCompetitorVideos', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let competitorA: string;
  let competitorB: string;

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
    await client.unsafe('TRUNCATE competitor_videos RESTART IDENTITY CASCADE');
    await client.unsafe(
      "DELETE FROM competitors WHERE name LIKE 'cwriter-test%'",
    );
    competitorA = uuidv7();
    competitorB = uuidv7();
    await db.insert(competitors).values([
      {
        id: competitorA,
        platform: 'youtube',
        externalId: 'UCa',
        url: 'https://www.youtube.com/channel/UCa',
        name: 'cwriter-test A',
      },
      {
        id: competitorB,
        platform: 'youtube',
        externalId: 'UCb',
        url: 'https://www.youtube.com/channel/UCb',
        name: 'cwriter-test B',
      },
    ]);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('inserts all videos on a clean batch', async () => {
    const result = await writeCompetitorVideos(db, competitorA, [
      makeVideo({ externalId: 'V1' }),
      makeVideo({ externalId: 'V2' }),
      makeVideo({ externalId: 'V3' }),
    ]);
    expect(result).toEqual({ fetched: 3, insertedCount: 3, duplicateCount: 0 });
  });

  it('rejects republishes on (competitor_id, external_id)', async () => {
    const v = makeVideo({ externalId: 'V1' });
    await writeCompetitorVideos(db, competitorA, [v]);
    const second = await writeCompetitorVideos(db, competitorA, [v]);
    expect(second).toEqual({ fetched: 1, insertedCount: 0, duplicateCount: 1 });
  });

  it('allows the same external_id on a different competitor', async () => {
    const v1 = makeVideo({ externalId: 'SHARED' });
    const v2 = makeVideo({ externalId: 'SHARED' });
    const a = await writeCompetitorVideos(db, competitorA, [v1]);
    const b = await writeCompetitorVideos(db, competitorB, [v2]);
    expect(a.insertedCount).toBe(1);
    expect(b.insertedCount).toBe(1);
  });

  it('returns zero-inserted when items is empty', async () => {
    const result = await writeCompetitorVideos(db, competitorA, []);
    expect(result).toEqual({ fetched: 0, insertedCount: 0, duplicateCount: 0 });
  });

  it('markCompetitorFetched updates last_video_at', async () => {
    const now = new Date('2026-05-12T18:00:00Z');
    await markCompetitorFetched(db, competitorA, now);
    // postgres.js v3 returns timestamptz as strings (drizzle adds a type
    // parser, but raw tagged-template queries use the default). Wrap with
    // `new Date()` so the assertion is independent of the parser config.
    const rows = await client<{ last_video_at: string | Date }[]>`
      SELECT last_video_at FROM competitors WHERE id = ${competitorA}
    `;
    const got = rows[0]?.last_video_at;
    expect(got).toBeTruthy();
    expect(new Date(got!).toISOString()).toBe(now.toISOString());
  });

  it('markCompetitorFetched with null leaves last_video_at unchanged', async () => {
    const before = new Date('2026-05-10T00:00:00Z');
    await markCompetitorFetched(db, competitorA, before);
    await markCompetitorFetched(db, competitorA, null);
    const rows = await client<{ last_video_at: string | Date }[]>`
      SELECT last_video_at FROM competitors WHERE id = ${competitorA}
    `;
    const got = rows[0]?.last_video_at;
    expect(got).toBeTruthy();
    expect(new Date(got!).toISOString()).toBe(before.toISOString());
  });
});
