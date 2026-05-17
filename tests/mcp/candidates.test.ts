// Real-PG tests for src/mcp/tools/candidates.ts.

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
  getCandidate,
  listCandidates,
  searchCandidates,
  type Candidate,
  type CandidateDetail,
} from '../../src/mcp/tools/candidates.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function unitVec(prefix: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i] ?? 0;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

describe.skipIf(!DATABASE_URL)('mcp tools/candidates', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;
  let clusterId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const f of readdirSync(resolve(process.cwd(), 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(resolve(process.cwd(), 'migrations'), f), 'utf-8'));
    }
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'mcp-cand-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE candidates, items, gdelt_coverage, clusters CASCADE');
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    await client.unsafe('TRUNCATE TABLE cost_ledger CASCADE');
    clusterId = uuidv7();
    const vec = `[${unitVec([1]).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${vec}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
  });

  async function seed(opts: Partial<{
    headline: string;
    primaryDomain: 'economy' | 'economics' | 'scitech' | 'geopolitics' | 'national';
    status: 'new' | 'picked' | 'passed' | 'deferred' | 'expired';
    temperature: 'cold' | 'warm' | 'hot' | 'over_saturated';
    trajectory: 'new' | 'rising' | 'peaking' | 'declining';
    expiresAt: Date;
    contextSummary: string;
  }> = {}): Promise<string> {
    const id = uuidv7();
    const runId = uuidv7();
    const expires = (opts.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000)).toISOString();
    const primary = opts.primaryDomain ?? 'economy';
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${id}, ${clusterId},
        ${opts.headline ?? 'Headline'},
        ${opts.contextSummary ?? 'A long context summary with at least eighty characters of content for slicing tests in the preview.'},
        ${primary}, ARRAY[${primary}]::text[],
        ${opts.temperature ?? 'warm'}, ${opts.trajectory ?? 'rising'},
        false, 0.5, 0.1,
        ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        75, 'rationale', ARRAY['kw']::text[], ARRAY['tag']::text[],
        ${opts.status ?? 'new'}, ${runId},
        ${expires}::timestamptz
      )
    `;
    return id;
  }

  // -------------------------------------------------------------------------
  // list_candidates
  // -------------------------------------------------------------------------

  it('list_candidates: default returns new non-expired with limit 30', async () => {
    const id = await seed({ headline: 'Active candidate' });
    await seed({ status: 'picked', headline: 'Past pick' });
    await seed({ headline: 'Expired', expiresAt: new Date(Date.now() - 3600 * 1000) });

    const result = (await listCandidates(db, {})) as { candidates: Candidate[] };
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.id).toBe(id);
    expect(result.candidates[0]?.headline).toBe('Active candidate');
    expect(result.candidates[0]?.context_preview.length).toBeLessThanOrEqual(80);
  });

  it('list_candidates: filters by primary_domain', async () => {
    const econ = await seed({ primaryDomain: 'economy', headline: 'E' });
    await seed({ primaryDomain: 'scitech', headline: 'S' });
    const result = await listCandidates(db, { domain: 'economy' });
    expect(result.candidates.map((c) => c.id)).toEqual([econ]);
  });

  it('list_candidates: filters by temperature + trajectory together', async () => {
    const hot = await seed({ temperature: 'hot', trajectory: 'rising', headline: 'HR' });
    await seed({ temperature: 'cold', trajectory: 'rising' });
    await seed({ temperature: 'hot', trajectory: 'declining' });
    const result = await listCandidates(db, { temperature: 'hot', trajectory: 'rising' });
    expect(result.candidates.map((c) => c.id)).toEqual([hot]);
  });

  it('list_candidates: status="picked" returns past picks regardless of expires_at', async () => {
    const picked = await seed({
      status: 'picked',
      headline: 'Long-picked',
      expiresAt: new Date(Date.now() - 7 * 86400 * 1000),
    });
    const result = await listCandidates(db, { status: 'picked' });
    expect(result.candidates.map((c) => c.id)).toEqual([picked]);
  });

  it('list_candidates: respects limit', async () => {
    for (let i = 0; i < 5; i++) await seed();
    const result = await listCandidates(db, { limit: 2 });
    expect(result.candidates).toHaveLength(2);
  });

  it('list_candidates: rejects invalid limit via zod', async () => {
    await expect(listCandidates(db, { limit: 'foo' })).rejects.toThrow();
    await expect(listCandidates(db, { limit: -1 })).rejects.toThrow();
    await expect(listCandidates(db, { limit: 101 })).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // get_candidate
  // -------------------------------------------------------------------------

  it('get_candidate: returns full detail with sources list', async () => {
    const id = await seed({ headline: 'Detailed' });
    const rawId = uuidv7();
    const itemId = uuidv7();
    const vec = `[${unitVec([1]).join(',')}]`;
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId}, 'https://example.com/a', 'h1', 't', 'th', NOW())
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      ) VALUES (
        ${itemId}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['E']::text[], ARRAY['kw']::text[],
        ARRAY['economy']::text[], 'economy',
        ${vec}::vector(1536), NOW(), ${clusterId}
      )
    `;

    const result = (await getCandidate(db, { id })) as { candidate: CandidateDetail };
    expect(result.candidate.id).toBe(id);
    expect(result.candidate.context_summary).toContain('long context summary');
    expect(result.candidate.sources).toHaveLength(1);
    expect(result.candidate.sources[0]?.url).toBe('https://example.com/a');
    expect(result.candidate.sources[0]?.name).toBe('mcp-cand-test');
  });

  it('get_candidate: returns error for missing id', async () => {
    const result = (await getCandidate(db, { id: uuidv7() })) as { error: string };
    expect(result.error).toContain('no candidate');
  });

  it('get_candidate: rejects non-UUID id via zod', async () => {
    await expect(getCandidate(db, { id: 'not-a-uuid' })).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // search_candidates
  // -------------------------------------------------------------------------

  it('search_candidates: returns candidates ordered by cluster cosine similarity', async () => {
    const id = await seed({ headline: 'Match me' });
    const stub: any = async () => ({
      vectors: [unitVec([1])],
      inputTokens: 10,
      usd: 0.0000001,
    });
    const result = (await searchCandidates(db, { query: 'fed rates' }, { embed: stub })) as {
      candidates: Candidate[];
    };
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.id).toBe(id);
  });

  it('search_candidates: records cost to cost_ledger', async () => {
    await seed();
    const stub: any = async () => ({
      vectors: [unitVec([1])],
      inputTokens: 42,
      usd: 0.0000084,
    });
    await searchCandidates(db, { query: 'q' }, { embed: stub });
    const rows = await client<{ stage: string; usd: string; input_tokens: number }[]>`
      SELECT stage, usd, input_tokens FROM cost_ledger WHERE stage = 'mcp_search'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input_tokens).toBe(42);
  });

  it('search_candidates: returns empty when embed returns null vector', async () => {
    await seed();
    const stub: any = async () => ({ vectors: [null], inputTokens: 0, usd: 0 });
    const result = await searchCandidates(db, { query: 'q' }, { embed: stub });
    expect(result.candidates).toEqual([]);
  });

  it('search_candidates: rejects empty query via zod', async () => {
    await expect(searchCandidates(db, { query: '' })).rejects.toThrow();
  });
});
