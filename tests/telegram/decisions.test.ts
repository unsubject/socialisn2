// Real-PG integration test for src/telegram/decisions.ts.
//
// Validates the three-step flow: candidate UPDATE, feedback INSERT,
// recordPick MCP call. The race safety check (UPDATE..WHERE status='new'
// RETURNING *) is the load-bearing assertion — a second decision on the
// same candidate must resolve to alreadyDecided=true without writing a
// duplicate feedback row or firing a duplicate MCP call.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { decide } from '../../src/telegram/decisions.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('telegram decisions.decide', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;
  let clusterId: string;

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
              'decisions-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE feedback, candidates, items, gdelt_coverage, clusters CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
  });

  /** Each seeded candidate gets its OWN cluster (+ one item so urls[]
   *  is non-empty when recordPick is called) — migration 018's partial
   *  unique index allows at most one 'new' candidate per cluster. */
  async function seedCandidate(): Promise<string> {
    clusterId = uuidv7();
    const vec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${vec}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
    const rawId = uuidv7();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${rawId}, ${sourceId}, 'https://example.com/article',
              ${'uh-' + rawId}, 'Article', ${'th-' + rawId}, NOW())
    `;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      ) VALUES (
        ${uuidv7()}, ${rawId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['E']::text[], ARRAY['kw']::text[],
        ARRAY['economy']::text[], 'economy',
        ${vec}::vector(1536),
        NOW(), ${clusterId}
      )
    `;
    const id = uuidv7();
    const runId = uuidv7();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${id}, ${clusterId},
        'Test candidate', 'A short context.',
        'economy', ARRAY['economy']::text[],
        'warm', 'rising',
        false, 0.5, 0.1,
        ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        75, 'rationale',
        ARRAY['kw1']::text[], ARRAY['tag1']::text[],
        'new', ${runId},
        ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}::timestamptz
      )
    `;
    return id;
  }

  it('happy path: pick → status=picked, feedback row, recordPick called once', async () => {
    const id = await seedCandidate();
    let recordCalls = 0;
    const result = await decide(db, id, 'pick', 'because reasons', 'telegram', {
      recordPick: async (cand, dec, reason) => {
        recordCalls += 1;
        expect(cand.headline).toBe('Test candidate');
        expect(cand.urls).toEqual(['https://example.com/article']);
        expect(dec).toBe('pick');
        expect(reason).toBe('because reasons');
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.alreadyDecided).toBeUndefined();
    expect(result.candidate?.headline).toBe('Test candidate');

    const cand = await client<{ status: string; decision_reason: string }[]>`
      SELECT status, decision_reason FROM candidates WHERE id = ${id}
    `;
    expect(cand[0]?.status).toBe('picked');
    expect(cand[0]?.decision_reason).toBe('because reasons');

    const fb = await client<{ action: string; interface: string }[]>`
      SELECT action, interface FROM feedback WHERE candidate_id = ${id}
    `;
    expect(fb).toHaveLength(1);
    expect(fb[0]?.action).toBe('pick');
    expect(fb[0]?.interface).toBe('telegram');

    expect(recordCalls).toBe(1);
  });

  it('pass + defer write their respective status', async () => {
    const passId = await seedCandidate();
    const deferId = await seedCandidate();
    await decide(db, passId, 'pass', undefined, 'telegram', {
      recordPick: async () => ({ ok: true }),
    });
    await decide(db, deferId, 'defer', undefined, 'telegram', {
      recordPick: async () => ({ ok: true }),
    });
    const rows = await client<{ id: string; status: string }[]>`
      SELECT id, status FROM candidates WHERE id IN (${passId}, ${deferId})
    `;
    expect(rows.find((r) => r.id === passId)?.status).toBe('passed');
    expect(rows.find((r) => r.id === deferId)?.status).toBe('deferred');
  });

  it('race: second decide on same candidate returns alreadyDecided + no duplicate feedback or MCP', async () => {
    const id = await seedCandidate();
    let recordCalls = 0;
    const stub = async () => {
      recordCalls += 1;
      return { ok: true };
    };
    const first = await decide(db, id, 'pick', undefined, 'telegram', { recordPick: stub });
    const second = await decide(db, id, 'pass', undefined, 'telegram', { recordPick: stub });

    expect(first.alreadyDecided).toBeUndefined();
    expect(second.alreadyDecided).toBe(true);
    expect(second.candidate).toBeUndefined();

    const fbCount = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM feedback WHERE candidate_id = ${id}
    `;
    expect(fbCount[0]?.n).toBe(1);
    expect(recordCalls).toBe(1);

    // Status from FIRST decision wins.
    const cand = await client<{ status: string }[]>`
      SELECT status FROM candidates WHERE id = ${id}
    `;
    expect(cand[0]?.status).toBe('picked');
  });

  it('returns alreadyDecided=true when called on a non-existent id', async () => {
    const result = await decide(db, uuidv7(), 'pick', undefined, 'telegram', {
      recordPick: async () => ({ ok: true }),
    });
    expect(result.alreadyDecided).toBe(true);
  });

  it('recordPick failure does NOT roll back the candidate status / feedback', async () => {
    const id = await seedCandidate();
    const result = await decide(db, id, 'pick', undefined, 'telegram', {
      recordPick: async () => ({ ok: false }),
    });
    expect(result.ok).toBe(true);
    const cand = await client<{ status: string }[]>`
      SELECT status FROM candidates WHERE id = ${id}
    `;
    expect(cand[0]?.status).toBe('picked');
    const fb = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM feedback WHERE candidate_id = ${id}
    `;
    expect(fb[0]?.n).toBe(1);
  });
});
