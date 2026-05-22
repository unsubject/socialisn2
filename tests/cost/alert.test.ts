// Real-PG integration test for src/cost/alert.ts (Obs-2 fire path).
// Mirrors the tests/cost/ceiling.test.ts setup: schema drop + reapply
// once per file, TRUNCATE between tests.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as schema from '../../src/db/schema.js';
import {
  maybeFireCostAlert,
  type CostAlertPusher,
} from '../../src/cost/alert.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.COST_CEILING_DAILY_USD = '1.50';
  process.env.COST_ALERT_THRESHOLD = '0.80';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe.skipIf(!DATABASE_URL)('cost alert fire path (Obs-2)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, file), 'utf-8'));
    }
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE cost_ledger CASCADE');
    await client.unsafe('TRUNCATE TABLE cost_alert_state CASCADE');
  });

  async function insertSpend(usd: number, occurredAt: Date = new Date()): Promise<void> {
    const id = uuidv7();
    const iso = occurredAt.toISOString();
    await client`
      INSERT INTO cost_ledger (id, model, input_tokens, output_tokens, usd, occurred_at)
      VALUES (${id}, 'claude-sonnet-4.5', 100, 50, ${usd.toFixed(6)}, ${iso}::timestamptz)
    `;
  }

  function spyPusher(): CostAlertPusher & { calls: string[] } {
    const calls: string[] = [];
    const fn = vi.fn(async (text: string) => {
      calls.push(text);
    });
    return Object.assign(fn as unknown as CostAlertPusher, { calls });
  }

  async function countAlertRows(): Promise<number> {
    const rows = await client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM cost_alert_state
    `;
    return Number(rows[0]?.count ?? '0');
  }

  it('does nothing below threshold; no row, no push', async () => {
    // 79% of 1.50 = 1.185 — under the 80% threshold even with FP slack.
    await insertSpend(1.185);
    const push = spyPusher();
    const fired = await maybeFireCostAlert(db, push);
    expect(fired).toBe(false);
    expect(push.calls).toHaveLength(0);
    expect(await countAlertRows()).toBe(0);
  });

  it('fires once when spend crosses 80%; row inserted, push called once', async () => {
    await insertSpend(1.2); // exactly 80% of 1.50
    const push = spyPusher();
    const fired = await maybeFireCostAlert(db, push);
    expect(fired).toBe(true);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]).toMatch(/80\.0% of \$1\.50/);
    expect(await countAlertRows()).toBe(1);

    // pct_at_fire snapshot matches pctOfCeiling at the time of the
    // INSERT (0.8000 to 4 decimals).
    const rows = await client<{ pct_at_fire: string }[]>`
      SELECT pct_at_fire::text FROM cost_alert_state
    `;
    expect(Number(rows[0]?.pct_at_fire)).toBeCloseTo(0.8, 4);
  });

  it('does not re-fire on a second call the same UTC day', async () => {
    await insertSpend(1.3); // ~86.7%
    const push = spyPusher();
    await maybeFireCostAlert(db, push);
    expect(push.calls).toHaveLength(1);

    // Bump spend further — same UTC day. No second push.
    await insertSpend(0.1);
    const fired2 = await maybeFireCostAlert(db, push);
    expect(fired2).toBe(false);
    expect(push.calls).toHaveLength(1);
    expect(await countAlertRows()).toBe(1);
  });

  it('re-fires after the UTC day boundary rolls over', async () => {
    // Simulate yesterday's spend + a stale alert_state row by inserting
    // a row dated yesterday. After today's spend crosses threshold, the
    // ON CONFLICT (alert_day) guard MUST allow today's INSERT — the
    // pre-existing row is on a different date and shouldn't block.
    // (Pure SQL date math, no calendar literals — time-bomb-free.)
    await client.unsafe(`
      INSERT INTO cost_alert_state (alert_day, pct_at_fire)
      VALUES (((NOW() AT TIME ZONE 'UTC')::date - INTERVAL '1 day')::date, 0.9000)
    `);
    expect(await countAlertRows()).toBe(1);

    await insertSpend(1.25); // today's spend, ~83% — over threshold
    const push = spyPusher();
    const fired = await maybeFireCostAlert(db, push);

    expect(fired).toBe(true);
    expect(push.calls).toHaveLength(1);
    // Two rows now: yesterday's pre-existing row + today's fresh row.
    expect(await countAlertRows()).toBe(2);
  });

  it('rolls back the alert_state row when the push throws', async () => {
    await insertSpend(1.4); // ~93%
    const failingPusher: CostAlertPusher = vi.fn(async () => {
      throw new Error('telegram unreachable');
    });
    const fired = await maybeFireCostAlert(db, failingPusher);
    expect(fired).toBe(false);
    // Row was inserted then deleted — next call should be able to
    // re-claim it on a successful push.
    expect(await countAlertRows()).toBe(0);

    const goodPush = spyPusher();
    const fired2 = await maybeFireCostAlert(db, goodPush);
    expect(fired2).toBe(true);
    expect(goodPush.calls).toHaveLength(1);
    expect(await countAlertRows()).toBe(1);
  });
});
