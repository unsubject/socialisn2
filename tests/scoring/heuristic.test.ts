// Tests for src/scoring/heuristic.ts.
//
// Pure helpers (scoreFromSignals, normaliseGeoSpread, selectTopN) run
// without DB. The integration function computeHeuristic uses real PG
// and is gated on DATABASE_URL like the other scoring tests.

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
  computeHeuristic,
  normaliseGeoSpread,
  scoreFromSignals,
  selectTopN,
  TOP_N_FOR_STAGE_4,
} from '../../src/scoring/heuristic.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('normaliseGeoSpread', () => {
  it('returns 0 for 0 or negative country counts', () => {
    expect(normaliseGeoSpread(0)).toBe(0);
    expect(normaliseGeoSpread(-1)).toBe(0);
  });
  it('scales linearly below the saturation point of 5', () => {
    expect(normaliseGeoSpread(1)).toBeCloseTo(0.2);
    expect(normaliseGeoSpread(3)).toBeCloseTo(0.6);
  });
  it('saturates at 1.0 for 5 or more countries', () => {
    expect(normaliseGeoSpread(5)).toBe(1);
    expect(normaliseGeoSpread(20)).toBe(1);
  });
});

describe('scoreFromSignals', () => {
  it('returns 0 when sumAuthorityWeighted is 0 (log(1+0) = 0)', () => {
    expect(
      scoreFromSignals({
        sumAuthorityWeighted: 0,
        domainWeight: 1,
        geographicSpreadBonus: 0,
        isExclusive: false,
      }),
    ).toBe(0);
  });

  it('applies the exclusive multiplier (1.5x) when isExclusive=true', () => {
    const a = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 1,
      geographicSpreadBonus: 0,
      isExclusive: false,
    });
    const b = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 1,
      geographicSpreadBonus: 0,
      isExclusive: true,
    });
    expect(b).toBeCloseTo(a * 1.5);
  });

  it('applies geo bonus (1 + 0.5 * gsb)', () => {
    const noGeo = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 1,
      geographicSpreadBonus: 0,
      isExclusive: false,
    });
    const fullGeo = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 1,
      geographicSpreadBonus: 1,
      isExclusive: false,
    });
    expect(fullGeo).toBeCloseTo(noGeo * 1.5);
  });

  it('multiplies by domain weight', () => {
    const base = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 1,
      geographicSpreadBonus: 0,
      isExclusive: false,
    });
    const doubled = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 2,
      geographicSpreadBonus: 0,
      isExclusive: false,
    });
    expect(doubled).toBeCloseTo(base * 2);
  });

  it('compounds all four factors per SPEC §9.1 formula', () => {
    const s = scoreFromSignals({
      sumAuthorityWeighted: 100,
      domainWeight: 1.2,
      geographicSpreadBonus: 0.6,
      isExclusive: true,
    });
    const expected = Math.log(101) * 1.2 * (1 + 0.5 * 0.6) * 1.5;
    expect(s).toBeCloseTo(expected);
  });
});

describe('selectTopN', () => {
  it('returns clusters sorted desc by heuristicScore', () => {
    const out = selectTopN([
      { id: 'a', heuristicScore: 0.2 },
      { id: 'b', heuristicScore: 5.0 },
      { id: 'c', heuristicScore: 1.5 },
    ]);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('caps at n (default 200)', () => {
    expect(TOP_N_FOR_STAGE_4).toBe(200);
    const input = Array.from({ length: 500 }, (_, i) => ({
      heuristicScore: 500 - i,
      id: i,
    }));
    expect(selectTopN(input)).toHaveLength(200);
  });

  it('returns all clusters when count below n (no padding)', () => {
    const input = Array.from({ length: 7 }, (_, i) => ({
      heuristicScore: i,
      id: i,
    }));
    expect(selectTopN(input, 200)).toHaveLength(7);
  });

  it('does not mutate the input array', () => {
    const input = [
      { id: 'a', heuristicScore: 1 },
      { id: 'b', heuristicScore: 2 },
    ];
    selectTopN(input);
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

describe.skipIf(!DATABASE_URL)('computeHeuristic (SPEC §9.1)', () => {
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
    authorityWeighted: number | null = null,
  ): Promise<void> {
    const rawId = uuidv7();
    const itemId = uuidv7();
    const v = unitVec();
    const vecLit = `[${v.join(',')}]`;
    const iso = new Date().toISOString();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId}, ${`https://example.com/${rawId}`},
              ${`u_${rawId}`}, ${`t ${rawId}`}, ${`th_${rawId}`},
              ${iso}::timestamptz)
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, domains, primary_domain, keywords, embedding, published_at, cluster_id,
        authority_weighted
      )
      VALUES (
        ${itemId}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['Fed']::text[],
        ARRAY['economy']::text[],
        'economy',
        ARRAY['kw']::text[],
        ${vecLit}::vector(1536),
        ${iso}::timestamptz,
        ${clusterId},
        ${authorityWeighted}
      )
    `;
  }

  it('returns sumAuthority=0 for an empty cluster (score = 0)', async () => {
    const cluster = await makeCluster();
    const result = await computeHeuristic(db, cluster, { isExclusive: false });
    expect(result.sumAuthorityWeighted).toBe(0);
    expect(result.heuristicScore).toBe(0);
  });

  it('sums source.authority_score across items when authority_weighted is null', async () => {
    const cluster = await makeCluster();
    const s1 = await makeSource(80);
    const s2 = await makeSource(60);
    await attachItem(cluster, s1, null);
    await attachItem(cluster, s2, null);
    const result = await computeHeuristic(db, cluster, { isExclusive: false });
    expect(result.sumAuthorityWeighted).toBeCloseTo(140);
    expect(result.heuristicScore).toBeCloseTo(Math.log(141));
  });

  it('prefers items.authority_weighted over source.authority_score when populated', async () => {
    const cluster = await makeCluster();
    const s1 = await makeSource(80); // raw authority
    await attachItem(cluster, s1, 100.0); // weighted override
    const result = await computeHeuristic(db, cluster, { isExclusive: false });
    // 100 (weighted) NOT 80 (raw)
    expect(result.sumAuthorityWeighted).toBeCloseTo(100);
  });

  it('applies the exclusive 1.5x multiplier', async () => {
    const cluster = await makeCluster();
    const s1 = await makeSource(80);
    await attachItem(cluster, s1);
    const nonExc = await computeHeuristic(db, cluster, { isExclusive: false });
    const exc = await computeHeuristic(db, cluster, { isExclusive: true });
    expect(exc.heuristicScore).toBeCloseTo(nonExc.heuristicScore * 1.5);
  });

  it('reads geographic spread bonus from gdelt_coverage.country_count', async () => {
    const cluster = await makeCluster();
    const s1 = await makeSource(80);
    await attachItem(cluster, s1);
    // Insert a gdelt_coverage row with 3 countries → bonus 0.6 → multiplier (1 + 0.5 * 0.6) = 1.3
    const covId = uuidv7();
    await client`
      INSERT INTO gdelt_coverage (id, cluster_id, query_hash, country_count)
      VALUES (${covId}, ${cluster}, 'h', 3)
    `;
    const result = await computeHeuristic(db, cluster, { isExclusive: false });
    expect(result.geographicSpreadBonus).toBeCloseTo(0.6);
    expect(result.heuristicScore).toBeCloseTo(Math.log(81) * 1 * 1.3 * 1);
  });

  it('uses the LATEST gdelt_coverage row when multiple exist', async () => {
    const cluster = await makeCluster();
    const s1 = await makeSource(80);
    await attachItem(cluster, s1);
    const old = uuidv7();
    const recent = uuidv7();
    const oldIso = new Date(Date.now() - 86_400_000).toISOString();
    const newIso = new Date().toISOString();
    await client`
      INSERT INTO gdelt_coverage (id, cluster_id, query_hash, country_count, fetched_at)
      VALUES (${old}, ${cluster}, 'h-old', 1, ${oldIso}::timestamptz),
             (${recent}, ${cluster}, 'h-new', 4, ${newIso}::timestamptz)
    `;
    const result = await computeHeuristic(db, cluster, { isExclusive: false });
    expect(result.geographicSpreadBonus).toBeCloseTo(0.8); // 4/5
  });

  it('uses domainWeight=1.0 when null/undefined', async () => {
    const cluster = await makeCluster();
    const s1 = await makeSource(80);
    await attachItem(cluster, s1);
    const a = await computeHeuristic(db, cluster, { isExclusive: false, domainWeight: null });
    const b = await computeHeuristic(db, cluster, { isExclusive: false });
    expect(a.heuristicScore).toBeCloseTo(b.heuristicScore);
    expect(a.domainWeightUsed).toBe(1.0);
  });
});
