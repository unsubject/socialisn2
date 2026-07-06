// Real-PG tests for src/scoring/collisions.ts (redesign P2). Centroids
// are crafted 2D rotations embedded in the 1536-dim space so pairwise
// cosine similarity is exact: sim(v(0), v(θ)) = cos θ.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import { findCollisionPairs } from '../../src/scoring/collisions.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

const TODAY = new Date().toISOString().slice(0, 10);

/** Unit vector at angle θ (degrees) in the first two dimensions. */
function angleVec(thetaDeg: number): string {
  const theta = (thetaDeg * Math.PI) / 180;
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return `[${v.join(',')}]`;
}

/** Unit vector orthogonal to every angleVec (lives in dimension 2) —
 *  similarity 0 with all of them. */
function orthoVec(): string {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[2] = 1;
  return `[${v.join(',')}]`;
}

describe.skipIf(!DATABASE_URL)('scoring/collisions findCollisionPairs (real PG)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, f), 'utf-8'));
    }
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE candidates, clusters CASCADE');
  });

  async function seed(opts: {
    headline: string;
    domain: string;
    thetaDeg?: number;
    vec?: string;
    createdAt?: string;
    status?: string;
    curationScore?: number;
    clusterId?: string;
  }): Promise<string> {
    const clusterId = opts.clusterId ?? uuidv7();
    const vec = opts.vec ?? angleVec(opts.thetaDeg ?? 0);
    const existing = await client`SELECT 1 FROM clusters WHERE id = ${clusterId}`;
    if (existing.length === 0) {
      await client`
        INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
        VALUES (${clusterId}, ${vec}::vector(1536), NOW(), NOW(), 1,
                ARRAY[${opts.domain}]::text[], ${opts.domain}, 'active')
      `;
    }
    const id = uuidv7();
    const created = opts.createdAt ?? new Date().toISOString();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, created_at, expires_at
      ) VALUES (
        ${id}, ${clusterId}, ${opts.headline}, 'ctx',
        ${opts.domain}, ARRAY[${opts.domain}]::text[], 'warm', 'rising',
        false, 0.5, 0.1, ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        ${opts.curationScore ?? 75}, 'r', ARRAY['kw']::text[], ARRAY['tag']::text[],
        ${opts.status ?? 'new'}, ${uuidv7()},
        ${created}::timestamptz,
        ${new Date(Date.now() + 48 * 3_600_000).toISOString()}::timestamptz
      )
    `;
    return id;
  }

  it('finds cross-domain pairs in the rhyme band; excludes near-dups, unrelated, and same-domain', async () => {
    // Fixture geometry (pairwise sim = cos Δθ; ortho = 0 with all):
    //   econ(0°, economy) × sci(45°, scitech)  = 0.707 → IN BAND ✓
    //   econ(0°)          × dup(5°, scitech)   = 0.996 → above band ✗
    //   sci(45°)          × dup(5°)            = same domain          ✗
    //   econ(0°)          × echo(40°, economy) = same domain          ✗
    //   sci(45°)          × echo(40°)          = 0.996 → above band ✗
    //   dup(5°)           × echo(40°)          = 0.819 → above band ✗
    //   ortho geopolitics × everything         = 0     → below band ✗
    const econ = await seed({ headline: 'IPO liquidity clock', domain: 'economy', thetaDeg: 0 });
    const sci = await seed({ headline: 'TPU cost curves', domain: 'scitech', thetaDeg: 45 });
    await seed({ headline: 'Same story, other desk', domain: 'scitech', thetaDeg: 5 });
    await seed({ headline: 'Domestic same-domain echo', domain: 'economy', thetaDeg: 40 });
    await seed({ headline: 'Unrelated summit', domain: 'geopolitics', vec: orthoVec() });

    const pairs = await findCollisionPairs(db, TODAY);

    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect([pair.aCandidateId, pair.bCandidateId].sort()).toEqual([econ, sci].sort());
    expect(pair.similarity).toBeCloseTo(Math.cos(Math.PI / 4), 2);
    expect([pair.aDomain, pair.bDomain].sort()).toEqual(['economy', 'scitech']);
  });

  it('ignores candidates outside the weekOf window', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await seed({ headline: 'Old econ', domain: 'economy', thetaDeg: 0, createdAt: old });
    await seed({ headline: 'Fresh scitech', domain: 'scitech', thetaDeg: 45 });
    const pairs = await findCollisionPairs(db, TODAY);
    expect(pairs).toEqual([]);
  });

  it('uses one candidate per cluster (best curation score)', async () => {
    const clusterId = uuidv7();
    await seed({
      headline: 'Weaker row',
      domain: 'economy',
      thetaDeg: 0,
      clusterId,
      curationScore: 61,
      status: 'passed',
    });
    const strong = await seed({
      headline: 'Stronger row',
      domain: 'economy',
      thetaDeg: 0,
      clusterId,
      curationScore: 90,
    });
    const sci = await seed({ headline: 'Sci partner', domain: 'scitech', thetaDeg: 45 });

    const pairs = await findCollisionPairs(db, TODAY);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.aCandidateId, pairs[0]!.bCandidateId].sort()).toEqual(
      [strong, sci].sort(),
    );
  });

  it('respects maxPairs and custom band', async () => {
    await seed({ headline: 'A', domain: 'economy', thetaDeg: 0 });
    await seed({ headline: 'B', domain: 'scitech', thetaDeg: 45 });
    await seed({ headline: 'C', domain: 'geopolitics', thetaDeg: 60 });
    // Pairs in default band: A-B (0.707), A-C (0.5), B-C (cos15°≈0.966 above).
    const capped = await findCollisionPairs(db, TODAY, { maxPairs: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]!.similarity).toBeCloseTo(Math.cos(Math.PI / 4), 2);

    const narrow = await findCollisionPairs(db, TODAY, { minSim: 0.45, maxSim: 0.6 });
    expect(narrow).toHaveLength(1);
    expect(narrow[0]!.similarity).toBeCloseTo(0.5, 2);
  });
});
