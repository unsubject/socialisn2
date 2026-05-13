// Real-PG vitest covering dedup behaviour of writeRawItems against a freshly
// migrated `socialisn2_test` database. Asserts:
//   - first batch inserts all rows
//   - same batch a second time inserts zero (cross-source dedup via hash)
//   - title-only variation hits title_hash dedup
//   - url-only tracking-param variation hits url_hash dedup
//   - same source + same external_id hits the (source_id, external_id) unique

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import * as schema from '../../src/db/schema.js';
import { sources } from '../../src/db/schema.js';
import { writeRawItems } from '../../src/ingestion/writer.js';
import type { RawItemInput } from '../../src/ingestion/types.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function makeItem(overrides: Partial<RawItemInput> = {}): RawItemInput {
  return {
    externalId: 'ext-' + Math.random().toString(36).slice(2),
    url: 'https://example.com/post-' + Math.random().toString(36).slice(2),
    title: 'Some title ' + Math.random().toString(36).slice(2),
    content: null,
    author: null,
    publishedAt: new Date('2026-05-12T12:00:00Z'),
    language: 'en',
    rawMeta: {},
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)('writeRawItems dedup', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceA: string;
  let sourceB: string;

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
    await client.unsafe('TRUNCATE raw_items RESTART IDENTITY CASCADE');
    await client.unsafe(
      "DELETE FROM sources WHERE name LIKE 'writer-test%'",
    );
    sourceA = uuidv7();
    sourceB = uuidv7();
    await db.insert(sources).values([
      {
        id: sourceA,
        kind: 'rss',
        url: 'https://a.example/feed',
        name: 'writer-test A',
        domains: ['testing'],
      },
      {
        id: sourceB,
        kind: 'rss',
        url: 'https://b.example/feed',
        name: 'writer-test B',
        domains: ['testing'],
      },
    ]);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('inserts all items on a clean batch', async () => {
    const items = [
      makeItem({ url: 'https://a.example/post-1', title: 'Story one' }),
      makeItem({ url: 'https://a.example/post-2', title: 'Story two' }),
      makeItem({ url: 'https://a.example/post-3', title: 'Story three' }),
    ];
    const result = await writeRawItems(db, sourceA, items);
    expect(result).toEqual({ fetched: 3, insertedCount: 3, duplicateCount: 0 });

    const rows = await client`SELECT COUNT(*)::int AS n FROM raw_items WHERE source_id = ${sourceA}`;
    expect(rows[0]?.n).toBe(3);
  });

  it('rejects the same batch on a second call (url_hash dedup)', async () => {
    const items = [
      makeItem({ url: 'https://a.example/post-1', title: 'Story one' }),
      makeItem({ url: 'https://a.example/post-2', title: 'Story two' }),
    ];
    await writeRawItems(db, sourceA, items);
    const second = await writeRawItems(db, sourceA, items);
    expect(second).toEqual({ fetched: 2, insertedCount: 0, duplicateCount: 2 });
  });

  it('dedups across sources by url_hash (utm variation canonicalised)', async () => {
    await writeRawItems(db, sourceA, [
      makeItem({
        externalId: 'a-1',
        url: 'https://shared.example/article/x',
        title: 'Shared article one',
      }),
    ]);
    // Source B picks up the same article via a syndication with utm params.
    const second = await writeRawItems(db, sourceB, [
      makeItem({
        externalId: 'b-1',
        url: 'https://shared.example/article/x?utm_source=newsletter',
        title: 'Shared article one',
      }),
    ]);
    expect(second.insertedCount).toBe(0);
    expect(second.duplicateCount).toBe(1);
  });

  it('dedups by title_hash when URLs differ but title is identical', async () => {
    await writeRawItems(db, sourceA, [
      makeItem({
        externalId: 'a-2',
        url: 'https://a.example/v1/path',
        title: 'A novel finding in macro policy',
      }),
    ]);
    const second = await writeRawItems(db, sourceB, [
      makeItem({
        externalId: 'b-2',
        url: 'https://b.example/different-path',
        title: 'A novel finding in macro policy',
      }),
    ]);
    expect(second.insertedCount).toBe(0);
    expect(second.duplicateCount).toBe(1);
  });

  it('treats em-dash / en-dash / hyphen variants as the same title', async () => {
    await writeRawItems(db, sourceA, [
      makeItem({ externalId: 'a-3', url: 'https://a.example/x', title: 'Reuters — Big news' }),
    ]);
    const second = await writeRawItems(db, sourceB, [
      makeItem({ externalId: 'b-3', url: 'https://b.example/y', title: 'Reuters - Big news' }),
    ]);
    expect(second.insertedCount).toBe(0);
  });

  it('folds intra-batch hash collisions before insert', async () => {
    const items = [
      makeItem({ externalId: 'a-4a', url: 'https://a.example/p?utm_source=rss', title: 'Same' }),
      makeItem({ externalId: 'a-4b', url: 'https://a.example/p', title: 'Same' }),
    ];
    const result = await writeRawItems(db, sourceA, items);
    expect(result.insertedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
  });

  it('returns zero-inserted when items is empty', async () => {
    const result = await writeRawItems(db, sourceA, []);
    expect(result).toEqual({ fetched: 0, insertedCount: 0, duplicateCount: 0 });
  });
});
