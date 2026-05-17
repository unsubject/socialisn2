// Real-PG integration test for src/workers/scoring-core.ts tickOnce +
// compactOnce. Resets schema, applies all migrations, then drives the
// worker's exported helpers against live tables. Mirrors the pattern in
// tests/scoring/cluster.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import type { NormalizeResult } from '../../src/scoring/normalize.js';
import type { EmbedResult } from '../../src/lib/embeddings.js';
import { compactOnce, tickOnce } from '../../src/workers/scoring-core.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function mkVec(prefix: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i] ?? 0;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error('mkVec: zero-norm prefix');
  return v.map((x) => x / norm);
}

function stubNormalizeResult(domain: 'economy' | 'scitech' = 'economy'): NormalizeResult {
  return {
    item: {
      summaryEn: 'summary',
      contextEn: 'context',
      entities: ['Ent'],
      domains: [domain],
      primaryDomain: domain,
      keywords: ['a', 'b', 'c'],
    },
    llm: {
      text: 'unused',
      inputTokens: 100,
      outputTokens: 50,
      usd: 0.0006,
      model: 'gemini-2.5-flash-lite',
    },
  };
}

function stubEmbedResult(vector: number[]): EmbedResult {
  return { vectors: [vector], inputTokens: 80, usd: 0.0000016 };
}

describe.skipIf(!DATABASE_URL)('scoring-worker tickOnce / compactOnce', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

  const vA = mkVec([1]);
  const vB = mkVec([0.95, Math.sqrt(1 - 0.95 * 0.95)]); // d(A,B) ≈ 0.05
  const vC = mkVec([0.6, 0.8]); // d(A,C) ≈ 0.4

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

    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'worker-scoring-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE items, candidates, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    await client.unsafe('TRUNCATE TABLE cost_ledger CASCADE');
  });

  async function insertRawItem(opts: {
    fetchedAt?: Date;
    processingAttempts?: number;
    processedAt?: Date | null;
  } = {}): Promise<string> {
    const id = uuidv7();
    const fetchedIso = (opts.fetchedAt ?? new Date()).toISOString();
    const publishedIso = new Date().toISOString();
    await client`
      INSERT INTO raw_items (
        id, source_id, url, url_hash, title, title_hash, content, language,
        published_at, fetched_at, processing_attempts, processed_at
      )
      VALUES (
        ${id}, ${sourceId}, ${`https://example.com/${id}`}, ${`u_${id}`},
        ${`t ${id}`}, ${`h_${id}`}, 'body', 'en',
        ${publishedIso}::timestamptz, ${fetchedIso}::timestamptz,
        ${opts.processingAttempts ?? 0},
        ${opts.processedAt ? opts.processedAt.toISOString() : null}
      )
    `;
    return id;
  }

  async function seedCostLedger(usd: number): Promise<void> {
    await client`
      INSERT INTO cost_ledger (id, occurred_at, model, input_tokens, output_tokens, usd, stage)
      VALUES (${uuidv7()}, NOW(), 'fixture', 0, 0, ${usd.toFixed(6)}, 'fixture')
    `;
  }

  async function insertClusterWithItem(opts: {
    embedding: number[];
    primaryDomain: string;
    itemCount: number;
    entities: string[];
  }): Promise<string> {
    const cId = uuidv7();
    const vecLit = `[${opts.embedding.join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (
        ${cId}, ${vecLit}::vector(1536),
        NOW(), NOW(), ${opts.itemCount},
        ARRAY[${opts.primaryDomain}]::text[], ${opts.primaryDomain}, 'active'
      )
    `;
    const rawId = await insertRawItem({ processedAt: new Date() });
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      )
      VALUES (
        ${uuidv7()}, ${rawId}, 'seed', 'sum', 'ctx', 'en',
        ${opts.entities}::text[], ARRAY['kw']::text[],
        ARRAY[${opts.primaryDomain}]::text[], ${opts.primaryDomain},
        ${vecLit}::vector(1536),
        NOW(), ${cId}
      )
    `;
    return cId;
  }

  // -------------------------------------------------------------------------
  // tickOnce
  // -------------------------------------------------------------------------

  it('tickOnce pulls pending rows FIFO and processes each', async () => {
    // Insert three rows out-of-order of fetched_at so the FIFO ordering
    // matters for the assertion. Relative-to-NOW timestamps keep this
    // independent of the calendar.
    const now = Date.now();
    const oldest = await insertRawItem({
      fetchedAt: new Date(now - 3 * 60 * 60 * 1000),
    });
    const middle = await insertRawItem({
      fetchedAt: new Date(now - 2 * 60 * 60 * 1000),
    });
    const newest = await insertRawItem({
      fetchedAt: new Date(now - 1 * 60 * 60 * 1000),
    });

    const stats = await tickOnce(db, {
      batchSize: 20,
      maxAttempts: 3,
      deps: {
        normalize: async () => stubNormalizeResult('economy'),
        // Each row gets a distinct vector so they create separate clusters
        // (no accidental dedup hit changing the path).
        embed: async () => {
          const v = mkVec([Math.random(), Math.random(), Math.random()]);
          return stubEmbedResult(v);
        },
      },
    });

    // Pull order should be oldest → middle → newest.
    const processed = await client<Array<{ id: string }>>`
      SELECT id FROM raw_items
      WHERE processed_at IS NOT NULL
      ORDER BY processed_at ASC
    `;
    expect(processed.map((r) => r.id)).toEqual([oldest, middle, newest]);

    expect(stats.pulled).toBe(3);
    expect(stats.normalProcessed).toBe(3);
    expect(stats.dedupProcessed).toBe(0);
    expect(stats.failures).toBe(0);
    expect(stats.ceilingHit).toBe(false);
    expect(stats.costUsd).toBeGreaterThan(0);
  });

  it('tickOnce respects batchSize', async () => {
    for (let i = 0; i < 5; i++) await insertRawItem();
    const stats = await tickOnce(db, {
      batchSize: 2,
      maxAttempts: 3,
      deps: {
        normalize: async () => stubNormalizeResult('economy'),
        embed: async () => stubEmbedResult(mkVec([Math.random()])),
      },
    });
    expect(stats.pulled).toBe(2);
    expect(stats.normalProcessed).toBe(2);
  });

  it('tickOnce skips rows whose processing_attempts >= maxAttempts (poison row)', async () => {
    const live = await insertRawItem({ processingAttempts: 0 });
    const poisoned = await insertRawItem({ processingAttempts: 3 });

    const stats = await tickOnce(db, {
      batchSize: 20,
      maxAttempts: 3,
      deps: {
        normalize: async () => stubNormalizeResult('economy'),
        embed: async () => stubEmbedResult(mkVec([Math.random()])),
      },
    });

    expect(stats.pulled).toBe(1);
    expect(stats.normalProcessed).toBe(1);

    const liveRow = await client<Array<{ processed_at: Date | string | null }>>`
      SELECT processed_at FROM raw_items WHERE id = ${live}
    `;
    expect(liveRow[0]?.processed_at).not.toBeNull();
    const poisonedRow = await client<Array<{ processed_at: Date | string | null }>>`
      SELECT processed_at FROM raw_items WHERE id = ${poisoned}
    `;
    expect(poisonedRow[0]?.processed_at).toBeNull();
  });

  it('tickOnce short-circuits on ceiling_hit; remaining rows untouched', async () => {
    // Seed AT the default $1.50 ceiling so the +$0.001 projection
    // unambiguously trips. Avoids dancing around FP precision near the
    // boundary; the test cares about behaviour, not threshold arithmetic.
    await seedCostLedger(1.5);
    const r1 = await insertRawItem({
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const r2 = await insertRawItem({
      fetchedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });

    const stats = await tickOnce(db, {
      batchSize: 20,
      maxAttempts: 3,
      deps: {
        normalize: async () => stubNormalizeResult('economy'),
        embed: async () => stubEmbedResult(vA),
      },
    });

    expect(stats.ceilingHit).toBe(true);
    expect(stats.pulled).toBe(2); // both fetched
    expect(stats.normalProcessed).toBe(0);
    expect(stats.dedupProcessed).toBe(0);

    // Neither row should have been processed — attempts left at 0 since
    // ceiling_hit short-circuits BEFORE normalise.
    const rows = await client<Array<{ id: string; processed_at: Date | string | null; processing_attempts: number }>>`
      SELECT id, processed_at, processing_attempts FROM raw_items
      WHERE id IN (${r1}, ${r2})
    `;
    for (const r of rows) {
      expect(r.processed_at).toBeNull();
      expect(r.processing_attempts).toBe(0);
    }
  });

  it('tickOnce reports stats.failures when a row fails normalization', async () => {
    await insertRawItem();
    let calls = 0;
    const stats = await tickOnce(db, {
      batchSize: 20,
      maxAttempts: 3,
      deps: {
        normalize: async () => {
          calls += 1;
          throw new Error('forced failure');
        },
        embed: async () => stubEmbedResult(vA),
      },
    });
    expect(calls).toBe(1);
    expect(stats.pulled).toBe(1);
    expect(stats.failures).toBe(1);
    expect(stats.normalProcessed).toBe(0);
  });

  it('tickOnce returns zero-stats when no pending rows exist', async () => {
    const stats = await tickOnce(db, {
      batchSize: 20,
      maxAttempts: 3,
      deps: {
        normalize: async () => stubNormalizeResult('economy'),
        embed: async () => stubEmbedResult(vA),
      },
    });
    expect(stats).toMatchObject({
      pulled: 0,
      normalProcessed: 0,
      dedupProcessed: 0,
      failures: 0,
      ceilingHit: false,
      costUsd: 0,
    });
  });

  // -------------------------------------------------------------------------
  // compactOnce
  // -------------------------------------------------------------------------

  it('compactOnce merges close clusters with shared entities', async () => {
    const cA = await insertClusterWithItem({
      embedding: vA,
      primaryDomain: 'economy',
      itemCount: 5,
      entities: ['Fed'],
    });
    const cB = await insertClusterWithItem({
      embedding: vB,
      primaryDomain: 'economy',
      itemCount: 2,
      entities: ['Fed', 'Powell'],
    });

    const result = await compactOnce(db);
    expect(result.merges).toBe(1);

    const sourceRow = await client<Array<{ status: string }>>`
      SELECT status FROM clusters WHERE id = ${cB}
    `;
    expect(sourceRow[0]?.status).toBe('merged');
    const targetRow = await client<Array<{ item_count: number }>>`
      SELECT item_count FROM clusters WHERE id = ${cA}
    `;
    expect(targetRow[0]?.item_count).toBe(7);
  });

  it('compactOnce returns zero merges when no candidates qualify', async () => {
    await insertClusterWithItem({
      embedding: vA,
      primaryDomain: 'economy',
      itemCount: 3,
      entities: ['Fed'],
    });
    await insertClusterWithItem({
      embedding: vC, // d(A,C) ≈ 0.4 — above compaction threshold (0.15)
      primaryDomain: 'economy',
      itemCount: 3,
      entities: ['Fed'],
    });
    const result = await compactOnce(db);
    expect(result.merges).toBe(0);
  });
});
