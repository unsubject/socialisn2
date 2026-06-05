// Real-PG tests for the DB query path of src/scoring/trending.ts
// (computeTrending). The pure aggregation core is covered DB-free in
// tests/scoring/trending.test.ts; this file proves the active-window
// filter, the domain filter, the snake_case→camelCase row mapping, and
// text[] array handling against a real migrated schema — matching the
// repo convention that every DB-touching tool gets a real-PG test
// (see tests/mcp/candidates.test.ts).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import { computeTrending } from '../../src/scoring/trending.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function unitVec(prefix: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i] ?? 0;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

type Domain = 'economy' | 'economics' | 'scitech' | 'geopolitics' | 'national';

describe.skipIf(!DATABASE_URL)('scoring/trending computeTrending (real PG)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const f of readdirSync(resolve(process.cwd(), 'migrations'))
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      await client.unsafe(readFileSync(join(resolve(process.cwd(), 'migrations'), f), 'utf-8'));
    }
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE candidates, items, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

  // Each candidate gets its own cluster (distinct cluster_id) unless an
  // explicit clusterId is passed — lets us exercise the cluster dedup.
  async function seed(opts: Partial<{
    clusterId: string;
    headline: string;
    primaryDomain: Domain;
    temperature: 'cold' | 'warm' | 'hot' | 'over_saturated';
    trajectory: 'new' | 'rising' | 'peaking' | 'declining';
    status: 'new' | 'picked' | 'passed' | 'deferred' | 'expired';
    expiresAt: Date;
    keywords: string[];
    tags: string[];
  }> = {}): Promise<void> {
    const primary = opts.primaryDomain ?? 'geopolitics';
    const clusterId = opts.clusterId ?? uuidv7();
    const vec = `[${unitVec([1]).join(',')}]`;
    // Create the cluster only if this is a new cluster_id (FK target).
    const existing = await client`SELECT 1 FROM clusters WHERE id = ${clusterId}`;
    if (existing.length === 0) {
      await client`
        INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
        VALUES (${clusterId}, ${vec}::vector(1536),
                NOW(), NOW(), 1, ARRAY[${primary}]::text[], ${primary}, 'active')
      `;
    }
    const expires = (opts.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000)).toISOString();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${uuidv7()}, ${clusterId},
        ${opts.headline ?? 'Headline with enough length for the context summary slice padding.'},
        ${'A long context summary with at least eighty characters of content for the preview slice.'},
        ${primary}, ARRAY[${primary}]::text[],
        ${opts.temperature ?? 'hot'}, ${opts.trajectory ?? 'rising'},
        false, 0.5, 0.1,
        ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        75, 'rationale',
        ${`{${(opts.keywords ?? ['kw']).join(',')}}`}::text[],
        ${`{${(opts.tags ?? ['tag']).join(',')}}`}::text[],
        ${opts.status ?? 'new'}, ${uuidv7()},
        ${expires}::timestamptz
      )
    `;
  }

  it('aggregates only in-window new candidates; excludes expired and decided', async () => {
    await seed({ tags: ['supply-chain-realignment'], keywords: ['tariffs'] });
    await seed({ tags: ['supply-chain-realignment'], keywords: ['energy-security'] });
    await seed({ status: 'picked', tags: ['should-not-appear'] });
    await seed({
      tags: ['expired-theme'],
      expiresAt: new Date(Date.now() - 3600 * 1000),
    });

    const board = await computeTrending(db);

    expect(board.cluster_count).toBe(2);
    const themeTerms = board.themes.map((t) => t.term);
    expect(themeTerms).toContain('supply-chain-realignment');
    expect(themeTerms).not.toContain('should-not-appear');
    expect(themeTerms).not.toContain('expired-theme');
    const supplyChain = board.themes.find((t) => t.term === 'supply-chain-realignment');
    expect(supplyChain?.cluster_count).toBe(2);
    // text[] mapping round-trips: both keywords aggregate.
    expect(board.keywords.map((k) => k.term).sort()).toEqual(['energy-security', 'tariffs']);
  });

  it('dedups re-minted candidate rows sharing a cluster_id', async () => {
    const clusterId = uuidv7();
    await seed({ clusterId, headline: 'Morning row', tags: ['post-america'] });
    await seed({ clusterId, headline: 'Afternoon row', tags: ['post-america'] });

    const board = await computeTrending(db);
    expect(board.cluster_count).toBe(1);
    expect(board.themes.find((t) => t.term === 'post-america')?.cluster_count).toBe(1);
  });

  it('filters by primary_domain', async () => {
    await seed({ primaryDomain: 'geopolitics', tags: ['post-america'] });
    await seed({ primaryDomain: 'scitech', tags: ['ai-safety'] });

    const board = await computeTrending(db, { domain: 'scitech' });
    expect(board.cluster_count).toBe(1);
    expect(board.themes.map((t) => t.term)).toEqual(['ai-safety']);
  });
});
