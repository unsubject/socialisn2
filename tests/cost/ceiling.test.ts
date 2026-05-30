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
import {
  BUCKET_NORMALIZE,
  BUCKET_ORCHESTRATOR,
} from '../../src/cost/buckets.js';
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
    await insertSpend(1.2); // 80% of 1.50 — FP-fragile (1.2/1.5 = 0.7999…)
    const status = await checkCeiling(db);
    expect(status.pctOfCeiling).toBeCloseTo(0.8, 5);
    expect(status.atAlertThreshold).toBe(true);
    expect(status.hitCeiling).toBe(false);
  });

  it('atAlertThreshold tolerates IEEE 754 sub-ulp slack at the boundary', async () => {
    // Regression guard: 1.2 / 1.5 = 0.7999999999999999. Without
    // COMPARISON_EPSILON the pct >= 0.8 check is one ulp short of true
    // and the alert silently fails to fire at the configured threshold.
    process.env.COST_ALERT_THRESHOLD = '0.8';
    await insertSpend(1.2);
    const status = await checkCeiling(db);
    expect(status.pctOfCeiling < 0.8).toBe(true); // confirms the FP gap exists
    expect(status.atAlertThreshold).toBe(true);  // epsilon makes it pass anyway
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
    // Phase 3: code is now scope-suffixed so the orchestrator's
    // `halt.reason = err.code` path carries the tier into runs.error.
    // Without a bucket arg, scope defaults to 'daily'.
    expect(caught?.code).toBe('cost_ceiling_hit:daily');
    expect(caught?.scope).toBe('daily');
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

  // -------------------------------------------------------------------------
  // Phase 3: per-bucket sub-budgets
  // -------------------------------------------------------------------------

  async function insertSpendInBucket(
    usd: number,
    bucket: 'normalize' | 'orchestrator',
    stage: string,
  ): Promise<void> {
    const id = uuidv7();
    await client`
      INSERT INTO cost_ledger
        (id, model, input_tokens, output_tokens, usd, stage, bucket)
      VALUES
        (${id}, 'test-model', 100, 50, ${usd.toFixed(6)}, ${stage}, ${bucket})
    `;
  }

  it('assertWithinCeiling(bucket) trips the bucket-specific ceiling before the overall daily ceiling', async () => {
    // Overall ceiling at $1.50. Set the orchestrator sub-budget to a
    // tight $0.30 absolute so we can drive the bucket-trip path
    // independently of the default-from-pct calc.
    process.env.COST_CEILING_ORCHESTRATOR_DAILY_USD = '0.30';
    await insertSpendInBucket(0.25, BUCKET_ORCHESTRATOR, 'stage6_curate');

    let caught: CostCeilingHitError | null = null;
    try {
      // Projected 0.10 → bucket total 0.35 ≥ 0.30 → bucket trips.
      // Overall total 0.25 + 0.10 = 0.35 ≪ overall 1.50 → would NOT trip
      // overall. The bucket scope is what catches it.
      await assertWithinCeiling(db, 0.1, BUCKET_ORCHESTRATOR);
    } catch (err) {
      caught = err as CostCeilingHitError;
    }
    expect(caught).toBeInstanceOf(CostCeilingHitError);
    expect(caught?.scope).toBe(BUCKET_ORCHESTRATOR);
    // Load-bearing for the operator signal: err.code must include the
    // scope so the orchestrator's halt.reason = err.code path threads
    // it into runs.error. Without this, ops only sees the generic
    // 'cost_ceiling_hit' with no clue WHICH tier ran away.
    expect(caught?.code).toBe(`cost_ceiling_hit:${BUCKET_ORCHESTRATOR}`);
    expect(caught?.ceiling).toBe(0.3);
    expect(caught?.spent).toBeCloseTo(0.25, 5);
  });

  it('assertWithinCeiling(bucket) passes through to the daily check when the bucket sub-budget is fine', async () => {
    process.env.COST_CEILING_NORMALIZE_DAILY_USD = '5.00';
    // Bucket spend well under 5.00. Daily spend 1.0 + projected 0.6 = 1.6 ≥ 1.5 → daily trips.
    await insertSpend(1.0);
    let caught: CostCeilingHitError | null = null;
    try {
      await assertWithinCeiling(db, 0.6, BUCKET_NORMALIZE);
    } catch (err) {
      caught = err as CostCeilingHitError;
    }
    expect(caught).toBeInstanceOf(CostCeilingHitError);
    expect(caught?.scope).toBe('daily');
  });

  it('default bucket ceiling = pct of overall when env override is unset', async () => {
    // No override on COST_CEILING_NORMALIZE_DAILY_USD; default = 60% of
    // COST_CEILING_DAILY_USD=1.50 → 0.90. Insert 0.85 into normalize +
    // try to add 0.10 → bucket would land at 0.95 ≥ 0.90.
    delete process.env.COST_CEILING_NORMALIZE_DAILY_USD;
    await insertSpendInBucket(0.85, BUCKET_NORMALIZE, 'normalise');
    let caught: CostCeilingHitError | null = null;
    try {
      await assertWithinCeiling(db, 0.10, BUCKET_NORMALIZE);
    } catch (err) {
      caught = err as CostCeilingHitError;
    }
    expect(caught).toBeInstanceOf(CostCeilingHitError);
    expect(caught?.scope).toBe(BUCKET_NORMALIZE);
    expect(caught?.ceiling).toBeCloseTo(0.9, 5);
  });

  it('no-bucket call preserves pre-Phase-3 behavior (overall ceiling only)', async () => {
    // Heavy bucket spend in normalize. Without a bucket arg, the call
    // should ONLY check daily — and pass, since 0.50 + 0.10 < 1.50.
    process.env.COST_CEILING_NORMALIZE_DAILY_USD = '0.20';
    await insertSpendInBucket(0.5, BUCKET_NORMALIZE, 'normalise');
    const status = await assertWithinCeiling(db, 0.1); // no bucket
    expect(status.spent).toBeCloseTo(0.5);
  });
});
