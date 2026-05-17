// Real-PG integration test for src/cost/ceiling.ts (SPEC §12
// enforcement). Mirrors the scoring/* test pattern: schema reset, all
// migrations applied, TRUNCATE between tests.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import {
  assertWithinCeiling,
  checkCeiling,
  CostCeilingHitError,
} from '../../src/cost/ceiling.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  // Pin ceiling + alert so tests are independent of operator settings.
  process.env.COST_CEILING_DAILY_USD = '1.50';
  process.env.COST_ALERT_THRESHOLD = '0.80';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe.skipIf(!DATABASE_URL)('cost ceiling (SPEC §12)', () => {
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
  });

  async function insertSpend(usd: number, occurredAt: Date = new Date()): Promise<void> {
    const id = uuidv7();
    const iso = occurredAt.toISOString();
    await client`
      INSERT INTO cost_ledger (id, model, input_tokens, output_tokens, usd, occurred_at)
      VALUES (${id}, 'claude-sonnet-4.5', 100, 50, ${usd.toFixed(6)}, ${iso}::timestamptz)
    `;
  }

  it('reports 0 spend / not-alert / not-hit on an empty ledger', async () => {
    const status = await checkCeiling(db);
    expect(status.spent).toBe(0);
    expect(status.ceiling).toBe(1.5);
    expect(status.alertThreshold).toBe(0.8);
    expect(status.pctOfCeiling).toBe(0);
    expect(status.atAlertThreshold).toBe(false);
    expect(status.hitCeiling).toBe(false);
  });

  it('sums only today\'s spend (UTC), ignoring rows from yesterday', async () => {
    await insertSpend(0.5);
    // Yesterday — should NOT count.
    await insertSpend(2.0, new Date(Date.now() - 36 * 3_600_000));
    const status = await checkCeiling(db);
    expect(status.spent).toBeCloseTo(0.5, 5);
  });

  it('flags atAlertThreshold once spend crosses 80% of ceiling', async () => {
    await insertSpend(1.2); // 80% of 1.50
    const status = await checkCeiling(db);
    expect(status.pctOfCeiling).toBeCloseTo(0.8, 5);
    expect(status.atAlertThreshold).toBe(true);
    expect(status.hitCeiling).toBe(false);
  });

  it('flags hitCeiling once spend reaches ceiling', async () => {
    await insertSpend(1.5);
    const status = await checkCeiling(db);
    expect(status.pctOfCeiling).toBeCloseTo(1.0, 5);
    expect(status.atAlertThreshold).toBe(true);
    expect(status.hitCeiling).toBe(true);
  });

  it('assertWithinCeiling passes when spent + projected < ceiling', async () => {
    await insertSpend(0.5);
    const status = await assertWithinCeiling(db, 0.5);
    expect(status.spent).toBeCloseTo(0.5);
    // Status reflects PRE-call spend, not post-call.
    expect(status.atAlertThreshold).toBe(false);
  });

  it('assertWithinCeiling throws CostCeilingHitError when spent + projected >= ceiling', async () => {
    await insertSpend(1.0);
    let caught: CostCeilingHitError | null = null;
    try {
      await assertWithinCeiling(db, 0.6);
    } catch (err) {
      caught = err as CostCeilingHitError;
    }
    expect(caught).toBeInstanceOf(CostCeilingHitError);
    expect(caught?.code).toBe('cost_ceiling_hit');
    expect(caught?.spent).toBeCloseTo(1.0);
    expect(caught?.projected).toBeCloseTo(0.6);
    expect(caught?.ceiling).toBe(1.5);
  });

  it('treats spent + projected EXACTLY equal to ceiling as a hit', async () => {
    await insertSpend(1.0);
    // 1.0 + 0.5 = 1.50 — the boundary case. SPEC §12 is "hard ceiling",
    // so the equal case denies the call.
    await expect(assertWithinCeiling(db, 0.5)).rejects.toBeInstanceOf(
      CostCeilingHitError,
    );
  });

  it('throws on negative / non-finite projected (programmer error)', async () => {
    await expect(assertWithinCeiling(db, -0.01)).rejects.toThrow(
      /non-negative finite/,
    );
    await expect(assertWithinCeiling(db, Number.NaN)).rejects.toThrow(
      /non-negative finite/,
    );
  });

  it('honours env override on ceiling and alert threshold', async () => {
    process.env.COST_CEILING_DAILY_USD = '0.50';
    process.env.COST_ALERT_THRESHOLD = '0.50';
    await insertSpend(0.30);
    const status = await checkCeiling(db);
    expect(status.ceiling).toBe(0.5);
    expect(status.alertThreshold).toBe(0.5);
    expect(status.pctOfCeiling).toBeCloseTo(0.6, 5);
    expect(status.atAlertThreshold).toBe(true);
  });
});
