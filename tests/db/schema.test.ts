// Smoke-tests migrations/001_init.sql against a real Postgres (vector-enabled).
// In CI the workflow's `pgvector/pgvector:pg16` service container provides this.
// Locally: `docker compose up -d postgres` and export DATABASE_URL pointing at
// a `*_test` database (NOT the default `socialisn2`).
//
// The destructive-DB guard lives in tests/helpers/destructive-guard.ts and is
// shared with seeds.test.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { costLedger, sources } from '../../src/db/schema.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
const migrationSql = readFileSync(
  resolve(process.cwd(), 'migrations/001_init.sql'),
  'utf-8',
);

describe.skipIf(!DATABASE_URL)('001_init schema', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    // Idempotent reset — lets the test rerun cleanly on the same CI service.
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await client.unsafe(migrationSql);
    db = drizzle(client);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('installs the vector extension', async () => {
    const rows = await client`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(rows.length).toBe(1);
  });

  it('round-trips a sources row through drizzle', async () => {
    const id = uuidv7();
    await db.insert(sources).values({
      id,
      kind: 'rss',
      url: 'https://example.com/feed.xml',
      name: 'Example Feed',
      domains: ['testing'],
    });

    const rows = await client`
      SELECT kind, name, domains FROM sources WHERE id = ${id}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe('rss');
    expect(rows[0]?.domains).toEqual(['testing']);
  });

  it('round-trips a cost_ledger row', async () => {
    const id = uuidv7();
    await db.insert(costLedger).values({
      id,
      model: 'claude-sonnet-4.5',
      inputTokens: 1234,
      outputTokens: 567,
      usd: '0.012345',
    });
    const rows = await client`
      SELECT model, input_tokens FROM cost_ledger WHERE id = ${id}
    `;
    expect(rows[0]?.model).toBe('claude-sonnet-4.5');
    expect(rows[0]?.input_tokens).toBe(1234);
  });

  it('rejects an invalid sources.kind via CHECK constraint', async () => {
    const id = uuidv7();
    await expect(
      client`
        INSERT INTO sources (id, kind, url, name, domains)
        VALUES (${id}, 'not_a_real_kind', 'https://example.com', 'bogus', ARRAY['testing'])
      `,
    ).rejects.toThrow();
  });
});
