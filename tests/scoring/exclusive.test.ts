// Real-PG integration test for src/scoring/exclusive.ts (SPEC §6.1
// note — first-publisher / exclusive scoop detection).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import { computeExclusive } from '../../src/scoring/exclusive.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

describe.skipIf(!DATABASE_URL)('computeExclusive (SPEC §6.1 note)', () => {
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
    await client.unsafe('TRUNCATE TABLE items, candidates, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items, sources CASCADE');
  });

  async function makeSource(authority: number): Promise<string> {
    const id = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains, authority_score)
      VALUES (${id}, 'rss', ${`https://example.com/${id}`},
              ${`s_${id.slice(0, 8)}`},
              ARRAY['economy']::text[],
              ${authority})
    `;
    return id;
  }

  async function makeCluster(): Promise<string> {
    const id = uuidv7();
    const v = unitVec();
    const vecLit = `[${v.join(',')}]`;
    const now = new Date().toISOString();
    await client`
      INSERT INTO clusters (
        id, centroid, first_seen_at, last_seen_at, item_count,
        domains, primary_domain, status
      )
      VALUES (
        ${id}, ${vecLit}::vector(1536),
        ${now}::timestamptz, ${now}::timestamptz, 1,
        ARRAY['economy']::text[], 'economy', 'active'
      )
    `;
    return id;
  }

  async function attachItem(
    clusterId: string,
    sourceId: string,
    publishedAt: Date,
  ): Promise<void> {
    const rawId = uuidv7();
    const itemId = uuidv7();
    const v = unitVec();
    const vecLit = `[${v.join(',')}]`;
    const iso = publishedAt.toISOString();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId},
              ${`https://example.com/${rawId}`},
              ${`u_${rawId}`}, ${`t ${rawId}`}, ${`th_${rawId}`},
              ${iso}::timestamptz)
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, domains, primary_domain, keywords, embedding, published_at, cluster_id
      )
      VALUES (
        ${itemId}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['Fed']::text[],
        ARRAY['economy']::text[],
        'economy',
        ARRAY['kw']::text[],
        ${vecLit}::vector(1536),
        ${iso}::timestamptz,
        ${clusterId}
      )
    `;
  }

  it('returns not-exclusive with all-null fields when cluster is empty', async () => {
    const cluster = await makeCluster();
    const result = await computeExclusive(db, cluster);
    expect(result).toEqual({
      isExclusive: false,
      exclusiveSourceId: null,
      firstSourceAuthority: null,
      headStartHours: null,
    });
  });

  it('returns not-exclusive (with first source authority) when cluster has one item', async () => {
    const cluster = await makeCluster();
    const high = await makeSource(85);
    await attachItem(cluster, high, new Date(Date.now() - 6 * 3_600_000));
    const result = await computeExclusive(db, cluster);
    expect(result.isExclusive).toBe(false);
    expect(result.exclusiveSourceId).toBeNull();
    expect(result.firstSourceAuthority).toBe(85);
    expect(result.headStartHours).toBeNull();
  });

  it('exclusive=true when first authority ≥ 75 AND head start > 4h', async () => {
    const cluster = await makeCluster();
    const high = await makeSource(85);
    const other = await makeSource(60);
    const t0 = new Date(Date.now() - 10 * 3_600_000);
    const t1 = new Date(Date.now() - 4 * 3_600_000); // 6h gap
    await attachItem(cluster, high, t0);
    await attachItem(cluster, other, t1);

    const result = await computeExclusive(db, cluster);
    expect(result.isExclusive).toBe(true);
    expect(result.exclusiveSourceId).toBe(high);
    expect(result.firstSourceAuthority).toBe(85);
    expect(result.headStartHours).toBeCloseTo(6, 5);
  });

  it('NOT exclusive when first authority < 75', async () => {
    const cluster = await makeCluster();
    const low = await makeSource(60); // below threshold
    const other = await makeSource(80);
    const t0 = new Date(Date.now() - 10 * 3_600_000);
    const t1 = new Date(Date.now() - 4 * 3_600_000);
    await attachItem(cluster, low, t0);
    await attachItem(cluster, other, t1);

    const result = await computeExclusive(db, cluster);
    expect(result.isExclusive).toBe(false);
    expect(result.exclusiveSourceId).toBeNull();
    expect(result.firstSourceAuthority).toBe(60);
  });

  it('NOT exclusive when head start ≤ 4h (e.g. 3h)', async () => {
    const cluster = await makeCluster();
    const high = await makeSource(90);
    const other = await makeSource(70);
    const t0 = new Date(Date.now() - 5 * 3_600_000);
    const t1 = new Date(Date.now() - 2 * 3_600_000); // 3h gap, below threshold
    await attachItem(cluster, high, t0);
    await attachItem(cluster, other, t1);

    const result = await computeExclusive(db, cluster);
    expect(result.isExclusive).toBe(false);
    expect(result.exclusiveSourceId).toBeNull();
    expect(result.headStartHours).toBeCloseTo(3, 5);
  });

  it('strict-greater on the 4h boundary (exactly 4h is NOT exclusive)', async () => {
    const cluster = await makeCluster();
    const high = await makeSource(80);
    const other = await makeSource(70);
    const t0 = new Date(Date.now() - 8 * 3_600_000);
    const t1 = new Date(Date.now() - 4 * 3_600_000); // exactly 4h
    await attachItem(cluster, high, t0);
    await attachItem(cluster, other, t1);

    const result = await computeExclusive(db, cluster);
    expect(result.headStartHours).toBeCloseTo(4, 5);
    expect(result.isExclusive).toBe(false);
  });
});
