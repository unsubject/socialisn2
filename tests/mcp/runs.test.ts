// Real-PG tests for src/mcp/tools/runs.ts.
//
// run_now is the only tool with a fire-and-forget contract: it
// returns the run_id synchronously after inserting the runs row, then
// kicks off runScoring() in the background. The test asserts:
//   - the runs row exists with status='running' BEFORE the test ends
//   - the returned id matches the row
//   - the background runScoring eventually transitions the row
//     (best-effort wait — vitest test isolation makes the timing
//     loose, so we poll-check rather than await the run directly)

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { runNow, systemStatus } from '../../src/mcp/tools/runs.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };

describe.skipIf(!DATABASE_URL)('mcp tools/runs', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const f of readdirSync(resolve(process.cwd(), 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(resolve(process.cwd(), 'migrations'), f), 'utf-8'));
    }
  });

  afterAll(async () => {
    await client.end();
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE candidates, items, gdelt_coverage, clusters, cost_ledger, runs CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    // Prevent the orchestrator's tail hooks from doing real work
    // during the fire-and-forget call.
    delete process.env.RSS_PATH;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  // -------------------------------------------------------------------------
  // run_now
  // -------------------------------------------------------------------------

  it('run_now: returns run_id synchronously + row exists with status=running', async () => {
    const result = await runNow(db, {});
    expect(result.status).toBe('started');
    expect(result.run_id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await client<{ id: string; status: string; kind: string }[]>`
      SELECT id, status, kind FROM runs WHERE id = ${result.run_id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('manual');
    // The background runScoring may have already completed by the time
    // we query — accept either 'running' (still going) or 'completed'
    // (finished against the empty cluster set: no clusters → 0
    // candidates → success). The contract being tested is "row exists
    // with the returned id", not the exact transient state.
    expect(['running', 'completed']).toContain(rows[0]?.status);
  });

  it('run_now: background runScoring drives the row to completed when there are no clusters', async () => {
    const result = await runNow(db, {});
    // Poll for transition — bounded retry so the test fails loud if
    // background never completes (rather than hanging forever).
    let status = 'running';
    for (let i = 0; i < 50 && status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const rows = await client<{ status: string }[]>`
        SELECT status FROM runs WHERE id = ${result.run_id}
      `;
      status = rows[0]?.status ?? 'running';
    }
    expect(status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // system_status
  // -------------------------------------------------------------------------

  it('system_status: empty system returns null last_run + zero counts', async () => {
    const result = await systemStatus(db, {});
    expect(result.last_run).toBeNull();
    expect(result.cost_today_usd).toBe(0);
    expect(result.queue_depth).toBe(0);
    expect(result.candidate_pool_size).toBe(0);
  });

  it('system_status: surfaces last run + cost + pending raw_items + active candidate count', async () => {
    // Seed a completed run.
    const runId = uuidv7();
    await client`
      INSERT INTO runs (id, kind, status, candidates_count, total_cost_usd, completed_at, error)
      VALUES (${runId}, 'morning', 'completed', 3, 0.1234, NOW(), NULL)
    `;
    // Cost row today.
    await client`
      INSERT INTO cost_ledger (id, occurred_at, model, input_tokens, output_tokens, usd, stage)
      VALUES (${uuidv7()}, NOW(), 'm', 0, 0, 0.5, 'test')
    `;
    // Pending raw_items: insert a source + 2 raw_items.
    const sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com', 'sys-test', ARRAY['economy']::text[])
    `;
    for (let i = 0; i < 2; i++) {
      const rid = uuidv7();
      await client`
        INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
        VALUES (${rid}, ${sourceId}, ${'u' + i}, ${'h' + i}, 't', ${'th' + i}, NOW())
      `;
    }
    // Active candidate: needs a cluster.
    const clusterId = uuidv7();
    const vec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${vec}::vector(1536), NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary, primary_domain, domains,
        temperature, trajectory, is_exclusive, similarity_score, archive_overlap,
        archive_overlap_links, curation_score, curation_rationale, keywords, tags,
        status, generated_run_id, expires_at
      ) VALUES (
        ${uuidv7()}, ${clusterId}, 'h', 'c', 'economy', ARRAY['economy']::text[],
        'warm', 'rising', false, 0.5, 0.1,
        ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        75, 'r', ARRAY['kw']::text[], ARRAY['t']::text[],
        'new', ${runId}, ${new Date(Date.now() + 86400 * 1000).toISOString()}::timestamptz
      )
    `;

    const result = await systemStatus(db, {});
    expect(result.last_run?.id).toBe(runId);
    expect(result.last_run?.kind).toBe('morning');
    expect(result.last_run?.candidates_count).toBe(3);
    expect(result.last_run?.total_cost_usd).toBeCloseTo(0.1234, 4);
    expect(result.cost_today_usd).toBeCloseTo(0.5, 6);
    expect(result.queue_depth).toBe(2);
    expect(result.candidate_pool_size).toBe(1);
  });
});
