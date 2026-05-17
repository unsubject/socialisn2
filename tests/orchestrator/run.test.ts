// Real-PG integration test for src/orchestrator/run.ts (SPEC §9
// Stages 3-7). Stubs the three external LLM/MCP calls via
// dependency-injection so we don't need to spin up LiteLLM /
// 2nd-brain in CI.

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
import { runScoring } from '../../src/orchestrator/run.js';
import {
  assertDestructiveAllowed,
} from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  // Generous ceiling so the happy paths don't trip; specific tests
  // override to exercise the halt path.
  process.env.COST_CEILING_DAILY_USD = '100.00';
  process.env.COST_ALERT_THRESHOLD = '0.80';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe.skipIf(!DATABASE_URL)('orchestrator runScoring (SPEC §9)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceA: string;
  let sourceB: string;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, file), 'utf-8'));
    }

    sourceA = uuidv7();
    sourceB = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains, authority_score)
      VALUES (${sourceA}, 'rss', 'https://example.com/a', 'Reuters',
              ARRAY['economy']::text[], 85),
             (${sourceB}, 'rss', 'https://example.com/b', 'Bloomberg',
              ARRAY['economy']::text[], 85)
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE candidates, items, gdelt_coverage, clusters, cost_ledger, runs CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

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
        ${now}::timestamptz, ${now}::timestamptz, 2,
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
      VALUES (${rawId}, ${sourceId}, ${`https://example.com/${rawId}`},
              ${`u_${rawId}`}, ${`t ${rawId}`}, ${`th_${rawId}`},
              ${iso}::timestamptz)
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, domains, primary_domain, keywords, embedding, published_at, cluster_id
      )
      VALUES (
        ${itemId}, ${rawId}, 'orig',
        'Fed held rates steady', 'Background context for the cluster.', 'en',
        ARRAY['Federal Reserve']::text[],
        ARRAY['economy']::text[],
        'economy',
        ARRAY['fed', 'rates', 'inflation']::text[],
        ${vecLit}::vector(1536),
        ${iso}::timestamptz,
        ${clusterId}
      )
    `;
  }

  function makeStubSummarise(
    output = {
      headline: 'Fed holds rates steady',
      contextSummary: 'The Federal Reserve held rates. Markets reacted.',
      keywords: ['fed-policy', 'rates', 'inflation', 'pce', 'monetary'],
      tags: ['monetary-policy'],
    },
  ): import('../../src/orchestrator/run.js').RunDependencies['summarise'] {
    return async () => ({
      output,
      llm: {
        text: '',
        inputTokens: 200,
        outputTokens: 50,
        usd: 0.0006,
        model: 'gemini-2.5-flash-lite',
      },
    });
  }

  function makeStubCurate(
    score = 75,
    rationale = 'Strong economy story',
  ): import('../../src/orchestrator/run.js').RunDependencies['curate'] {
    return async () => ({
      output: { curationScore: score, curationRationale: rationale },
      llm: {
        text: '',
        inputTokens: 500,
        outputTokens: 80,
        usd: 0.007,
        model: 'claude-sonnet-4.5',
      },
    });
  }

  // archiveSearcher matches two_brain_client.archiveSearch signature
  // ((embedding, topK, opts?) => Promise<ArchiveMatch[]>).
  function makeStubArchive(matches: Array<{
    id: string;
    title: string;
    url: string;
    published_at: string;
    similarity: number;
    type: 'essay' | 'episode';
  }> = []) {
    return async () => matches;
  }

  it('happy path: one cluster -> one candidate', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.clustersConsidered).toBe(1);
    expect(result.clustersAdvancedToStage4).toBe(1);
    expect(result.candidatesPersisted).toBe(1);
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const candidates = await client`SELECT * FROM candidates`;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.headline).toBe('Fed holds rates steady');
    expect(candidates[0]!.curation_score).toBe(75);
    expect(candidates[0]!.cluster_id).toBe(cluster);

    const ledger = await client`SELECT stage FROM cost_ledger ORDER BY stage`;
    expect(ledger.map((r) => r.stage).sort()).toEqual([
      'stage4_summarise',
      'stage6_curate',
    ]);

    const runs = await client`SELECT status, candidates_count FROM runs`;
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.candidates_count).toBe(1);
  });

  it('drops cluster at Stage 5 when overlap > 0.85 + match recent', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const recentIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75), // shouldn't be reached
        archiveSearcher: makeStubArchive([
          {
            id: 'e1',
            title: 'Prior essay on the Fed',
            url: 'https://example.com/e1',
            published_at: recentIso,
            similarity: 0.92,
            type: 'essay',
          },
        ]),
      },
    );

    expect(result.clustersDroppedByArchive).toBe(1);
    expect(result.candidatesPersisted).toBe(0);
    const candidates = await client`SELECT 1 FROM candidates`;
    expect(candidates).toHaveLength(0);
  });

  it('flags (not drops) cluster when overlap is in (0.70, 0.85]', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const recentIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(72),
        archiveSearcher: makeStubArchive([
          {
            id: 'e1',
            title: 'Related essay',
            url: 'https://example.com/e1',
            published_at: recentIso,
            similarity: 0.8,
            type: 'essay',
          },
        ]),
      },
    );

    expect(result.clustersFlaggedRelatedToRecentWork).toBe(1);
    expect(result.candidatesPersisted).toBe(1);
    const rows = await client<{ archive_overlap_links: { flagRelatedToRecentWork: boolean } }[]>`
      SELECT archive_overlap_links FROM candidates
    `;
    expect(rows[0]!.archive_overlap_links.flagRelatedToRecentWork).toBe(true);
  });

  it('drops cluster at Stage 6 when curationScore < 60', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(45, 'over-saturated, no fresh angle'),
        archiveSearcher: makeStubArchive([]),
      },
    );

    expect(result.clustersBelowCutoff).toBe(1);
    expect(result.candidatesPersisted).toBe(0);
  });

  it('halts mid-run with status=completed + error=cost_ceiling_hit when ceiling fires', async () => {
    // Tuning rationale: stub Gemini cost is 0.0006, Sonnet 0.007.
    // Projection constants in run.ts are GEMINI=0.001, SONNET=0.008.
    //
    //   cluster 1 Gemini assert: 0 + 0.001 = 0.001       < ceiling  PASS
    //   cluster 1 Gemini call:   spent now 0.0006
    //   cluster 1 Sonnet assert: 0.0006 + 0.008 = 0.0086 < ceiling  PASS
    //   cluster 1 Sonnet call:   spent now 0.0076
    //   cluster 1 candidate:     PERSISTED
    //
    //   cluster 2 Gemini assert: 0.0076 + 0.001 = 0.0086 < ceiling  PASS
    //   cluster 2 Gemini call:   spent now 0.0082
    //   cluster 2 Sonnet assert: 0.0082 + 0.008 = 0.0162 ≥ ceiling  THROW
    //
    // Ceiling must be > 0.0086 (cluster 1 Sonnet passes) AND ≤ 0.0162
    // (cluster 2 Sonnet fires). 0.015 sits cleanly in the middle.
    process.env.COST_CEILING_DAILY_USD = '0.015';

    const c1 = await makeCluster();
    const c2 = await makeCluster();
    await attachItem(c1, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(c1, sourceB, new Date(Date.now() - 1 * 3_600_000));
    await attachItem(c2, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(c2, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.error).toBe('cost_ceiling_hit');
    // c1's candidate persisted; the halt fires inside c2's Sonnet assertion.
    expect(result.candidatesPersisted).toBe(1);
    const runs = await client`SELECT status, error FROM runs`;
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.error).toBe('cost_ceiling_hit');
  });

  it('short-circuits cleanly when no active clusters exist', async () => {
    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
      },
    );
    expect(result.status).toBe('completed');
    expect(result.clustersConsidered).toBe(0);
    expect(result.candidatesPersisted).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Phase 4 PR 1: RSS regen hook wiring
  // ---------------------------------------------------------------------------

  it('calls regenerateFeeds exactly once on a successful run', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    let calls = 0;
    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
        regenerateFeeds: async (_db) => {
          calls += 1;
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.candidatesPersisted).toBe(1);
    expect(calls).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('records rss_regeneration_failed in runs.error when the hook throws', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
        regenerateFeeds: async () => {
          throw new Error('disk full');
        },
      },
    );

    // Status stays completed — candidates are already persisted; feed
    // regen is a delivery concern, not a scoring concern. The error
    // field surfaces both halt reason (none here) and the feed failure.
    expect(result.status).toBe('completed');
    expect(result.candidatesPersisted).toBe(1);
    expect(result.error).toMatch(/rss_regeneration_failed/);
    expect(result.error).toMatch(/disk full/);

    const runs = await client<{ status: string; error: string | null }[]>`
      SELECT status, error FROM runs
    `;
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.error).toMatch(/rss_regeneration_failed/);
  });
});
