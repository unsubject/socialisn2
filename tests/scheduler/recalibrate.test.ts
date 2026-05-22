// Real-PG integration test for src/scheduler/recalibrate.ts (ADR-013).
//
// Resets schema, applies all migrations, seeds sources + clusters + items +
// candidates + feedback, then exercises runRecalibration end-to-end.
//
// Time-bomb-free: no hardcoded calendar dates. All "30 days ago" / "now"
// offsets are computed at test time via Date.now() − Nh.

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
  posteriorScore,
  runRecalibration,
} from '../../src/scheduler/recalibrate.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

/** 1536-dim unit-norm vector with all entries equal — every test cluster's
 *  centroid points the same direction; we don't exercise similarity here. */
function uniformVec(): string {
  const v = 1 / Math.sqrt(EMBEDDING_DIM);
  return `[${new Array(EMBEDDING_DIM).fill(v).join(',')}]`;
}

describe.skipIf(!DATABASE_URL)('runRecalibration (ADR-013)', () => {
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
    // Order matters — items FK clusters, feedback FK candidates, candidates FK
    // clusters, raw_items FK sources. The CASCADE handles dependents.
    await client.unsafe(
      'TRUNCATE TABLE feedback, candidates, items, gdelt_coverage, clusters, runs CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    await client.unsafe('TRUNCATE TABLE sources CASCADE');
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** Insert one source with a given seed authority. Returns its id. */
  async function insertSource(opts: {
    seed: number;
    name?: string;
    enabled?: boolean;
  }): Promise<string> {
    const id = uuidv7();
    await client`
      INSERT INTO sources (
        id, kind, url, name, domains,
        authority_score, authority_score_seed, enabled
      ) VALUES (
        ${id}, 'rss',
        ${`https://example.com/${id}.xml`},
        ${opts.name ?? `src-${id.slice(0, 8)}`},
        ARRAY['economy']::text[],
        ${opts.seed}, ${opts.seed},
        ${opts.enabled ?? true}
      )
    `;
    return id;
  }

  /** Insert a cluster + one item from sourceId, return cluster id. */
  async function insertClusterWithItem(sourceId: string): Promise<string> {
    const clusterId = uuidv7();
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${uniformVec()}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
    const rawId = uuidv7();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId},
              ${`https://example.com/${rawId}`},
              ${`uh_${rawId}`}, ${`Title ${rawId}`}, ${`th_${rawId}`}, NOW())
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      ) VALUES (
        ${uuidv7()}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['E']::text[], ARRAY['kw']::text[],
        ARRAY['economy']::text[], 'economy',
        ${uniformVec()}::vector(1536),
        NOW(), ${clusterId}
      )
    `;
    return clusterId;
  }

  /** Insert a candidate attached to a cluster. Returns its id. */
  async function insertCandidate(clusterId: string): Promise<string> {
    const id = uuidv7();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${id}, ${clusterId},
        'cand', 'ctx',
        'economy', ARRAY['economy']::text[],
        'warm', 'rising',
        false, 0.5, 0.1,
        ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        75, null,
        ARRAY['k']::text[], ARRAY['t']::text[],
        'picked', ${uuidv7()},
        ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}::timestamptz
      )
    `;
    return id;
  }

  /** Write one feedback row with the given action against candidateId. */
  async function insertFeedback(
    candidateId: string,
    action: 'pick' | 'pass' | 'defer',
    /** Offset in hours from now (defaults to 0 = "now"). Negative = older. */
    hoursOffset: number = 0,
  ): Promise<void> {
    const at = new Date(Date.now() + hoursOffset * 3_600_000).toISOString();
    await client`
      INSERT INTO feedback (id, candidate_id, action, interface, created_at)
      VALUES (${uuidv7()}, ${candidateId}, ${action}, 'telegram', ${at}::timestamptz)
    `;
  }

  /** Build N picks + M passes + K defers against a single source's cluster. */
  async function seedDecisions(opts: {
    sourceId: string;
    picks?: number;
    passes?: number;
    defers?: number;
  }): Promise<void> {
    const { sourceId } = opts;
    const picks = opts.picks ?? 0;
    const passes = opts.passes ?? 0;
    const defers = opts.defers ?? 0;
    const total = picks + passes + defers;
    // Each decision gets its own cluster+candidate to keep the join unambiguous
    // (the SQL CTE is DISTINCT(feedback_id, source_id) — multiple decisions
    // per cluster would still work, but one-cluster-per-decision is the
    // clearest shape for asserting counts).
    let written = 0;
    for (let i = 0; i < picks; i++) {
      const c = await insertClusterWithItem(sourceId);
      const cand = await insertCandidate(c);
      await insertFeedback(cand, 'pick');
      written++;
    }
    for (let i = 0; i < passes; i++) {
      const c = await insertClusterWithItem(sourceId);
      const cand = await insertCandidate(c);
      await insertFeedback(cand, 'pass');
      written++;
    }
    for (let i = 0; i < defers; i++) {
      const c = await insertClusterWithItem(sourceId);
      const cand = await insertCandidate(c);
      await insertFeedback(cand, 'defer');
      written++;
    }
    expect(written).toBe(total);
  }

  /** Read a source's current authority_score (and the calibrated_at stamp).
   *  postgres-js without an explicit type-parser registration returns
   *  timestamptz columns from SELECT as strings; we wrap to Date here so
   *  the assertions read naturally.
   *  (Memory: [[drizzle_pg_execute_timestamp_string]] — same pattern.) */
  async function readScore(
    sourceId: string,
  ): Promise<{ score: number; calibrated_at: Date | null }> {
    const rows = await client<
      { authority_score: number; authority_score_calibrated_at: string | null }[]
    >`
      SELECT authority_score, authority_score_calibrated_at
      FROM sources WHERE id = ${sourceId}
    `;
    const row = rows[0]!;
    return {
      score: row.authority_score,
      calibrated_at:
        row.authority_score_calibrated_at === null
          ? null
          : new Date(row.authority_score_calibrated_at),
    };
  }

  // -------------------------------------------------------------------------
  // tests
  // -------------------------------------------------------------------------

  it('no feedback → score stays at seed (prior dominates)', async () => {
    const sourceId = await insertSource({ seed: 50, name: 'src-no-fb' });
    await runRecalibration(db, { priorStrength: 20 });
    const { score, calibrated_at } = await readScore(sourceId);
    expect(score).toBe(50);
    expect(calibrated_at).not.toBeNull();
  });

  it('10 picks, 0 passes → score moves up (and matches the closed-form posterior)', async () => {
    const sourceId = await insertSource({ seed: 50, name: 'src-picks' });
    await seedDecisions({ sourceId, picks: 10 });
    await runRecalibration(db, { priorStrength: 20 });
    const { score } = await readScore(sourceId);
    // α₀ = 10, β₀ = 10, +10 picks → α=20, β=10 → mean 2/3 → 67
    expect(score).toBe(posteriorScore({ seed: 50, picks: 10, passes: 0, k: 20 }));
    expect(score).toBeGreaterThan(50);
    expect(score).toBe(67);
  });

  it('0 picks, 10 passes → score moves down (mirror of the above)', async () => {
    const sourceId = await insertSource({ seed: 50, name: 'src-passes' });
    await seedDecisions({ sourceId, passes: 10 });
    await runRecalibration(db, { priorStrength: 20 });
    const { score } = await readScore(sourceId);
    expect(score).toBe(posteriorScore({ seed: 50, picks: 0, passes: 10, k: 20 }));
    expect(score).toBeLessThan(50);
    expect(score).toBe(33);
  });

  it('defer rows are ignored (5p+3p+2d == 5p+3p)', async () => {
    const src1 = await insertSource({ seed: 50, name: 'src-with-defers' });
    const src2 = await insertSource({ seed: 50, name: 'src-no-defers' });
    await seedDecisions({ sourceId: src1, picks: 5, passes: 3, defers: 2 });
    await seedDecisions({ sourceId: src2, picks: 5, passes: 3 });
    await runRecalibration(db, { priorStrength: 20 });
    const a = await readScore(src1);
    const b = await readScore(src2);
    // Strict equality — defers must contribute zero, not "approximately zero".
    expect(a.score).toBe(b.score);
    // Sanity: 5 picks + 3 passes against seed 50 / k=20 → α=15, β=13 → 54
    expect(a.score).toBe(54);
  });

  it('extreme priors (seed 0, seed 100) clamp into [1, 100] with no feedback', async () => {
    const lowId = await insertSource({ seed: 0, name: 'src-seed-low' });
    const highId = await insertSource({ seed: 100, name: 'src-seed-high' });
    await runRecalibration(db, { priorStrength: 20 });
    const low = await readScore(lowId);
    const high = await readScore(highId);
    // seed=0 → α=0, β=20 → mean 0 → round 0 → clamp to 1
    expect(low.score).toBe(1);
    // seed=100 → α=20, β=0 → mean 1 → round 100 → clamp leaves 100
    expect(high.score).toBe(100);
  });

  it('writes a runs row with kind=recalibrate and metadata', async () => {
    await insertSource({ seed: 50, name: 'src-runs-row' });
    const result = await runRecalibration(db, { priorStrength: 20 });
    const rows = await client<
      {
        kind: string;
        status: string;
        completed_at: string | null;
        metadata: { sources_updated?: number; window_days?: number; prior_strength?: number };
      }[]
    >`
      SELECT kind, status, completed_at, metadata
      FROM runs WHERE id = ${result.runId}
    `;
    const run = rows[0]!;
    expect(run.kind).toBe('recalibrate');
    expect(run.status).toBe('completed');
    expect(run.completed_at).not.toBeNull();
    expect(run.metadata.sources_updated).toBe(1);
    expect(run.metadata.window_days).toBe(30);
    expect(run.metadata.prior_strength).toBe(20);
  });

  it('stamps authority_score_calibrated_at on every touched source', async () => {
    const sourceId = await insertSource({ seed: 50, name: 'src-stamp' });
    const before = await readScore(sourceId);
    expect(before.calibrated_at).toBeNull();
    await runRecalibration(db, { priorStrength: 20 });
    const after = await readScore(sourceId);
    expect(after.calibrated_at).not.toBeNull();
    // Stamp is very recent — within the last minute of runRecalibration.
    expect(Date.now() - (after.calibrated_at as Date).getTime()).toBeLessThan(60_000);
  });

  it('ignores disabled sources', async () => {
    const disabledId = await insertSource({
      seed: 50,
      name: 'src-disabled',
      enabled: false,
    });
    // Seed an "active" pick against it that would otherwise move the score.
    await seedDecisions({ sourceId: disabledId, picks: 20 });
    await runRecalibration(db, { priorStrength: 20 });
    const after = await readScore(disabledId);
    // Score and calibrated_at both untouched — disabled rows are excluded
    // by the WHERE s.enabled = true clause in the aggregation query.
    expect(after.score).toBe(50);
    expect(after.calibrated_at).toBeNull();
  });

  it('feedback older than 30 days is excluded from the window', async () => {
    const sourceId = await insertSource({ seed: 50, name: 'src-old-feedback' });
    const c = await insertClusterWithItem(sourceId);
    const cand = await insertCandidate(c);
    // 40 days old — outside the WINDOW_DAYS=30 horizon.
    await insertFeedback(cand, 'pick', -40 * 24);
    await runRecalibration(db, { priorStrength: 20 });
    const after = await readScore(sourceId);
    // No in-window feedback → prior dominates → score stays at seed.
    expect(after.score).toBe(50);
  });
});
