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
import { CurateParseError } from '../../src/scoring/curate.js';
import { SummariseParseError } from '../../src/scoring/headline.js';
import {
  runScoring,
  type DigestPushInput,
  type ExclusivePushInput,
} from '../../src/orchestrator/run.js';
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
        curate: makeStubCurate(75),
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

  it('skips cluster + continues run when curate throws a parse error (Gemini 3.5 Flash bad JSON)', async () => {
    // Regression for the 2026-05-30 production incident: Gemini emitted
    // malformed JSON; the strict parser threw `curate: LLM did not return
    // valid JSON: ...`; the outer catch then aborted the WHOLE run on
    // the first bad cluster. Now: the parse error is caught, the
    // cluster is counted in clustersFailedAtCurate, and the run
    // continues with the next cluster.
    const c1 = await makeCluster();
    const c2 = await makeCluster();
    await attachItem(c1, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(c1, sourceB, new Date(Date.now() - 1 * 3_600_000));
    await attachItem(c2, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(c2, sourceB, new Date(Date.now() - 1 * 3_600_000));

    // First call: throw a CurateParseError carrying the LLM usage (the
    // shape the real curateCluster now throws — Codex review on PR
    // #107 caught that the previous "raw Error" throw was leaking the
    // already-paid-for token cost on the skip path).
    // Second call: normal happy-path curation that should land a candidate.
    const parseFailLlmUsage = {
      text: '',
      inputTokens: 500,
      outputTokens: 80,
      usd: 0.0042,
      model: 'gemini-3.5-flash',
    };
    let curateCalls = 0;
    const curate: import('../../src/orchestrator/run.js').RunDependencies['curate'] =
      async () => {
        curateCalls += 1;
        if (curateCalls === 1) {
          throw new CurateParseError(
            new Error(
              'curate: LLM did not return valid JSON: synthetic. Raw (first 200c): {bad,}',
            ),
            parseFailLlmUsage,
          );
        }
        return {
          output: { curationScore: 75, curationRationale: 'good story' },
          llm: {
            text: '',
            inputTokens: 500,
            outputTokens: 80,
            usd: 0.007,
            model: 'gemini-3.5-flash',
          },
        };
      };

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate,
        archiveSearcher: makeStubArchive([]),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.clustersFailedAtCurate).toBe(1);
    expect(result.candidatesPersisted).toBe(1);
    expect(curateCalls).toBe(2);

    // Codex PR #107 fix: cost from the parse-failed call MUST be in
    // the ledger. Without this, runs.total_cost_usd undercounts and
    // assertWithinCeiling lets the run keep spending past the cap.
    // Expected total: stage4 summarise + stage6 curate (parse-fail
    // 0.0042) + stage6 curate (success 0.007).
    const costRows = await client<{ stage: string | null; usd: string }[]>`
      SELECT stage, usd::text FROM cost_ledger ORDER BY occurred_at
    `;
    const stage6Total = costRows
      .filter((r) => r.stage === 'stage6_curate')
      .reduce((acc, r) => acc + Number(r.usd), 0);
    expect(stage6Total).toBeCloseTo(0.0042 + 0.007, 6);

    const runRow = await client<{ status: string; total_cost_usd: string | null; metadata: { clusters_failed_at_curate?: number } }[]>`
      SELECT status, total_cost_usd::text, metadata FROM runs
    `;
    expect(runRow[0]!.status).toBe('completed');
    expect(runRow[0]!.metadata.clusters_failed_at_curate).toBe(1);
    // Run-level cost must reflect the parse-failed cost too.
    expect(Number(runRow[0]!.total_cost_usd)).toBeGreaterThanOrEqual(0.0042 + 0.007);
  });

  it('skips cluster + continues run when summarise throws a parse error (Stage 4)', async () => {
    // Regression for the 2026-06-01/02 outage: gemini-2.5-flash-lite
    // emitted an off-vocabulary tag, headline.parseAndValidate threw,
    // and the outer catch aborted the WHOLE run after a handful of
    // candidates (7-13 vs a healthy ~147). Now: the Stage-4 parse error
    // is caught, the cluster is counted in clustersFailedAtSummarise,
    // its already-incurred LLM cost is recorded, and the run continues.
    const c1 = await makeCluster();
    const c2 = await makeCluster();
    await attachItem(c1, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(c1, sourceB, new Date(Date.now() - 1 * 3_600_000));
    await attachItem(c2, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(c2, sourceB, new Date(Date.now() - 1 * 3_600_000));

    let summariseCalls = 0;
    const summarise: import('../../src/orchestrator/run.js').RunDependencies['summarise'] =
      async () => {
        summariseCalls += 1;
        if (summariseCalls === 1) {
          throw new SummariseParseError(
            new Error(
              'headline: tag "geopolitics" not in STRATEGIC_TAG_SET (synthetic)',
            ),
            {
              text: '',
              inputTokens: 200,
              outputTokens: 50,
              usd: 0.0004,
              model: 'gemini-2.5-flash-lite',
            },
          );
        }
        return {
          output: {
            headline: 'Fed holds rates steady',
            contextSummary: 'The Federal Reserve held rates. Markets reacted.',
            keywords: ['fed-policy', 'rates', 'inflation', 'pce', 'monetary'],
            tags: ['monetary-policy'],
          },
          llm: {
            text: '',
            inputTokens: 200,
            outputTokens: 50,
            usd: 0.0006,
            model: 'gemini-2.5-flash-lite',
          },
        };
      };

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise,
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.clustersFailedAtSummarise).toBe(1);
    expect(result.candidatesPersisted).toBe(1);
    expect(summariseCalls).toBe(2);

    // Cost from the parse-failed summarise call MUST be in the ledger
    // (mirrors the curate skip-path cost-recovery): stage4 = fail
    // (0.0004) + success (0.0006).
    const costRows = await client<{ stage: string | null; usd: string }[]>`
      SELECT stage, usd::text FROM cost_ledger ORDER BY occurred_at
    `;
    const stage4Total = costRows
      .filter((r) => r.stage === 'stage4_summarise')
      .reduce((acc, r) => acc + Number(r.usd), 0);
    expect(stage4Total).toBeCloseTo(0.0004 + 0.0006, 6);

    const runRow = await client<{ status: string; metadata: { clusters_failed_at_summarise?: number } }[]>`
      SELECT status, metadata FROM runs
    `;
    expect(runRow[0]!.metadata.clusters_failed_at_summarise).toBe(1);
  });

  it('still propagates non-parse errors from curate (network, rate limit, etc.) to abort the run', async () => {
    // The skip-on-error guard is scoped to messages starting with
    // `curate:` — the parse/validation family. Network or upstream-5xx
    // failures must STILL abort the run so they're not masked.
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const curate: import('../../src/orchestrator/run.js').RunDependencies['curate'] =
      async () => {
        throw new Error('LiteLLM call failed: HTTP 503');
      };

    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate,
        archiveSearcher: makeStubArchive([]),
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('HTTP 503');
    expect(result.clustersFailedAtCurate).toBe(0);
  });

  it('halts mid-run with status=completed + error=cost_ceiling_hit when ceiling fires', async () => {
    // Sized so cluster 1 fully processes ($0.0076 spent: $0.0006 summarise +
    // $0.007 curate stub) and cluster 2 trips in the orchestrator bucket.
    // The orchestrator sub-budget is 0.8 × daily; the gate condition is
    // (bucket-spent + projection) ≥ bucket-ceiling. With daily $0.024 the
    // bucket is $0.0192, so: cluster 1's curate gate (0.0006 + 0.015 =
    // 0.0156) passes, then cluster 2's curate gate (0.0082 + 0.015 =
    // 0.0232) trips. Re-tuned alongside CURATE_PROJECTED_USD 0.004 → 0.015
    // (PR #125 review: projection now bounds the 2048-token-cap Haiku
    // fallback). The assertions below only require trip-in-orchestrator +
    // candidatesPersisted=1, so they're robust to which orchestrator gate
    // fires.
    process.env.COST_CEILING_DAILY_USD = '0.024';

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
    // Phase 3: err.code is scope-suffixed so runs.error carries the
    // tier that tripped — orchestrator-stage gates pass BUCKET_ORCHESTRATOR
    // so the scope here is the 'orchestrator' bucket, which trips before
    // the overall daily ceiling at the projected $0.010 cap.
    expect(result.error).toBe('cost_ceiling_hit:orchestrator');
    expect(result.candidatesPersisted).toBe(1);
    const runs = await client`SELECT status, error FROM runs`;
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.error).toBe('cost_ceiling_hit:orchestrator');
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

  // ---------------------------------------------------------------------------
  // Phase 4 PR 2: Telegram digest + exclusive push hook wiring
  // ---------------------------------------------------------------------------

  it('calls notifyDigest exactly once on success with per-domain + exclusive summary', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const digestCalls: DigestPushInput[] = [];
    const result = await runScoring(
      db,
      { kind: 'morning' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
        notifyDigest: async (input) => {
          digestCalls.push(input);
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0]?.runKind).toBe('morning');
    expect(digestCalls[0]?.candidates).toHaveLength(1);
    expect(digestCalls[0]?.candidates[0]?.primaryDomain).toBe('economy');
    // Morning runs attach the trending board (the just-persisted
    // candidate is in-window, so the board is non-empty).
    expect(digestCalls[0]?.trending).toBeDefined();
    expect(digestCalls[0]?.trending?.cluster_count).toBeGreaterThan(0);
  });

  it('does not attach the trending board to non-morning digests', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const digestCalls: DigestPushInput[] = [];
    await runScoring(
      db,
      { kind: 'afternoon' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
        notifyDigest: async (input) => {
          digestCalls.push(input);
        },
      },
    );

    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0]?.runKind).toBe('afternoon');
    expect(digestCalls[0]?.trending).toBeUndefined();
  });

  it('records telegram_digest_failed in runs.error when notifyDigest throws', async () => {
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
        notifyDigest: async () => {
          throw new Error('telegram down');
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.candidatesPersisted).toBe(1);
    expect(result.error).toMatch(/telegram_digest_failed/);
    expect(result.error).toMatch(/telegram down/);
  });

  it('passes the persisted candidate to notifyExclusive when computeExclusive flags the cluster', async () => {
    // The default 2-source / 1-each fixture currently produces an
    // exclusive cluster (computeExclusive's first-publisher logic
    // qualifies a same-cluster sourceA item published 6h before any
    // sourceB item). This test pins the wiring contract: when the
    // orchestrator decides a candidate is exclusive, the hook is
    // invoked exactly once with id/headline/primaryDomain matching
    // the persisted candidate. The opposite case (no-exclusive →
    // no-call) is harder to set up without a single-source fixture
    // and is tracked as a follow-up in the PR body.
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));

    const exclusiveCalls: ExclusivePushInput[] = [];
    const result = await runScoring(
      db,
      { kind: 'manual' },
      {
        summarise: makeStubSummarise(),
        curate: makeStubCurate(75),
        archiveSearcher: makeStubArchive([]),
        notifyExclusive: async (input) => {
          exclusiveCalls.push(input);
        },
      },
    );

    expect(result.candidatesPersisted).toBe(1);
    expect(exclusiveCalls).toHaveLength(1);
    expect(exclusiveCalls[0]?.headline).toBe('Fed holds rates steady');
    expect(exclusiveCalls[0]?.primaryDomain).toBe('economy');
    expect(exclusiveCalls[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const candidates = await client<{ id: string; is_exclusive: boolean }[]>`
      SELECT id, is_exclusive FROM candidates
    `;
    expect(candidates[0]?.is_exclusive).toBe(true);
    expect(candidates[0]?.id).toBe(exclusiveCalls[0]?.id);
  });

  // ---------------------------------------------------------------------
  // Redesign P0.1 — candidate supersede (docs/redesign/2026-07-05 §6)
  // ---------------------------------------------------------------------

  it('supersede: a persisting cluster refreshes its row instead of re-minting (P0.1)', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));
    const deps = {
      summarise: makeStubSummarise(),
      curate: makeStubCurate(75),
      archiveSearcher: makeStubArchive([]),
    };

    const first = await runScoring(db, { kind: 'manual' }, deps);
    expect(first.candidatesPersisted).toBe(1);
    expect(first.candidatesSuperseded).toBe(0);

    // Same cluster still active on the next run → refreshed in place,
    // with a better score. Pre-018 this minted a second 'new' row (the
    // 4-5x duplicate-story bug).
    const second = await runScoring(
      db,
      { kind: 'manual' },
      { ...deps, curate: makeStubCurate(88, 'Even stronger now') },
    );
    expect(second.candidatesPersisted).toBe(0);
    expect(second.candidatesSuperseded).toBe(1);

    const rows = await client<
      { curation_score: number; runs_seen: number; updated_at: string | null; status: string }[]
    >`SELECT curation_score, runs_seen, updated_at, status FROM candidates`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('new');
    expect(rows[0]!.curation_score).toBe(88);
    expect(rows[0]!.runs_seen).toBe(2);
    expect(rows[0]!.updated_at).not.toBeNull();
  });

  it('supersede: a recently-decided story is not re-minted; a deferred one re-surfaces (P0.1)', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));
    const deps = {
      summarise: makeStubSummarise(),
      curate: makeStubCurate(75),
      archiveSearcher: makeStubArchive([]),
    };

    await runScoring(db, { kind: 'manual' }, deps);
    await client`UPDATE candidates SET status = 'passed', decided_at = NOW()`;

    const afterPass = await runScoring(db, { kind: 'manual' }, deps);
    expect(afterPass.candidatesPersisted).toBe(0);
    expect(afterPass.candidatesSuperseded).toBe(0);
    expect(afterPass.candidatesSkippedDecided).toBe(1);
    expect((await client`SELECT id FROM candidates`)).toHaveLength(1);

    // Deferred re-surfaces per SPEC §11.1: flips back to 'new' in place.
    await client`UPDATE candidates SET status = 'deferred'`;
    const afterDefer = await runScoring(db, { kind: 'manual' }, deps);
    expect(afterDefer.candidatesSuperseded).toBe(1);
    const rows = await client<{ status: string; runs_seen: number }[]>`
      SELECT status, runs_seen FROM candidates
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('new');
  });

  // ---------------------------------------------------------------------
  // Redesign P0.3 — Daily Pulse persistence (docs/redesign/2026-07-05 §5.1)
  // ---------------------------------------------------------------------

  it('pulse: a morning run writes candidate entries; a quiet manual run writes none (P0.3)', async () => {
    const cluster = await makeCluster();
    await attachItem(cluster, sourceA, new Date(Date.now() - 6 * 3_600_000));
    await attachItem(cluster, sourceB, new Date(Date.now() - 1 * 3_600_000));
    const deps = {
      summarise: makeStubSummarise(),
      curate: makeStubCurate(75, 'The angle line'),
      archiveSearcher: makeStubArchive([]),
    };

    const morning = await runScoring(db, { kind: 'morning' }, deps);
    expect(morning.status).toBe('completed');

    const entries = await client<
      { kind: string; rank: number | null; title: string; description: string }[]
    >`SELECT kind, rank, title, description FROM pulse_entries ORDER BY created_at`;
    // The fixture cluster is exclusive (sourceA 6h lead) → it clears the
    // non-morning gates too, but on a morning run everything fresh
    // enters up to the cap. Exactly one candidate entry; no waves entry
    // (trending board is empty at 1 candidate but themes qualify at ≥1
    // cluster, so allow either 1 or 2 rows and pin the candidate one).
    const candidateEntries = entries.filter((e) => e.kind === 'candidate');
    expect(candidateEntries).toHaveLength(1);
    expect(candidateEntries[0]!.rank).toBe(1);
    expect(candidateEntries[0]!.title).toBe('Fed holds rates steady');
    expect(candidateEntries[0]!.description).toContain('The angle line');

    // Second manual run: the cluster supersedes (no fresh insert) → no
    // new pulse entries. A story pulses once.
    await runScoring(db, { kind: 'manual' }, deps);
    const after = await client`SELECT id FROM pulse_entries`;
    expect(after).toHaveLength(candidateEntries.length + entries.filter((e) => e.kind === 'waves').length);
  });
});
