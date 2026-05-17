// Real-PG integration test for src/scoring/temperature.ts (SPEC §9.5
// volume_z + temperature labelling). Mirrors the cluster.ts /
// semantic-dedup.ts test pattern: drop+recreate schema, apply all
// migrations, TRUNCATE between tests.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import {
  bucketBaseTemperature,
  computeTemperature,
  computeVolumeZ,
} from '../../src/scoring/temperature.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('bucketBaseTemperature', () => {
  it('z < 0 is cold', () => {
    expect(bucketBaseTemperature(-0.01)).toBe('cold');
    expect(bucketBaseTemperature(-5)).toBe('cold');
  });
  it('0 ≤ z < 1 is warm', () => {
    expect(bucketBaseTemperature(0)).toBe('warm');
    expect(bucketBaseTemperature(0.5)).toBe('warm');
    expect(bucketBaseTemperature(0.999)).toBe('warm');
  });
  it('1 ≤ z is hot (over_saturated upgrade is integration-only)', () => {
    expect(bucketBaseTemperature(1)).toBe('hot');
    expect(bucketBaseTemperature(2.4)).toBe('hot');
    expect(bucketBaseTemperature(10)).toBe('hot');
  });
});

describe('computeVolumeZ', () => {
  it('returns 0 when mean is null (no baseline at all)', () => {
    expect(computeVolumeZ(50, null, 0)).toBe(0);
  });

  it('uses the standard z formula when observed stddev exceeds the Poisson floor', () => {
    // mean=2, observed stddev=10 (high variance), Poisson floor sqrt(2) ≈ 1.41.
    // effective stddev = max(10, 1.41) = 10. z = (50-2)/10 = 4.8.
    expect(computeVolumeZ(50, 2, 10)).toBeCloseTo(4.8, 5);
  });

  it('falls back to the Poisson floor when observed stddev is 0', () => {
    // Quiet domain: every other cluster has identical item_count=2 →
    // observed STDDEV is 0. Without the floor, z would be 0 and a
    // 50-item cluster would silently look warm. With Poisson floor
    // sqrt(2): z = (50-2)/sqrt(2) ≈ 33.9 → hot.
    expect(computeVolumeZ(50, 2, 0)).toBeCloseTo(48 / Math.sqrt(2), 5);
  });

  it('uses Poisson floor when observed stddev is small but non-zero', () => {
    // mean=2, tiny observed stddev=0.5. Poisson floor sqrt(2) ≈ 1.41
    // wins. z = (50-2)/sqrt(2) ≈ 33.9.
    expect(computeVolumeZ(50, 2, 0.5)).toBeCloseTo(48 / Math.sqrt(2), 5);
  });

  it('handles mean=0 with the floor=1 clamp', () => {
    // mean=0 → sqrt(max(0,1)) = 1 → z = (50-0)/1 = 50.
    expect(computeVolumeZ(50, 0, 0)).toBe(50);
  });

  it('returns negative z when itemCount is below mean', () => {
    expect(computeVolumeZ(1, 10, 0)).toBeLessThan(0);
  });
});

function mkVec(prefix: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i] ?? 0;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error('mkVec: zero-norm prefix');
  return v.map((x) => x / norm);
}

describe.skipIf(!DATABASE_URL)('computeTemperature (SPEC §9.5)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

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
      const sqlText = readFileSync(join(dir, file), 'utf-8');
      await client.unsafe(sqlText);
    }

    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains, authority_score)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'temp-test', ARRAY['economy']::text[], 70)
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE items, candidates, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

  async function insertCluster(opts: {
    primaryDomain: string;
    itemCount: number;
    embedding?: number[];
    firstSeenDaysAgo?: number;
  }): Promise<string> {
    const id = uuidv7();
    const vec = opts.embedding ?? mkVec([1]);
    const vecLit = `[${vec.join(',')}]`;
    const seenAt = new Date(
      Date.now() - (opts.firstSeenDaysAgo ?? 0) * 86_400_000,
    ).toISOString();
    await client`
      INSERT INTO clusters (
        id, centroid, first_seen_at, last_seen_at, item_count,
        domains, primary_domain, status
      )
      VALUES (
        ${id}, ${vecLit}::vector(1536),
        ${seenAt}::timestamptz, ${seenAt}::timestamptz,
        ${opts.itemCount},
        ARRAY[${opts.primaryDomain}]::text[],
        ${opts.primaryDomain},
        'active'
      )
    `;
    return id;
  }

  async function insertRawItem(): Promise<string> {
    const id = uuidv7();
    const now = new Date().toISOString();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${id}, ${sourceId}, ${`https://example.com/${id}`},
              ${`u_${id}`}, ${`t ${id}`}, ${`th_${id}`},
              ${now}::timestamptz)
    `;
    return id;
  }

  async function insertItemInCluster(clusterId: string, embedding: number[]): Promise<string> {
    const id = uuidv7();
    const rawId = await insertRawItem();
    const vecLit = `[${embedding.join(',')}]`;
    const now = new Date().toISOString();
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, domains, primary_domain, keywords, embedding, published_at, cluster_id
      )
      VALUES (
        ${id}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['Fed']::text[],
        ARRAY['economy']::text[],
        'economy',
        ARRAY['kw']::text[],
        ${vecLit}::vector(1536),
        ${now}::timestamptz,
        ${clusterId}
      )
    `;
    return id;
  }

  it('returns volumeZ=0 when this is the only cluster in the domain', async () => {
    const cluster = await insertCluster({ primaryDomain: 'economy', itemCount: 5 });
    const result = await computeTemperature(db, {
      clusterId: cluster,
      primaryDomain: 'economy',
      itemCount: 5,
    });
    expect(result.volumeZ).toBe(0);
    expect(result.temperature).toBe('warm');
  });

  it('returns cold when item_count is below the domain mean', async () => {
    // Other clusters in the domain have 10-12 items; target has 1.
    const target = await insertCluster({ primaryDomain: 'economy', itemCount: 1 });
    await insertCluster({ primaryDomain: 'economy', itemCount: 10 });
    await insertCluster({ primaryDomain: 'economy', itemCount: 10 });
    await insertCluster({ primaryDomain: 'economy', itemCount: 12 });
    const result = await computeTemperature(db, {
      clusterId: target,
      primaryDomain: 'economy',
      itemCount: 1,
    });
    expect(result.volumeZ).toBeLessThan(0);
    expect(result.temperature).toBe('cold');
  });

  it('returns hot when item_count is well above the domain mean (Poisson floor handles zero variance)', async () => {
    const target = await insertCluster({ primaryDomain: 'economy', itemCount: 50 });
    // 10 identical quiet clusters → observed STDDEV=0, but Poisson floor
    // sqrt(2) ≈ 1.41 → z = (50-2)/1.41 ≈ 33.9 → hot.
    for (let i = 0; i < 10; i++) {
      await insertCluster({ primaryDomain: 'economy', itemCount: 2 });
    }
    const result = await computeTemperature(db, {
      clusterId: target,
      primaryDomain: 'economy',
      itemCount: 50,
    });
    expect(result.volumeZ).toBeGreaterThanOrEqual(1);
    // Hot OR over_saturated — depends on the (absent) items' similarity,
    // and with no items inserted into the target cluster, pairwise sim
    // is null → stays hot.
    expect(['hot', 'over_saturated']).toContain(result.temperature);
  });

  it('upgrades hot → over_saturated when avg pairwise similarity > 0.75', async () => {
    const target = await insertCluster({ primaryDomain: 'economy', itemCount: 50 });
    for (let i = 0; i < 10; i++) {
      await insertCluster({ primaryDomain: 'economy', itemCount: 2 });
    }
    // Insert 3 very-similar items → high avg pairwise similarity.
    const v = mkVec([1, 0, 0]);
    await insertItemInCluster(target, v);
    await insertItemInCluster(target, mkVec([0.99, 0.14, 0]));
    await insertItemInCluster(target, mkVec([0.98, 0.2, 0]));

    const result = await computeTemperature(db, {
      clusterId: target,
      primaryDomain: 'economy',
      itemCount: 50,
    });
    expect(result.volumeZ).toBeGreaterThanOrEqual(2.5);
    expect(result.temperature).toBe('over_saturated');
    expect(result.avgPairwiseSimilarity).toBeGreaterThan(0.75);
  });

  it('stays hot (not over_saturated) when items are dissimilar despite high z', async () => {
    const target = await insertCluster({ primaryDomain: 'economy', itemCount: 50 });
    for (let i = 0; i < 10; i++) {
      await insertCluster({ primaryDomain: 'economy', itemCount: 2 });
    }
    // Orthogonal-ish items → low avg pairwise sim.
    await insertItemInCluster(target, mkVec([1, 0, 0, 0]));
    await insertItemInCluster(target, mkVec([0, 1, 0, 0]));
    await insertItemInCluster(target, mkVec([0, 0, 1, 0]));

    const result = await computeTemperature(db, {
      clusterId: target,
      primaryDomain: 'economy',
      itemCount: 50,
    });
    expect(result.volumeZ).toBeGreaterThanOrEqual(2.5);
    expect(result.temperature).toBe('hot');
    expect(result.avgPairwiseSimilarity ?? 0).toBeLessThan(0.75);
  });

  it('isolates by primary_domain (cross-domain clusters do not affect z)', async () => {
    // Target in economy with 5 items.
    const target = await insertCluster({ primaryDomain: 'economy', itemCount: 5 });
    // High-volume clusters in DIFFERENT domain — should be ignored.
    for (let i = 0; i < 5; i++) {
      await insertCluster({ primaryDomain: 'scitech', itemCount: 100 });
    }
    const result = await computeTemperature(db, {
      clusterId: target,
      primaryDomain: 'economy',
      itemCount: 5,
    });
    expect(result.volumeZ).toBe(0); // no other economy clusters
    expect(result.temperature).toBe('warm');
  });
});
