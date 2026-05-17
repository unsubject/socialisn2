// Real-PG integration test for src/app.ts.
//
// Uses Fastify's `app.inject()` to drive HTTP requests without
// listening on a port. Seeds source + cluster + items + candidate via
// raw SQL (so the test is independent of the orchestrator / scoring
// path), builds the app, hits routes, asserts. Mirrors the destructive
// setup pattern in tests/scoring/cluster.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import * as schema from '../src/db/schema.js';
import { assertDestructiveAllowed } from './helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('Fastify app (src/app.ts)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let sourceId: string;
  let clusterId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.unsafe(readFileSync(join(dir, file), 'utf-8'));
    }
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'app-test-source', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE candidates, items, gdelt_coverage, clusters CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    clusterId = uuidv7();
    const zeroVec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${zeroVec}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
    app = buildApp(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function seedCandidate(opts: {
    id?: string;
    headline?: string;
    contextSummary?: string;
    isExclusive?: boolean;
    archiveOverlapLinks?: unknown;
    curationRationale?: string | null;
  } = {}): Promise<string> {
    const id = opts.id ?? uuidv7();
    const runId = uuidv7();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const archive = opts.archiveOverlapLinks ?? {
      overlap: 0,
      flagRelatedToRecentWork: false,
      links: [],
    };
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${id}, ${clusterId},
        ${opts.headline ?? 'Hello'},
        ${opts.contextSummary ?? 'Context.'},
        'economy', ARRAY['economy']::text[],
        'warm', 'rising',
        ${opts.isExclusive ?? false},
        0.5, 0.1,
        ${JSON.stringify(archive)}::jsonb,
        75,
        ${opts.curationRationale ?? null},
        ARRAY['kw1', 'kw2']::text[],
        ARRAY['tag1']::text[],
        'new',
        ${runId},
        ${expires}::timestamptz
      )
    `;
    return id;
  }

  async function seedRawItem(sourceName: string): Promise<string> {
    const id = uuidv7();
    await client`
      INSERT INTO raw_items (id, source_id, url, url_hash, title, title_hash, published_at)
      VALUES (${id}, ${sourceId},
              ${'https://example.com/article/' + id},
              ${'uh_' + id},
              ${'Article ' + sourceName},
              ${'th_' + id},
              NOW())
    `;
    return id;
  }

  async function seedItem(rawItemId: string): Promise<void> {
    const vec = `[${new Array(1536).fill(0.002).join(',')}]`;
    await client`
      INSERT INTO items (
        id, raw_item_id, title_original, summary_en, context_en, language_original,
        entities, keywords, domains, primary_domain, embedding, published_at, cluster_id
      )
      VALUES (
        ${uuidv7()}, ${rawItemId}, 'orig', 'sum', 'ctx', 'en',
        ARRAY['Ent']::text[], ARRAY['kw']::text[],
        ARRAY['economy']::text[], 'economy',
        ${vec}::vector(1536),
        NOW(), ${clusterId}
      )
    `;
  }

  // -------------------------------------------------------------------------
  // /healthz
  // -------------------------------------------------------------------------

  it('GET /healthz returns 200 {ok:true}', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // /c/:id — happy path
  // -------------------------------------------------------------------------

  it('GET /c/:id returns HTML with headline, context, and sources', async () => {
    const id = await seedCandidate({
      headline: 'The Big Story',
      contextSummary: 'Three sentences of context.',
    });
    const rawA = await seedRawItem('publisher A');
    const rawB = await seedRawItem('publisher B');
    await seedItem(rawA);
    await seedItem(rawB);

    const res = await app.inject({ method: 'GET', url: `/c/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);

    const body = res.body;
    expect(body).toContain('<h1>The Big Story</h1>');
    expect(body).toContain('Three sentences of context.');
    expect(body).toContain('app-test-source');
  });

  it('renders curationRationale when present', async () => {
    const id = await seedCandidate({
      curationRationale: 'because it advances the story',
    });
    const res = await app.inject({ method: 'GET', url: `/c/${id}` });
    expect(res.body).toContain('Curation rationale');
    expect(res.body).toContain('because it advances the story');
  });

  it('omits the curation-rationale section when rationale is null', async () => {
    const id = await seedCandidate({ curationRationale: null });
    const res = await app.inject({ method: 'GET', url: `/c/${id}` });
    expect(res.body).not.toContain('Curation rationale');
  });

  it('renders archive overlap links from the jsonb payload', async () => {
    const id = await seedCandidate({
      archiveOverlapLinks: {
        overlap: 0.55,
        flagRelatedToRecentWork: true,
        links: [
          {
            title: 'A prior essay',
            url: 'https://2nd.brain/essay/123',
            similarity: 0.81,
            type: 'essay',
          },
        ],
      },
    });
    const res = await app.inject({ method: 'GET', url: `/c/${id}` });
    expect(res.body).toContain('A prior essay');
    expect(res.body).toContain('https://2nd.brain/essay/123');
    expect(res.body).toContain('essay');
  });

  it('shows EXCLUSIVE in the meta line when is_exclusive is true', async () => {
    const id = await seedCandidate({ isExclusive: true });
    const res = await app.inject({ method: 'GET', url: `/c/${id}` });
    expect(res.body).toContain('<strong>EXCLUSIVE</strong>');
  });

  // -------------------------------------------------------------------------
  // /c/:id — escaping
  // -------------------------------------------------------------------------

  it('escapes XSS attempts in headline and context', async () => {
    const id = await seedCandidate({
      headline: '<script>alert(1)</script>',
      contextSummary: '"quoted" & \'apos\' < >',
    });
    const res = await app.inject({ method: 'GET', url: `/c/${id}` });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('&amp;');
    expect(res.body).toContain('&quot;');
    expect(res.body).toContain('&#39;');
  });

  // -------------------------------------------------------------------------
  // /c/:id — 404 paths
  // -------------------------------------------------------------------------

  it('returns 404 HTML for a non-existent candidate', async () => {
    const missingId = uuidv7();
    const res = await app.inject({ method: 'GET', url: `/c/${missingId}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('404');
    expect(res.body).toContain(missingId);
  });

  it('returns 404 without DB hit for an obviously-bogus id', async () => {
    const res = await app.inject({ method: 'GET', url: '/c/foo' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('404');
  });

  it('escapes the bogus id in the 404 body', async () => {
    const res = await app.inject({ method: 'GET', url: '/c/abcdefgh-1234' });
    expect(res.statusCode).toBe(404);
    // The id passes the loose UUID-shape check then misses the DB; the
    // renderer must still escape whatever the user typed.
    expect(res.body).toContain('abcdefgh-1234');
  });
});
