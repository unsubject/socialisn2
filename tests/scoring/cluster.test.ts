// Real-PG integration test for src/scoring/cluster.ts (SPEC §7.4).
// Resets schema, applies all migrations, then exercises assignCluster and
// compactClusters against live `clusters` + `items` tables. Same pattern as
// tests/cost/ledger.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import { assignCluster, compactClusters } from '../../src/scoring/cluster.js';
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

/** Cosine of two equal-length number[] vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe.skipIf(!DATABASE_URL)('clustering (SPEC §7.4)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

  // Vectors used across tests. With join threshold 0.30 and compaction
  // threshold 0.15:
  //   - vA ↔ vB: cosine 0.95, distance 0.05  → join + compact-merge candidate
  //   - vA ↔ vC: cosine 0.80, distance 0.20  → join, not compact
  //   - vA ↔ vD: cosine 0.60, distance 0.40  → new cluster
  const vA = mkVec([1]);
  const vB = mkVec([0.95, Math.sqrt(1 - 0.95 * 0.95)]); // ≈ [0.95, 0.3122…]
  const vC = mkVec([0.8, 0.6]);
  const vD = mkVec([0.6, 0.8]);
  const vOrth = mkVec([0, 0, 1]);

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

    // One source row reused as the FK target for every raw_item below.
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'cluster-test', ARRAY['economy']::text[])
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
  // helpers (scoped to the suite so they can reference sourceId)
  // -------------------------------------------------------------------------

  async function insertRawItem(opts: { url?: string; publishedAt?: Date } = {}): Promise<string> {
    const id = uuidv7();
    const publishedIso = (opts.publishedAt ?? new Date()).toISOString();
    const url = opts.url ?? `https://example.com/${id}`;
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${id}, ${sourceId}, ${url}, ${`u_${id}`}, ${`title ${id}`}, ${`t_${id}`}, ${publishedIso}::timestamptz)
    `;
    return id;
  }

  /** Insert one item attached to an existing cluster. Used by compaction tests. */
  async function insertItem(opts: {
    clusterId: string;
    embedding: number[];
    primaryDomain: string;
    entities: string[];
    publishedAt?: Date;
  }): Promise<string> {
    const id = uuidv7();
    const rawId = await insertRawItem({ publishedAt: opts.publishedAt });
    const vecLit = `[${opts.embedding.join(',')}]`;
    const publishedIso = (opts.publishedAt ?? new Date()).toISOString();
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, domains, primary_domain, keywords, embedding, published_at, cluster_id
      )
      VALUES (
        ${id}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ${opts.entities}::text[],
        ARRAY[${opts.primaryDomain}]::text[],
        ${opts.primaryDomain},
        ARRAY['kw']::text[],
        ${vecLit}::vector(1536),
        ${publishedIso}::timestamptz,
        ${opts.clusterId}
      )
    `;
    return id;
  }

  /** Insert a cluster pre-populated so we can test compaction setups. */
  async function insertCluster(opts: {
    embedding: number[];
    primaryDomain: string;
    domains?: string[];
    itemCount?: number;
    firstSeenAt?: Date;
    lastSeenAt?: Date;
    status?: 'active' | 'archived' | 'merged';
  }): Promise<string> {
    const id = uuidv7();
    const vecLit = `[${opts.embedding.join(',')}]`;
    const fs = (opts.firstSeenAt ?? new Date()).toISOString();
    const ls = (opts.lastSeenAt ?? new Date()).toISOString();
    await client`
      INSERT INTO clusters (
        id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status
      )
      VALUES (
        ${id}, ${vecLit}::vector(1536),
        ${fs}::timestamptz, ${ls}::timestamptz,
        ${opts.itemCount ?? 1},
        ${opts.domains ?? [opts.primaryDomain]}::text[],
        ${opts.primaryDomain},
        ${opts.status ?? 'active'}
      )
    `;
    return id;
  }

  async function getCluster(id: string): Promise<{
    id: string;
    item_count: number;
    domains: string[];
    status: string;
    merged_into: string | null;
    centroid: number[];
    last_seen_at: Date;
    first_seen_at: Date;
  }> {
    const rows = await client<
      Array<{
        id: string;
        item_count: number;
        domains: string[];
        status: string;
        merged_into: string | null;
        centroid: string;
        last_seen_at: Date;
        first_seen_at: Date;
      }>
    >`SELECT id, item_count, domains, status, merged_into, centroid::text AS centroid,
              last_seen_at, first_seen_at
       FROM clusters WHERE id = ${id}`;
    const row = rows[0];
    if (!row) throw new Error(`cluster ${id} not found`);
    // pgvector returns the vector as a `[a,b,c]` text literal under `::text`.
    const centroid = JSON.parse(row.centroid) as number[];
    return { ...row, centroid };
  }

  // -------------------------------------------------------------------------
  // assignCluster
  // -------------------------------------------------------------------------

  describe('assignCluster', () => {
    it('creates a new cluster when no candidates exist', async () => {
      const result = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date('2026-05-15T10:00:00Z'),
      });

      expect(result.isNew).toBe(true);
      expect(result.distance).toBeNull();

      const c = await getCluster(result.clusterId);
      expect(c.item_count).toBe(1);
      expect(c.domains).toEqual(['economy']);
      expect(c.status).toBe('active');
    });

    it('joins an existing cluster when nearest distance is below threshold', async () => {
      const first = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date('2026-05-15T10:00:00Z'),
      });
      const second = await assignCluster(db, {
        embedding: vB,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date('2026-05-15T11:00:00Z'),
      });

      expect(second.isNew).toBe(false);
      expect(second.clusterId).toBe(first.clusterId);
      expect(second.distance).toBeGreaterThan(0);
      expect(second.distance).toBeLessThan(0.10);

      const c = await getCluster(first.clusterId);
      expect(c.item_count).toBe(2);
      // last_seen_at advanced to the 11:00 publishedAt.
      expect(c.last_seen_at.toISOString()).toBe('2026-05-15T11:00:00.000Z');
    });

    it('creates a new cluster when nearest centroid is above threshold', async () => {
      const first = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });
      const second = await assignCluster(db, {
        embedding: vD, // cosine 0.6 to vA → distance 0.4, above 0.30
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });

      expect(second.isNew).toBe(true);
      expect(second.clusterId).not.toBe(first.clusterId);
    });

    it('respects the 7-day recency window', async () => {
      const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const old = await insertCluster({
        embedding: vA,
        primaryDomain: 'economy',
        firstSeenAt: stale,
        lastSeenAt: stale,
      });
      const result = await assignCluster(db, {
        embedding: vA, // identical → would obviously join if window allowed
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });
      expect(result.isNew).toBe(true);
      expect(result.clusterId).not.toBe(old);
    });

    it('respects primary_domain isolation', async () => {
      const econ = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });
      const sci = await assignCluster(db, {
        embedding: vA, // identical embedding but different domain
        primaryDomain: 'scitech',
        itemDomains: ['scitech'],
        publishedAt: new Date(),
      });
      expect(sci.isNew).toBe(true);
      expect(sci.clusterId).not.toBe(econ.clusterId);
    });

    it('honours a caller-supplied threshold override', async () => {
      const first = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });
      // vC distance 0.2 — would join at default 0.30 but should NOT join at 0.10.
      const second = await assignCluster(
        db,
        {
          embedding: vC,
          primaryDomain: 'economy',
          itemDomains: ['economy'],
          publishedAt: new Date(),
        },
        { threshold: 0.10 },
      );
      expect(second.isNew).toBe(true);
      expect(second.clusterId).not.toBe(first.clusterId);
    });

    it('running-mean update brings the centroid close to the average', async () => {
      const first = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });
      await assignCluster(db, {
        embedding: vB,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });

      const c = await getCluster(first.clusterId);
      // Expected centroid is the unnormalised mean (vA + vB)/2. The cosine
      // similarity between the SQL-computed centroid and the in-JS mean
      // should be essentially 1 (numerical noise only).
      const expectedMean = vA.map((x, i) => (x + (vB[i] ?? 0)) / 2);
      const cos = cosine(c.centroid, expectedMean);
      expect(cos).toBeGreaterThan(0.9999);
      expect(c.item_count).toBe(2);
    });

    it('merges item domain labels into cluster.domains, sorted+deduped', async () => {
      const first = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy', 'national'],
        publishedAt: new Date(),
      });
      await assignCluster(db, {
        embedding: vB,
        primaryDomain: 'economy',
        itemDomains: ['economy', 'geopolitics'],
        publishedAt: new Date(),
      });
      const c = await getCluster(first.clusterId);
      expect(c.domains).toEqual(['economy', 'geopolitics', 'national']);
    });

    it('skips clusters with status != active', async () => {
      const archived = await insertCluster({
        embedding: vA,
        primaryDomain: 'economy',
        status: 'archived',
      });
      const result = await assignCluster(db, {
        embedding: vA,
        primaryDomain: 'economy',
        itemDomains: ['economy'],
        publishedAt: new Date(),
      });
      expect(result.isNew).toBe(true);
      expect(result.clusterId).not.toBe(archived);
    });

    it('throws on wrong embedding dimension', async () => {
      await expect(
        assignCluster(db, {
          embedding: [1, 0, 0], // wrong dim
          primaryDomain: 'economy',
          itemDomains: ['economy'],
          publishedAt: new Date(),
        }),
      ).rejects.toThrow(/EMBEDDING_DIM/);
    });
  });

  // -------------------------------------------------------------------------
  // compactClusters
  // -------------------------------------------------------------------------

  describe('compactClusters', () => {
    it('merges two close clusters that share an entity', async () => {
      const cA = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 5 });
      const cB = await insertCluster({ embedding: vB, primaryDomain: 'economy', itemCount: 2 });
      await insertItem({
        clusterId: cA,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: cB,
        embedding: vB,
        primaryDomain: 'economy',
        entities: ['Fed', 'Powell'],
      });

      const result = await compactClusters(db);

      expect(result.merges).toBe(1);
      // Target should be cA (larger item_count).
      expect(result.pairs[0]).toMatchObject({ source: cB, target: cA });

      const target = await getCluster(cA);
      const source = await getCluster(cB);
      expect(target.item_count).toBe(7); // 5 + 2
      expect(source.status).toBe('merged');
      expect(source.merged_into).toBe(cA);

      // Items previously in cB should now point to cA.
      const reassigned = await client`
        SELECT COUNT(*)::int AS n FROM items WHERE cluster_id = ${cA}
      `;
      expect(reassigned[0]?.n).toBe(2);
    });

    it('does NOT merge close clusters with disjoint entities', async () => {
      const cA = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 3 });
      const cB = await insertCluster({ embedding: vB, primaryDomain: 'economy', itemCount: 3 });
      await insertItem({
        clusterId: cA,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: cB,
        embedding: vB,
        primaryDomain: 'economy',
        entities: ['ECB'], // disjoint from Fed
      });

      const result = await compactClusters(db);
      expect(result.merges).toBe(0);

      const a = await getCluster(cA);
      const b = await getCluster(cB);
      expect(a.status).toBe('active');
      expect(b.status).toBe('active');
    });

    it('does NOT merge across primary_domain', async () => {
      const econ = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 3 });
      const sci = await insertCluster({ embedding: vB, primaryDomain: 'scitech', itemCount: 3 });
      await insertItem({
        clusterId: econ,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: sci,
        embedding: vB,
        primaryDomain: 'scitech',
        entities: ['Fed'],
      });
      const result = await compactClusters(db);
      expect(result.merges).toBe(0);
    });

    it('does NOT merge when centroids are above the compaction threshold', async () => {
      const cA = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 3 });
      // vC distance 0.2 — above the default 0.15 compaction threshold.
      const cC = await insertCluster({ embedding: vC, primaryDomain: 'economy', itemCount: 3 });
      await insertItem({
        clusterId: cA,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: cC,
        embedding: vC,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      const result = await compactClusters(db);
      expect(result.merges).toBe(0);
    });

    it('respects a caller-supplied threshold override (looser)', async () => {
      const cA = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 3 });
      const cC = await insertCluster({ embedding: vC, primaryDomain: 'economy', itemCount: 3 });
      await insertItem({
        clusterId: cA,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: cC,
        embedding: vC,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      // At threshold 0.25, distance 0.20 now qualifies.
      const result = await compactClusters(db, { threshold: 0.25 });
      expect(result.merges).toBe(1);
    });

    it('ignores merged / archived clusters as merge candidates', async () => {
      const cA = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 3 });
      const cBmerged = await insertCluster({
        embedding: vB,
        primaryDomain: 'economy',
        itemCount: 3,
        status: 'merged',
      });
      await insertItem({
        clusterId: cA,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: cBmerged,
        embedding: vB,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      const result = await compactClusters(db);
      expect(result.merges).toBe(0);
    });

    it('orthogonal pair is never merged regardless of entity overlap', async () => {
      const cA = await insertCluster({ embedding: vA, primaryDomain: 'economy', itemCount: 3 });
      const cO = await insertCluster({ embedding: vOrth, primaryDomain: 'economy', itemCount: 3 });
      await insertItem({
        clusterId: cA,
        embedding: vA,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      await insertItem({
        clusterId: cO,
        embedding: vOrth,
        primaryDomain: 'economy',
        entities: ['Fed'],
      });
      const result = await compactClusters(db);
      expect(result.merges).toBe(0);
    });
  });
});
