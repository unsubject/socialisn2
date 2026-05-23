// Real-PG integration test for src/lib/status.ts. Seeds runs +
// cost_ledger + raw_items + items + clusters, then asserts the
// buildStatus shape.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import {
  buildStatus,
  STATUS_SNAPSHOT_VERSION,
} from '../../src/lib/status.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Pin ceiling/alert so cost expectations don't depend on operator env.
  process.env.COST_CEILING_DAILY_USD = '1.50';
  process.env.COST_ALERT_THRESHOLD = '0.80';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe.skipIf(!DATABASE_URL)('buildStatus (src/lib/status.ts)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, file), 'utf-8'));
    }
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'status-test-source', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE cost_ledger, items, clusters, raw_items, runs CASCADE',
    );
  });

  async function seedRun(opts: {
    kind?: string;
    status?: string;
    startedAt?: Date;
    completedAt?: Date | null;
    candidatesCount?: number | null;
    totalCostUsd?: string | null;
    error?: string | null;
  } = {}): Promise<string> {
    const id = uuidv7();
    // Relative offsets only — no hardcoded calendar dates. Memory:
    // PR #76 fixed time-bomb literals in cluster.test.ts.
    const started = opts.startedAt ?? new Date();
    const completed = opts.completedAt === undefined ? new Date() : opts.completedAt;
    await client`
      INSERT INTO runs (
        id, kind, status, started_at, completed_at,
        candidates_count, total_cost_usd, error
      ) VALUES (
        ${id},
        ${opts.kind ?? 'morning'},
        ${opts.status ?? 'completed'},
        ${started.toISOString()}::timestamptz,
        ${completed ? completed.toISOString() : null}::timestamptz,
        ${opts.candidatesCount ?? null},
        ${opts.totalCostUsd ?? null},
        ${opts.error ?? null}
      )
    `;
    return id;
  }

  async function seedSpend(usd: number, occurredAt: Date = new Date()): Promise<void> {
    await client`
      INSERT INTO cost_ledger (id, model, input_tokens, output_tokens, usd, occurred_at)
      VALUES (${uuidv7()}, 'claude-sonnet-4.5', 10, 5, ${usd.toFixed(6)},
              ${occurredAt.toISOString()}::timestamptz)
    `;
  }

  async function seedRawItem(opts: {
    processedAt?: Date | null;
    processingAttempts?: number;
  } = {}): Promise<string> {
    const id = uuidv7();
    const processedAt =
      opts.processedAt === undefined ? null : opts.processedAt?.toISOString() ?? null;
    await client`
      INSERT INTO raw_items (
        id, source_id, url, url_hash, title, title_hash, published_at,
        processed_at, processing_attempts
      ) VALUES (
        ${id}, ${sourceId},
        ${'https://example.com/article/' + id},
        ${'uh_' + id},
        ${'Article ' + id},
        ${'th_' + id},
        NOW(),
        ${processedAt}::timestamptz,
        ${opts.processingAttempts ?? 0}
      )
    `;
    return id;
  }

  async function seedClusterWithItem(opts: {
    status?: 'active' | 'archived' | 'merged';
  } = {}): Promise<{ clusterId: string; rawItemId: string }> {
    const clusterId = uuidv7();
    const vec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (
        id, centroid, first_seen_at, last_seen_at, item_count,
        domains, primary_domain, status
      ) VALUES (
        ${clusterId}, ${vec}::vector(1536),
        NOW(), NOW(), 1,
        ARRAY['economy']::text[], 'economy',
        ${opts.status ?? 'active'}
      )
    `;
    const rawItemId = await seedRawItem({ processedAt: new Date() });
    const itemVec = `[${new Array(1536).fill(0.002).join(',')}]`;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en,
        language_original, entities, keywords, domains, primary_domain,
        embedding, published_at, cluster_id
      ) VALUES (
        ${uuidv7()}, ${rawItemId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['Ent']::text[], ARRAY['kw']::text[],
        ARRAY['economy']::text[], 'economy',
        ${itemVec}::vector(1536),
        NOW(), ${clusterId}
      )
    `;
    return { clusterId, rawItemId };
  }

  it('returns the empty-system snapshot when nothing has been seeded', async () => {
    const snap = await buildStatus(db);
    expect(snap.version).toBe(STATUS_SNAPSHOT_VERSION);
    expect(snap.last_run).toBeNull();
    expect(snap.queue.pending_raw_items).toBe(0);
    expect(snap.runs_today.total).toBe(0);
    expect(snap.runs_today.failed).toBe(0);
    expect(snap.cost.spent).toBe(0);
    expect(snap.cost.ceiling).toBe(1.5);
    expect(snap.cost.atAlertThreshold).toBe(false);
    expect(snap.phase2_stats).toEqual({
      raw_items_total: 0,
      raw_items_processed: 0,
      raw_items_failed_3x: 0,
      items_total: 0,
      clusters_active: 0,
    });
  });

  it('taken_at is a fresh ISO-8601 timestamp', async () => {
    const before = Date.now();
    const snap = await buildStatus(db);
    const after = Date.now();
    const t = Date.parse(snap.taken_at);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('last_run reflects the most recently started run', async () => {
    // started 2h ago — should NOT win
    await seedRun({
      kind: 'manual',
      status: 'completed',
      startedAt: new Date(Date.now() - 2 * 3_600_000),
      candidatesCount: 3,
    });
    // started now — winner
    const winnerId = await seedRun({
      kind: 'morning',
      status: 'running',
      startedAt: new Date(),
      completedAt: null,
      candidatesCount: null,
    });
    const snap = await buildStatus(db);
    expect(snap.last_run?.id).toBe(winnerId);
    expect(snap.last_run?.kind).toBe('morning');
    expect(snap.last_run?.status).toBe('running');
    expect(snap.last_run?.completed_at).toBeNull();
  });

  it('cost.spent sums only today (UTC), ignoring yesterday', async () => {
    await seedSpend(0.5);
    // 36h ago — outside the UTC-day window.
    await seedSpend(2.0, new Date(Date.now() - 36 * 3_600_000));
    const snap = await buildStatus(db);
    expect(snap.cost.spent).toBeCloseTo(0.5, 5);
    expect(snap.cost.atAlertThreshold).toBe(false);
  });

  it('cost.atAlertThreshold flips true once spend crosses 80%', async () => {
    await seedSpend(1.2); // 80% of 1.50 — FP-fragile boundary; ceiling.ts applies COMPARISON_EPSILON
    const snap = await buildStatus(db);
    expect(snap.cost.atAlertThreshold).toBe(true);
    expect(snap.cost.hitCeiling).toBe(false);
  });

  it('queue.pending_raw_items counts NULL processed_at AND attempts<3', async () => {
    await seedRawItem({ processedAt: null, processingAttempts: 0 });   // counts
    await seedRawItem({ processedAt: null, processingAttempts: 2 });   // counts
    await seedRawItem({ processedAt: null, processingAttempts: 3 });   // capped — doesn't count
    await seedRawItem({ processedAt: new Date(), processingAttempts: 1 }); // processed — doesn't count
    const snap = await buildStatus(db);
    expect(snap.queue.pending_raw_items).toBe(2);
  });

  it('runs_today counts today-only runs and isolates failures', async () => {
    await seedRun({ status: 'completed', startedAt: new Date() });
    await seedRun({ status: 'failed', startedAt: new Date(Date.now() - 60_000) });
    await seedRun({ status: 'running', startedAt: new Date(Date.now() - 120_000) });
    // 36h ago — outside today
    await seedRun({ status: 'failed', startedAt: new Date(Date.now() - 36 * 3_600_000) });
    const snap = await buildStatus(db);
    expect(snap.runs_today.total).toBe(3);
    expect(snap.runs_today.failed).toBe(1);
  });

  it('phase2_stats counts raw_items / items / clusters across the full pipeline', async () => {
    // 4 raw_items distributed across the four states the field captures:
    await seedRawItem({ processedAt: new Date(), processingAttempts: 1 });   // processed
    await seedRawItem({ processedAt: new Date(), processingAttempts: 0 });   // processed
    await seedRawItem({ processedAt: null, processingAttempts: 3 });         // failed_3x
    await seedRawItem({ processedAt: null, processingAttempts: 1 });         // pending (in queue)

    // 2 items + 2 clusters (1 active, 1 archived). seedClusterWithItem also
    // inserts a fresh processed raw_item per call, so we'll have 4+2=6 raw_items_total.
    await seedClusterWithItem({ status: 'active' });
    await seedClusterWithItem({ status: 'archived' });

    const snap = await buildStatus(db);
    expect(snap.phase2_stats).toEqual({
      raw_items_total: 6,
      raw_items_processed: 4,   // 2 explicit + 2 from seedClusterWithItem
      raw_items_failed_3x: 1,
      items_total: 2,
      clusters_active: 1,
    });
    // Sanity: pending_raw_items only sees attempts<3 and processed_at NULL
    expect(snap.queue.pending_raw_items).toBe(1);
  });

  it('result is JSON-serialisable end-to-end (ops-digest contract)', async () => {
    await seedRun({ candidatesCount: 5, totalCostUsd: '0.1234' });
    await seedSpend(0.3);
    await seedRawItem({});
    const snap = await buildStatus(db);
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(STATUS_SNAPSHOT_VERSION);
    expect(parsed.last_run.candidates_count).toBe(5);
    expect(parsed.queue.pending_raw_items).toBe(1);
    expect(parsed.phase2_stats).toBeDefined();
    expect(typeof parsed.phase2_stats.raw_items_total).toBe('number');
  });
});
