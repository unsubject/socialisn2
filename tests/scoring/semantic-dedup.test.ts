// Real-PG integration test for src/scoring/semantic-dedup.ts (SPEC §7.2
// step 2). Resets schema, applies all migrations, then exercises
// findSemanticDuplicate against a live `items` table. Same pattern as
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
import { findSemanticDuplicate } from '../../src/scoring/semantic-dedup.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

/** Build a 1536-dim unit-norm vector from a short prefix. Remainder is zero. */
function mkVec(prefix: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i] ?? 0;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error('mkVec: zero-norm prefix');
  return v.map((x) => x / norm);
}

describe.skipIf(!DATABASE_URL)('semantic dedup (SPEC §7.2 step 2)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

  // Vectors used across tests. With similarity threshold 0.93 (distance ≤ 0.07):
  //   - vA ↔ vNear:   cosine 0.95 → DUPLICATE
  //   - vA ↔ vBorder: cosine ~0.92 → NOT duplicate (just below threshold)
  //   - vA ↔ vFar:    cosine 0.60 → NOT duplicate
  const vA = mkVec([1]);
  const vNear = mkVec([0.95, Math.sqrt(1 - 0.95 * 0.95)]);
  const vBorder = mkVec([0.92, Math.sqrt(1 - 0.92 * 0.92)]);
  const vFar = mkVec([0.6, Math.sqrt(1 - 0.6 * 0.6)]);

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
              'dedup-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    // Order matters — items FKs clusters, gdelt_coverage FKs clusters.
    await client.unsafe('TRUNCATE TABLE items, candidates, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function insertRawItem(opts: { publishedAt?: Date } = {}): Promise<string> {
    const id = uuidv7();
    const publishedIso = (opts.publishedAt ?? new Date()).toISOString();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${id}, ${sourceId}, ${`https://example.com/${id}`},
              ${`u_${id}`}, ${`title ${id}`}, ${`t_${id}`},
              ${publishedIso}::timestamptz)
    `;
    return id;
  }

  /** Insert an items row. cluster_id is optional — schema allows it null. */
  async function insertItem(opts: {
    embedding: number[];
    primaryDomain: string;
    publishedAt?: Date;
    clusterId?: string | null;
  }): Promise<string> {
    const id = uuidv7();
    const rawId = await insertRawItem({ publishedAt: opts.publishedAt });
    const vecLit = `[${opts.embedding.join(',')}]`;
    const publishedIso = (opts.publishedAt ?? new Date()).toISOString();
    const clusterId = opts.clusterId ?? null;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, domains, primary_domain, keywords, embedding, published_at, cluster_id
      )
      VALUES (
        ${id}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['Fed']::text[],
        ARRAY[${opts.primaryDomain}]::text[],
        ${opts.primaryDomain},
        ARRAY['kw']::text[],
        ${vecLit}::vector(1536),
        ${publishedIso}::timestamptz,
        ${clusterId}
      )
    `;
    return id;
  }

  async function insertCluster(opts: {
    embedding: number[];
    primaryDomain: string;
  }): Promise<string> {
    const id = uuidv7();
    const vecLit = `[${opts.embedding.join(',')}]`;
    const now = new Date().toISOString();
    await client`
      INSERT INTO clusters (
        id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status
      )
      VALUES (
        ${id}, ${vecLit}::vector(1536),
        ${now}::timestamptz, ${now}::timestamptz,
        1,
        ARRAY[${opts.primaryDomain}]::text[],
        ${opts.primaryDomain},
        'active'
      )
    `;
    return id;
  }

  // -------------------------------------------------------------------------
  // tests
  // -------------------------------------------------------------------------

  it('returns null when no items exist', async () => {
    const result = await findSemanticDuplicate(db, {
      embedding: vA,
      primaryDomain: 'economy',
    });
    expect(result).toBeNull();
  });

  it('returns null when no item shares the primary_domain', async () => {
    await insertItem({ embedding: vA, primaryDomain: 'scitech' });
    const result = await findSemanticDuplicate(db, {
      embedding: vA, // identical embedding but different domain
      primaryDomain: 'economy',
    });
    expect(result).toBeNull();
  });

  it('returns null when nearest similarity is below threshold', async () => {
    await insertItem({ embedding: vBorder, primaryDomain: 'economy' });
    // vA vs vBorder cosine ≈ 0.92 → below 0.93 default → no duplicate.
    const result = await findSemanticDuplicate(db, {
      embedding: vA,
      primaryDomain: 'economy',
    });
    expect(result).toBeNull();
  });

  it('returns the match when similarity is at or above threshold', async () => {
    const existing = await insertItem({ embedding: vNear, primaryDomain: 'economy' });
    const result = await findSemanticDuplicate(db, {
      embedding: vA, // vA vs vNear cosine 0.95 → duplicate
      primaryDomain: 'economy',
    });
    expect(result).not.toBeNull();
    expect(result?.itemId).toBe(existing);
    expect(result?.similarity).toBeGreaterThanOrEqual(0.93);
    expect(result?.distance).toBeLessThanOrEqual(0.07);
  });

  it('returns the nearest of multiple candidates', async () => {
    // Insert one near (cosine 0.95) and one identical (cosine 1.0).
    // Identical should win.
    await insertItem({ embedding: vNear, primaryDomain: 'economy' });
    const identical = await insertItem({ embedding: vA, primaryDomain: 'economy' });

    const result = await findSemanticDuplicate(db, {
      embedding: vA,
      primaryDomain: 'economy',
    });
    expect(result?.itemId).toBe(identical);
    expect(result?.similarity).toBeGreaterThan(0.999);
  });

  it('respects the 7-day recency window', async () => {
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await insertItem({
      embedding: vA,
      primaryDomain: 'economy',
      publishedAt: stale,
    });
    const result = await findSemanticDuplicate(db, {
      embedding: vA, // identical, but the existing item is older than the window
      primaryDomain: 'economy',
    });
    expect(result).toBeNull();
  });

  it('respects a caller-supplied threshold override (looser)', async () => {
    const borderItem = await insertItem({ embedding: vBorder, primaryDomain: 'economy' });
    // At 0.93 default vBorder is below threshold; at 0.90 it qualifies.
    const result = await findSemanticDuplicate(
      db,
      { embedding: vA, primaryDomain: 'economy' },
      { similarityThreshold: 0.90 },
    );
    expect(result?.itemId).toBe(borderItem);
  });

  it('returns the cluster_id when the matched item is clustered', async () => {
    const cluster = await insertCluster({ embedding: vA, primaryDomain: 'economy' });
    await insertItem({
      embedding: vNear,
      primaryDomain: 'economy',
      clusterId: cluster,
    });
    const result = await findSemanticDuplicate(db, {
      embedding: vA,
      primaryDomain: 'economy',
    });
    expect(result?.clusterId).toBe(cluster);
  });

  it('returns null cluster_id when the matched item is unclustered', async () => {
    await insertItem({
      embedding: vNear,
      primaryDomain: 'economy',
      clusterId: null,
    });
    const result = await findSemanticDuplicate(db, {
      embedding: vA,
      primaryDomain: 'economy',
    });
    expect(result?.clusterId).toBeNull();
  });

  it('returns null when the only existing item is far from the candidate', async () => {
    await insertItem({ embedding: vFar, primaryDomain: 'economy' });
    const result = await findSemanticDuplicate(db, {
      embedding: vA,
      primaryDomain: 'economy',
    });
    expect(result).toBeNull();
  });

  it('throws on wrong embedding dimension', async () => {
    await expect(
      findSemanticDuplicate(db, {
        embedding: [1, 0, 0],
        primaryDomain: 'economy',
      }),
    ).rejects.toThrow(/EMBEDDING_DIM/);
  });
});
