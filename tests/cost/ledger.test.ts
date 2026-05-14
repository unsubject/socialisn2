// Real-PG integration test for cost_ledger writer + daily-total query.
// Resets schema, applies all migrations, then exercises recordCost +
// dailyTotalUsd against the live `cost_ledger` table.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { dailyTotalUsd, recordCost } from '../../src/cost/ledger.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('cost ledger', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    const dir = resolve(process.cwd(), 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf-8');
      await client.unsafe(sql);
    }
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE cost_ledger');
  });

  it('records a row with the computed USD when no override is given', async () => {
    const usd = await recordCost(db, {
      model: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      stage: 'curate',
    });
    expect(usd).toBeCloseTo(0.0105, 9);

    const rows = await client`SELECT model, input_tokens, output_tokens, usd::float, stage
                              FROM cost_ledger`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'claude-sonnet-4.5',
      input_tokens: 1000,
      output_tokens: 500,
      stage: 'curate',
    });
    expect(Number(rows[0]!.usd)).toBeCloseTo(0.0105, 6);
  });

  it('honours an explicit USD override (e.g. LiteLLM _response_cost)', async () => {
    const usd = await recordCost(db, {
      model: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      usd: 0.0123,
      stage: 'curate',
    });
    expect(usd).toBe(0.0123);

    const rows = await client`SELECT usd::float FROM cost_ledger`;
    expect(Number(rows[0]!.usd)).toBeCloseTo(0.0123, 6);
  });

  it('dailyTotalUsd sums today only — excludes yesterday', async () => {
    // Insert two "today" rows + one "yesterday" row by manipulating occurred_at.
    await recordCost(db, {
      model: 'text-embedding-3-small',
      inputTokens: 1_000_000,
      outputTokens: 0,
    }); // 0.02
    await recordCost(db, {
      model: 'claude-sonnet-4.5',
      inputTokens: 1000,
      outputTokens: 500,
    }); // 0.0105

    // Forge a yesterday row directly via SQL.
    await client`
      INSERT INTO cost_ledger
        (id, occurred_at, model, input_tokens, output_tokens, usd)
      VALUES
        (gen_random_uuid(),
         NOW() AT TIME ZONE 'UTC' - INTERVAL '1 day',
         'claude-sonnet-4.5', 1000, 500, 99.99)
    `;

    const total = await dailyTotalUsd(db);
    // Expect 0.02 + 0.0105 = 0.0305 — yesterday's $99.99 must be excluded.
    expect(total).toBeCloseTo(0.0305, 6);
  });

  it('dailyTotalUsd returns 0 on an empty ledger', async () => {
    expect(await dailyTotalUsd(db)).toBe(0);
  });
});
