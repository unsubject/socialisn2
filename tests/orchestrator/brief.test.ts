// Real-PG integration test for src/orchestrator/brief.ts (redesign P1).
// Stubs the LLM via the `generate` dependency; everything else (input
// gathering, runs-row lifecycle, briefs upsert, cost ledger) runs real.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import * as schema from '../../src/db/schema.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import { runWeeklyBrief } from '../../src/orchestrator/brief.js';
import {
  BriefParseError,
  type BriefInput,
  type BriefPitch,
  type BriefResult,
} from '../../src/scoring/brief.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.COST_CEILING_DAILY_USD = '100.00';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe.skipIf(!DATABASE_URL)('orchestrator runWeeklyBrief (redesign P1)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, f), 'utf-8'));
    }
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'brief-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE briefs, feedback, candidates, items, gdelt_coverage, clusters, cost_ledger, runs CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

  /** Cluster + item + candidate — the minimum for gatherBriefInput to
   *  surface a candidate with a source URL. */
  async function seedCandidate(headline: string, opts: { status?: string } = {}): Promise<{
    candidateId: string;
    url: string;
  }> {
    const clusterId = uuidv7();
    const vec = `[${unitVec().join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${vec}::vector(1536), NOW(), NOW(), 1,
              ARRAY['economy']::text[], 'economy', 'active')
    `;
    const rawId = uuidv7();
    const url = `https://example.com/${rawId}`;
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId}, ${url}, ${'uh-' + rawId}, ${headline}, ${'th-' + rawId}, NOW())
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      ) VALUES (
        ${uuidv7()}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['E']::text[], ARRAY['kw']::text[],
        ARRAY['economy']::text[], 'economy',
        ${vec}::vector(1536), NOW(), ${clusterId}
      )
    `;
    const candidateId = uuidv7();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${candidateId}, ${clusterId}, ${headline}, 'ctx',
        'economy', ARRAY['economy']::text[], 'hot', 'rising',
        false, 0.5, 0.1, ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        82, 'strong angle', ARRAY['kw']::text[], ARRAY['tag']::text[],
        ${opts.status ?? 'new'}, ${uuidv7()},
        ${new Date(Date.now() + 48 * 3_600_000).toISOString()}::timestamptz
      )
    `;
    return { candidateId, url };
  }

  function stubGenerate(
    pitchesFor: (input: BriefInput) => BriefPitch[],
  ): (input: BriefInput) => Promise<BriefResult> {
    return async (input) => ({
      pitches: pitchesFor(input),
      llm: {
        text: '',
        inputTokens: 20_000,
        outputTokens: 2_000,
        usd: 0.12,
        model: 'claude-sonnet-4.5',
      },
    });
  }

  function onePitch(input: BriefInput): BriefPitch[] {
    const c = input.candidates[0]!;
    return [
      {
        hook: `Why ${c.headline} is not what it looks like`,
        thesis: 'T',
        steelman: 'S',
        break: 'B',
        whyNow: 'W',
        fit: 'F',
        evidence: c.sourceUrls.slice(0, 1),
        candidateIds: [c.id],
      },
    ];
  }

  it('happy path: gathers the week, persists the brief, records cost, completes the run', async () => {
    await seedCandidate('Fed holds rates');
    const { candidateId } = await seedCandidate('Chip export rules tighten');
    await client`
      INSERT INTO feedback (id, candidate_id, action, reason, interface)
      VALUES (${uuidv7()}, ${candidateId}, 'pass', 'too incremental', 'telegram')
    `;

    let seenInput: BriefInput | undefined;
    const result = await runWeeklyBrief(
      db,
      { weekOf: '2026-07-05' },
      {
        generate: async (input) => {
          seenInput = input;
          return stubGenerate(onePitch)(input);
        },
        regenerateFeeds: async () => {},
      },
    );

    expect(result.status).toBe('completed');
    expect(result.pitchCount).toBe(1);
    expect(result.briefId).not.toBeNull();

    // The gathered input carried the pool, the decision WITH its typed
    // reason, and per-candidate source URLs.
    expect(seenInput!.candidates).toHaveLength(2);
    expect(seenInput!.decisions).toEqual([
      { action: 'pass', headline: 'Chip export rules tighten', reason: 'too incremental' },
    ]);
    expect(seenInput!.candidates[0]!.sourceUrls.length).toBeGreaterThan(0);

    const briefs = await client<{ week_of: string; content_md: string }[]>`
      SELECT week_of, content_md FROM briefs
    `;
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.content_md).toContain('Weekly Ideation Brief — 2026-07-05');

    const runs = await client<{ kind: string; status: string; candidates_count: number }[]>`
      SELECT kind, status, candidates_count FROM runs
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'brief', status: 'completed', candidates_count: 1 });

    const ledger = await client<{ stage: string; bucket: string }[]>`
      SELECT stage, bucket FROM cost_ledger
    `;
    expect(ledger).toEqual([{ stage: 'weekly_brief', bucket: 'brief' }]);
  });

  it('re-run upserts the same week in place and keeps the original feed GUID', async () => {
    await seedCandidate('Fed holds rates');
    const deps = { generate: stubGenerate(onePitch), regenerateFeeds: async () => {} };

    const first = await runWeeklyBrief(db, { weekOf: '2026-07-05' }, deps);
    const second = await runWeeklyBrief(db, { weekOf: '2026-07-05' }, deps);
    expect(second.status).toBe('completed');

    const briefs = await client<{ id: string; updated_at: string | null }[]>`
      SELECT id, updated_at FROM briefs
    `;
    expect(briefs).toHaveLength(1);
    // ON CONFLICT keeps the FIRST id (the feed GUID) and stamps updated_at.
    expect(briefs[0]!.id).toBe(first.briefId);
    expect(briefs[0]!.updated_at).not.toBeNull();
  });

  it('empty week: completes with error=empty_week and writes no brief', async () => {
    const result = await runWeeklyBrief(
      db,
      { weekOf: '2026-07-05' },
      { generate: stubGenerate(onePitch), regenerateFeeds: async () => {} },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toBe('empty_week');
    expect(result.briefId).toBeNull();
    expect(await client`SELECT id FROM briefs`).toHaveLength(0);
  });

  it('parse error: records the spend, fails the run, writes no brief', async () => {
    await seedCandidate('Fed holds rates');
    const result = await runWeeklyBrief(
      db,
      { weekOf: '2026-07-05' },
      {
        generate: async () => {
          throw new BriefParseError(new Error('brief: unparseable JSON'), {
            text: 'garbage',
            inputTokens: 20_000,
            outputTokens: 500,
            usd: 0.08,
            model: 'claude-sonnet-4.5',
          });
        },
        regenerateFeeds: async () => {},
      },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('unparseable');
    expect(result.totalCostUsd).toBeCloseTo(0.08, 6);
    expect(await client`SELECT id FROM briefs`).toHaveLength(0);
    const runs = await client<{ status: string; error: string }[]>`
      SELECT status, error FROM runs
    `;
    expect(runs[0]!.status).toBe('failed');
  });

  it('feed regeneration failure is recorded but does not fail the run', async () => {
    await seedCandidate('Fed holds rates');
    const result = await runWeeklyBrief(
      db,
      { weekOf: '2026-07-05' },
      {
        generate: stubGenerate(onePitch),
        regenerateFeeds: async () => {
          throw new Error('disk full');
        },
      },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toContain('rss_regeneration_failed');
    expect(await client`SELECT id FROM briefs`).toHaveLength(1);
  });
});
