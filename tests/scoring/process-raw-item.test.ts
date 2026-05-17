// Real-PG integration test for src/scoring/process-raw-item.ts.
// Resets schema, applies all migrations, then exercises processRawItem
// against live tables. Mirrors the pattern in tests/scoring/cluster.test.ts.
//
// The four paths an outcome can take are covered:
//   normal     — items row inserted, new cluster, processed_at set
//   dedup_hit  — no items row, raw_items.dedup_cluster_id set, cluster
//                bookkeeping NOT incremented (SPEC §7.2 step 2)
//   ceiling_hit — no DB writes at all (no cost rows, no items, no UPDATE)
//   failed     — attempts counter bumped, error stashed in raw_meta

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import { processRawItem } from '../../src/scoring/process-raw-item.js';
import type { NormalizeResult } from '../../src/scoring/normalize.js';
import type { EmbedResult } from '../../src/lib/embeddings.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

/** Build a 1536-dim unit-norm vector from a short prefix. Tail is zero. */
function mkVec(prefix: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i] ?? 0;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error('mkVec: zero-norm prefix');
  return v.map((x) => x / norm);
}

/** Build a NormalizeResult stub with a fixed primary domain + zero cost. */
function stubNormalizeResult(primaryDomain: 'economy' | 'scitech'): NormalizeResult {
  return {
    item: {
      summaryEn: 'A short summary that will get embedded.',
      contextEn: 'A short context paragraph that explains the why.',
      entities: ['Acme', 'Globex'],
      domains: [primaryDomain],
      primaryDomain,
      keywords: ['kw1', 'kw2', 'kw3'],
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

describe.skipIf(!DATABASE_URL)('processRawItem (Phase 2 per-item orchestrator)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

  const vA = mkVec([1]);
  // vNearA: cosine ~0.95 to vA → distance ~0.05 → above 0.93 similarity
  // threshold for semantic-dedup; will trigger the dedup-hit path.
  const vNearA = mkVec([0.95, Math.sqrt(1 - 0.95 * 0.95)]);
  // vFarFromA: cosine ~0.60 to vA → distance ~0.40 → well below dedup
  // threshold AND above the 0.30 cluster-join threshold, so it creates
  // its own fresh cluster.
  const vFarFromA = mkVec([0.6, 0.8]);

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
              'process-raw-item-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    // Order matters — items + dedup_cluster_id FK clusters.
    await client.unsafe('TRUNCATE TABLE items, candidates, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    await client.unsafe('TRUNCATE TABLE cost_ledger CASCADE');
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function insertRawItem(opts: { publishedAt?: Date; processingAttempts?: number } = {}): Promise<string> {
    const id = uuidv7();
    const publishedIso = (opts.publishedAt ?? new Date()).toISOString();
    await client`
      INSERT INTO raw_items (
        id, source_id, url, url_hash, title, title_hash, content, language,
        published_at, processing_attempts
      )
      VALUES (
        ${id}, ${sourceId}, ${`https://example.com/${id}`}, ${`u_${id}`},
        ${`title ${id}`}, ${`t_${id}`}, 'body', 'en',
        ${publishedIso}::timestamptz, ${opts.processingAttempts ?? 0}
      )
    `;
    return id;
  }

  /** Pre-seed an existing items + cluster pair so dedup tests can match against it. */
  async function seedItemAndCluster(opts: {
    embedding: number[];
    primaryDomain: string;
    publishedAt?: Date;
  }): Promise<{ itemId: string; clusterId: string }> {
    const clusterId = uuidv7();
    const itemId = uuidv7();
    const seedRawId = await insertRawItem({ publishedAt: opts.publishedAt });
    const vecLit = `[${opts.embedding.join(',')}]`;
    const publishedIso = (opts.publishedAt ?? new Date()).toISOString();
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (
        ${clusterId}, ${vecLit}::vector(1536),
        ${publishedIso}::timestamptz, ${publishedIso}::timestamptz,
        1, ARRAY[${opts.primaryDomain}]::text[], ${opts.primaryDomain}, 'active'
      )
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      )
      VALUES (
        ${itemId}, ${seedRawId}, 'seed', 'seed summary', 'seed context', 'en',
        ARRAY['SeedEnt']::text[], ARRAY['skw']::text[],
        ARRAY[${opts.primaryDomain}]::text[], ${opts.primaryDomain},
        ${vecLit}::vector(1536),
        ${publishedIso}::timestamptz,
        ${clusterId}
      )
    `;
    return { itemId, clusterId };
  }

  async function getRawItem(id: string): Promise<{
    processed_at: Date | null;
    dedup_cluster_id: string | null;
    processing_attempts: number;
    raw_meta: Record<string, unknown>;
  }> {
    const rows = await client<
      Array<{
        processed_at: Date | string | null;
        dedup_cluster_id: string | null;
        processing_attempts: number;
        raw_meta: Record<string, unknown>;
      }>
    >`SELECT processed_at, dedup_cluster_id, processing_attempts, raw_meta
       FROM raw_items WHERE id = ${id}`;
    const r = rows[0];
    if (!r) throw new Error(`raw_item ${id} not found`);
    return {
      processed_at: r.processed_at === null ? null : new Date(r.processed_at),
      dedup_cluster_id: r.dedup_cluster_id,
      processing_attempts: r.processing_attempts,
      raw_meta: r.raw_meta,
    };
  }

  async function countItems(rawItemId: string): Promise<number> {
    const rows = await client<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM items WHERE raw_item_id = ${rawItemId}
    `;
    return rows[0]?.n ?? 0;
  }

  async function countCostRows(): Promise<number> {
    const rows = await client<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM cost_ledger`;
    return rows[0]?.n ?? 0;
  }

  async function seedCostLedger(usd: number): Promise<void> {
    await client`
      INSERT INTO cost_ledger (id, occurred_at, model, input_tokens, output_tokens, usd, stage)
      VALUES (${uuidv7()}, NOW(), 'fixture', 0, 0, ${usd.toFixed(6)}, 'fixture')
    `;
  }

  // -------------------------------------------------------------------------
  // normal path
  // -------------------------------------------------------------------------

  it('normal path: inserts items + new cluster, marks raw_item processed, records cost', async () => {
    const rawId = await insertRawItem({ publishedAt: new Date('2026-05-15T10:00:00Z') });

    const outcome = await processRawItem(
      db,
      {
        id: rawId,
        title: 'something',
        content: 'body',
        language: 'en',
        publishedAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        normalize: async () => stubNormalizeResult('economy'),
        embed: async () => stubEmbedResult(vA),
      },
    );

    expect(outcome.kind).toBe('normal');
    if (outcome.kind !== 'normal') throw new Error('type-narrow');
    expect(outcome.isNewCluster).toBe(true);
    expect(outcome.itemId).toMatch(/^[0-9a-f-]{36}$/);

    // raw_item is now processed; attempts stays at 0 on success.
    const raw = await getRawItem(rawId);
    expect(raw.processed_at).toBeInstanceOf(Date);
    expect(raw.dedup_cluster_id).toBeNull();
    expect(raw.processing_attempts).toBe(0);

    // Exactly one items row, pointed at the new cluster.
    expect(await countItems(rawId)).toBe(1);
    const itemRows = await client<Array<{ cluster_id: string }>>`
      SELECT cluster_id FROM items WHERE raw_item_id = ${rawId}
    `;
    expect(itemRows[0]?.cluster_id).toBe(outcome.clusterId);

    // Both normalise + embed ledger rows present.
    const stages = await client<Array<{ stage: string }>>`
      SELECT stage FROM cost_ledger ORDER BY occurred_at ASC
    `;
    expect(stages.map((r) => r.stage)).toEqual(['normalise', 'embed']);
  });

  // -------------------------------------------------------------------------
  // dedup-hit path
  // -------------------------------------------------------------------------

  it('dedup-hit path: no items row, dedup_cluster_id stamped, cluster bookkeeping untouched', async () => {
    const seed = await seedItemAndCluster({
      embedding: vA,
      primaryDomain: 'economy',
      publishedAt: new Date('2026-05-15T08:00:00Z'),
    });

    const rawId = await insertRawItem({
      publishedAt: new Date('2026-05-15T10:00:00Z'),
    });

    const outcome = await processRawItem(
      db,
      {
        id: rawId,
        title: 'near-duplicate headline',
        content: 'body',
        language: 'en',
        publishedAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        normalize: async () => stubNormalizeResult('economy'),
        // Returns a vector ~0.95 cosine to the seeded item → dedup hits.
        embed: async () => stubEmbedResult(vNearA),
      },
    );

    expect(outcome.kind).toBe('dedup_hit');
    if (outcome.kind !== 'dedup_hit') throw new Error('type-narrow');
    expect(outcome.dedupItemId).toBe(seed.itemId);
    expect(outcome.dedupClusterId).toBe(seed.clusterId);
    expect(outcome.similarity).toBeGreaterThan(0.93);

    // raw_item marked processed with dedup pointer; NO new items row.
    const raw = await getRawItem(rawId);
    expect(raw.processed_at).toBeInstanceOf(Date);
    expect(raw.dedup_cluster_id).toBe(seed.clusterId);
    expect(raw.processing_attempts).toBe(0);
    expect(await countItems(rawId)).toBe(0);

    // Cluster bookkeeping must NOT increment — duplicates can't bias
    // downstream temperature / curation signals.
    const cluster = await client<Array<{ item_count: number }>>`
      SELECT item_count FROM clusters WHERE id = ${seed.clusterId}
    `;
    expect(cluster[0]?.item_count).toBe(1);

    // Cost rows still recorded — the LLM + embedding calls actually happened.
    expect(await countCostRows()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // cost-ceiling path
  // -------------------------------------------------------------------------

  it('ceiling-hit: short-circuits before normalise, leaves raw_item untouched', async () => {
    // Default COST_CEILING_DAILY_USD is 1.50; project 0.001 brings the check
    // to 1.499 + 0.001 >= 1.50 → trips. Pre-seed today's ledger at $1.499.
    await seedCostLedger(1.499);

    const rawId = await insertRawItem();

    let normalizeCalls = 0;
    let embedCalls = 0;
    const outcome = await processRawItem(
      db,
      {
        id: rawId,
        title: 'never processed',
        content: 'body',
        language: 'en',
        publishedAt: new Date(),
      },
      {
        normalize: async () => {
          normalizeCalls += 1;
          return stubNormalizeResult('economy');
        },
        embed: async () => {
          embedCalls += 1;
          return stubEmbedResult(vA);
        },
      },
    );

    expect(outcome.kind).toBe('ceiling_hit');
    expect(normalizeCalls).toBe(0);
    expect(embedCalls).toBe(0);

    // No DB writes outside the pre-seeded ledger row.
    const raw = await getRawItem(rawId);
    expect(raw.processed_at).toBeNull();
    expect(raw.processing_attempts).toBe(0);
    expect(raw.dedup_cluster_id).toBeNull();
    expect(await countItems(rawId)).toBe(0);
    expect(await countCostRows()).toBe(1); // only the fixture
  });

  // -------------------------------------------------------------------------
  // failure path
  // -------------------------------------------------------------------------

  it('failure: bumps processing_attempts, stamps raw_meta.last_processing_error, no items row', async () => {
    const rawId = await insertRawItem();

    const outcome = await processRawItem(
      db,
      {
        id: rawId,
        title: 'will fail',
        content: 'body',
        language: 'en',
        publishedAt: new Date(),
      },
      {
        normalize: async () => {
          throw new Error('boom — LLM returned garbage');
        },
        embed: async () => stubEmbedResult(vA),
      },
    );

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('type-narrow');
    expect(outcome.error.message).toMatch(/boom/);

    const raw = await getRawItem(rawId);
    expect(raw.processed_at).toBeNull();
    expect(raw.processing_attempts).toBe(1);
    expect(raw.dedup_cluster_id).toBeNull();
    expect(await countItems(rawId)).toBe(0);
    expect(raw.raw_meta).toMatchObject({
      last_processing_error: expect.stringMatching(/boom/) as unknown,
    });
  });

  it('failure path increments attempts cumulatively across calls', async () => {
    const rawId = await insertRawItem({ processingAttempts: 1 });

    const outcome = await processRawItem(
      db,
      {
        id: rawId,
        title: 't',
        content: 'b',
        language: 'en',
        publishedAt: new Date(),
      },
      {
        normalize: async () => {
          throw new Error('second failure');
        },
        embed: async () => stubEmbedResult(vA),
      },
    );

    expect(outcome.kind).toBe('failed');
    const raw = await getRawItem(rawId);
    expect(raw.processing_attempts).toBe(2);
  });

  // -------------------------------------------------------------------------
  // sanity: two non-dup raw items create two items rows in two clusters
  // -------------------------------------------------------------------------

  it('two non-dup raw_items produce two items and two clusters', async () => {
    const r1 = await insertRawItem();
    const r2 = await insertRawItem();

    const o1 = await processRawItem(
      db,
      { id: r1, title: 't1', content: 'b1', language: 'en', publishedAt: new Date() },
      { normalize: async () => stubNormalizeResult('economy'), embed: async () => stubEmbedResult(vA) },
    );
    const o2 = await processRawItem(
      db,
      { id: r2, title: 't2', content: 'b2', language: 'en', publishedAt: new Date() },
      { normalize: async () => stubNormalizeResult('economy'), embed: async () => stubEmbedResult(vFarFromA) },
    );

    expect(o1.kind).toBe('normal');
    expect(o2.kind).toBe('normal');
    if (o1.kind !== 'normal' || o2.kind !== 'normal') throw new Error('type-narrow');
    expect(o1.clusterId).not.toBe(o2.clusterId);

    const counts = await client<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM clusters`;
    expect(counts[0]?.n).toBe(2);
  });
});
