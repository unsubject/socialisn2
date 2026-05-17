// Real-PG integration test for src/scoring/trajectory.ts (SPEC §9.5
// 24-hour derivative + trajectory labelling).

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
  bucketTrajectory,
  computeTrajectory,
} from '../../src/scoring/trajectory.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('bucketTrajectory', () => {
  it('ratio > 1.5 is rising', () => {
    expect(bucketTrajectory(1.51)).toBe('rising');
    expect(bucketTrajectory(5)).toBe('rising');
  });
  it('0.7 ≤ ratio ≤ 1.5 is peaking', () => {
    expect(bucketTrajectory(0.7)).toBe('peaking');
    expect(bucketTrajectory(1.0)).toBe('peaking');
    expect(bucketTrajectory(1.5)).toBe('peaking');
  });
  it('ratio < 0.7 is declining', () => {
    expect(bucketTrajectory(0.69)).toBe('declining');
    expect(bucketTrajectory(0)).toBe('declining');
  });
});

function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

describe.skipIf(!DATABASE_URL)('computeTrajectory (SPEC §9.5)', () => {
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
              'traj-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE items, candidates, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

  async function insertCluster(firstSeenDaysAgo: number): Promise<string> {
    const id = uuidv7();
    const v = unitVec();
    const vecLit = `[${v.join(',')}]`;
    const seen = new Date(Date.now() - firstSeenDaysAgo * 86_400_000).toISOString();
    await client`
      INSERT INTO clusters (
        id, centroid, first_seen_at, last_seen_at, item_count,
        domains, primary_domain, status
      )
      VALUES (
        ${id}, ${vecLit}::vector(1536),
        ${seen}::timestamptz, ${seen}::timestamptz,
        1,
        ARRAY['economy']::text[],
        'economy',
        'active'
      )
    `;
    return id;
  }

  async function insertItemPublishedHoursAgo(
    clusterId: string,
    hoursAgo: number,
  ): Promise<void> {
    const itemId = uuidv7();
    const rawId = uuidv7();
    const publishedIso = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const v = unitVec();
    const vecLit = `[${v.join(',')}]`;
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId}, ${`https://example.com/${rawId}`},
              ${`u_${rawId}`}, ${`t ${rawId}`}, ${`th_${rawId}`},
              ${publishedIso}::timestamptz)
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
        ${publishedIso}::timestamptz,
        ${clusterId}
      )
    `;
  }

  it("returns 'new' when first_seen_at is within 24h (no DB query needed)", async () => {
    // Stick the firstSeenAt 3h in the past — below the 24h window.
    const fakeId = uuidv7();
    const result = await computeTrajectory(db, {
      clusterId: fakeId,
      firstSeenAt: new Date(Date.now() - 3 * 3_600_000),
    });
    expect(result.trajectory).toBe('new');
    expect(result.trajectoryRatio).toBe(0);
  });

  it('declining when no recent items', async () => {
    const cluster = await insertCluster(3); // 3 days old
    const result = await computeTrajectory(db, {
      clusterId: cluster,
      firstSeenAt: new Date(Date.now() - 3 * 86_400_000),
    });
    expect(result.trajectoryRatio).toBe(0);
    expect(result.trajectory).toBe('declining');
  });

  it('rising when last 24h items exceed prior 24h by more than 1.5x', async () => {
    const cluster = await insertCluster(5);
    // prior 24h: 1 item; last 24h: 3 items → ratio 3 → rising
    await insertItemPublishedHoursAgo(cluster, 36);
    await insertItemPublishedHoursAgo(cluster, 12);
    await insertItemPublishedHoursAgo(cluster, 6);
    await insertItemPublishedHoursAgo(cluster, 1);

    const result = await computeTrajectory(db, {
      clusterId: cluster,
      firstSeenAt: new Date(Date.now() - 5 * 86_400_000),
    });
    expect(result.trajectoryRatio).toBe(3);
    expect(result.trajectory).toBe('rising');
  });

  it('peaking when last 24h is comparable to prior 24h', async () => {
    const cluster = await insertCluster(5);
    // prior 24h: 2 items; last 24h: 2 items → ratio 1.0 → peaking
    await insertItemPublishedHoursAgo(cluster, 40);
    await insertItemPublishedHoursAgo(cluster, 30);
    await insertItemPublishedHoursAgo(cluster, 12);
    await insertItemPublishedHoursAgo(cluster, 4);

    const result = await computeTrajectory(db, {
      clusterId: cluster,
      firstSeenAt: new Date(Date.now() - 5 * 86_400_000),
    });
    expect(result.trajectoryRatio).toBe(1);
    expect(result.trajectory).toBe('peaking');
  });

  it('declining when last 24h items are far below prior 24h', async () => {
    const cluster = await insertCluster(5);
    // prior 24h: 5 items; last 24h: 1 item → ratio 0.2 → declining
    for (let i = 0; i < 5; i++) {
      await insertItemPublishedHoursAgo(cluster, 30 + i * 2);
    }
    await insertItemPublishedHoursAgo(cluster, 6);

    const result = await computeTrajectory(db, {
      clusterId: cluster,
      firstSeenAt: new Date(Date.now() - 5 * 86_400_000),
    });
    expect(result.trajectoryRatio).toBe(0.2);
    expect(result.trajectory).toBe('declining');
  });

  it('clamps the denominator at 1 when prior 24h has zero items', async () => {
    const cluster = await insertCluster(5);
    // last 24h: 2 items; prior 24h: 0 → max(0, 1) = 1 → ratio 2.0 → rising
    await insertItemPublishedHoursAgo(cluster, 5);
    await insertItemPublishedHoursAgo(cluster, 2);

    const result = await computeTrajectory(db, {
      clusterId: cluster,
      firstSeenAt: new Date(Date.now() - 5 * 86_400_000),
    });
    expect(result.trajectoryRatio).toBe(2);
    expect(result.trajectory).toBe('rising');
  });
});
