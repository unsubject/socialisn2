// Real-PG integration test for src/rss/generate.ts (SPEC §11.2).
//
// Resets schema, applies all migrations, seeds candidates with varying
// status / primary_domain / expires_at, runs generateAllFeeds() into a
// tmpdir, then validates each output by parsing with rss-parser
// (already in deps). Asserts:
//
//   - all.xml carries every 'new' non-expired candidate
//   - per-domain feeds strictly filter on primary_domain (not multi-label)
//   - status != 'new' AND expires_at <= NOW() are excluded
//   - socialisn2:* custom namespace fields round-trip
//   - atomic write leaves no .tmp files
//   - escape discipline holds (<script> in headline → &lt;script&gt;)
//
// Mirrors the setup pattern in tests/scoring/cluster.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import Parser from 'rss-parser';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { generateAllFeeds } from '../../src/rss/generate.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

// rss-parser tolerates custom-namespaced fields out of the box but only
// surfaces them as top-level fields on the parsed item when explicitly
// configured. Map the four socialisn2:* fields here so assertions can
// read them as item.temperature etc.
const parser = new Parser<unknown, {
  temperature?: string;
  trajectory?: string;
  exclusive?: string;
  archive_overlap?: string;
}>({
  customFields: {
    item: [
      ['socialisn2:temperature', 'temperature'],
      ['socialisn2:trajectory', 'trajectory'],
      ['socialisn2:exclusive', 'exclusive'],
      ['socialisn2:archive_overlap', 'archive_overlap'],
    ],
  },
});

const PUBLIC_HOST = 'socialisn2.test.local';

describe.skipIf(!DATABASE_URL)('RSS generator (SPEC §11.2)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sourceId: string;
  let clusterId: string;
  let outDir: string;

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
    // Reusable source + cluster for every candidate (they don't matter
    // to the RSS feed contents directly, but the FKs do).
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'rss-gen-test', ARRAY['economy']::text[])
    `;
    clusterId = uuidv7();
    const zeroVec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${zeroVec}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE briefs, candidates CASCADE');
    if (outDir) await rm(outDir, { recursive: true, force: true });
    outDir = await mkdtemp(join(tmpdir(), 'socialisn2-rss-test-'));
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  type DomainCode = 'economy' | 'economics' | 'scitech' | 'geopolitics' | 'national';

  interface SeedCandidate {
    headline?: string;
    contextSummary?: string;
    primaryDomain?: DomainCode;
    /** Multi-label domains[]. Defaults to [primaryDomain]; pass explicitly
     *  to exercise the strict-primary contract on per-domain feeds. */
    domains?: DomainCode[];
    keywords?: string[];
    tags?: string[];
    temperature?: 'cold' | 'warm' | 'hot' | 'over_saturated';
    trajectory?: 'new' | 'rising' | 'peaking' | 'declining';
    isExclusive?: boolean;
    archiveOverlap?: number;
    status?: 'new' | 'picked' | 'passed' | 'deferred' | 'expired';
    expiresAt?: Date;
    curationScore?: number;
  }

  async function seedCandidate(opts: SeedCandidate = {}): Promise<string> {
    // Migration 018: at most one 'new' candidate per cluster — each
    // seeded candidate gets its own cluster.
    clusterId = uuidv7();
    const zeroVec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${zeroVec}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
    const id = uuidv7();
    const runId = uuidv7();
    const primary = opts.primaryDomain ?? 'economy';
    const domains = opts.domains ?? [primary];
    const expires = (opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)).toISOString();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${id}, ${clusterId},
        ${opts.headline ?? 'Default headline'},
        ${opts.contextSummary ?? 'Default context.'},
        ${primary},
        ${domains}::text[],
        ${opts.temperature ?? 'warm'},
        ${opts.trajectory ?? 'rising'},
        ${opts.isExclusive ?? false},
        0.5,
        ${opts.archiveOverlap ?? 0.1},
        ${JSON.stringify({ overlap: opts.archiveOverlap ?? 0.1, links: [] })}::jsonb,
        ${opts.curationScore ?? 75},
        'rationale',
        ${opts.keywords ?? ['kw1', 'kw2']}::text[],
        ${opts.tags ?? ['tag1']}::text[],
        ${opts.status ?? 'new'},
        ${runId},
        ${expires}::timestamptz
      )
    `;
    return id;
  }

  // -------------------------------------------------------------------------
  // tests
  // -------------------------------------------------------------------------

  it('writes all 8 feed files (all + 5 domain + pulse + brief) even when no candidates', async () => {
    const written = await generateAllFeeds(db, outDir, PUBLIC_HOST);

    expect(written).toHaveLength(8);
    expect(written.map((p) => p.split('/').pop())).toEqual([
      'all.xml',
      'economy.xml',
      'economics.xml',
      'scitech.xml',
      'geopolitics.xml',
      'national.xml',
      'pulse.xml',
      'brief.xml',
    ]);

    // Each file parses as a valid RSS doc with zero items.
    for (const file of written) {
      const xml = await readFile(file, 'utf-8');
      const feed = await parser.parseString(xml);
      expect(feed.items).toHaveLength(0);
    }

    // No .tmp leftovers from the atomic-write step.
    const leftover = readdirSync(outDir).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('master feed contains every new non-expired candidate; domain feeds filter strictly', async () => {
    const econId = await seedCandidate({ primaryDomain: 'economy', headline: 'Econ A' });
    const sciId = await seedCandidate({ primaryDomain: 'scitech', headline: 'Sci A' });
    const geoId = await seedCandidate({ primaryDomain: 'geopolitics', headline: 'Geo A' });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);

    const all = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    expect(all.items.map((i) => i.guid).sort()).toEqual([econId, sciId, geoId].sort());

    const econ = await parser.parseString(await readFile(join(outDir, 'economy.xml'), 'utf-8'));
    expect(econ.items.map((i) => i.guid)).toEqual([econId]);

    const sci = await parser.parseString(await readFile(join(outDir, 'scitech.xml'), 'utf-8'));
    expect(sci.items.map((i) => i.guid)).toEqual([sciId]);

    const nat = await parser.parseString(await readFile(join(outDir, 'national.xml'), 'utf-8'));
    expect(nat.items).toEqual([]);
  });

  it('per-domain feed uses primary_domain strictly — multi-label domains[] does NOT route', async () => {
    // Candidate is primarily economy but ALSO labelled geopolitics.
    // SPEC §11.2 contract: it appears in all.xml + economy.xml ONLY,
    // NOT in geopolitics.xml. Multi-label is for search/filter UI
    // (Phase 4 PR 2-3), not for static feed membership.
    const id = await seedCandidate({
      primaryDomain: 'economy',
      domains: ['economy', 'geopolitics'],
      headline: 'Cross-domain story',
    });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);

    const all = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    const econ = await parser.parseString(await readFile(join(outDir, 'economy.xml'), 'utf-8'));
    const geo = await parser.parseString(await readFile(join(outDir, 'geopolitics.xml'), 'utf-8'));

    expect(all.items.map((i) => i.guid)).toEqual([id]);
    expect(econ.items.map((i) => i.guid)).toEqual([id]);
    expect(geo.items).toEqual([]);
  });

  it('excludes candidates whose status is not new', async () => {
    const newId = await seedCandidate({ status: 'new', headline: 'still in' });
    await seedCandidate({ status: 'picked', headline: 'should be out' });
    await seedCandidate({ status: 'expired', headline: 'should be out' });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const all = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    expect(all.items.map((i) => i.guid)).toEqual([newId]);
  });

  it('excludes candidates whose expires_at has passed', async () => {
    const liveId = await seedCandidate({
      headline: 'live',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await seedCandidate({
      headline: 'expired',
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const all = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    expect(all.items.map((i) => i.guid)).toEqual([liveId]);
  });

  it('round-trips the custom socialisn2:* namespace fields', async () => {
    await seedCandidate({
      headline: 'NS check',
      temperature: 'hot',
      trajectory: 'peaking',
      isExclusive: true,
      archiveOverlap: 0.4321,
    });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const feed = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    const item = feed.items[0]!;
    expect(item.temperature).toBe('hot');
    expect(item.trajectory).toBe('peaking');
    expect(item.exclusive).toBe('true');
    // generator emits .toFixed(4) — assert as string match to lock formatting.
    expect(item.archive_overlap).toBe('0.4321');
  });

  it('escapes XML-reserved chars in headline and description', async () => {
    await seedCandidate({
      headline: '<script>alert(1)</script> & "fun"',
      contextSummary: 'A&B > C < D',
    });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const raw = await readFile(join(outDir, 'all.xml'), 'utf-8');

    // Raw bytes: angle brackets, ampersand, and quote must be entitised.
    // (Find at least one of each escape pattern.)
    expect(raw).toContain('&lt;script&gt;');
    expect(raw).toContain('&amp;');
    expect(raw).toContain('&quot;');
    expect(raw).not.toContain('<script>alert');

    // And rss-parser still produces the original on parse (the
    // round-trip proves escaping was correct, not just present).
    const feed = await parser.parseString(raw);
    expect(feed.items[0]!.title).toBe('<script>alert(1)</script> & "fun"');
  });

  it('item link is built from publicHost as https://<host>/c/<id>', async () => {
    const id = await seedCandidate({ headline: 'link check' });
    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const feed = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    expect(feed.items[0]!.link).toBe(`https://${PUBLIC_HOST}/c/${id}`);
  });

  it('honours the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await seedCandidate({ headline: `Item ${i}` });
    }
    await generateAllFeeds(db, outDir, PUBLIC_HOST, { limit: 3 });
    const all = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    expect(all.items).toHaveLength(3);
  });

  it('orders candidate feeds by curation_score DESC, recency tiebreak (P0.2)', async () => {
    const mid = await seedCandidate({ headline: 'mid', curationScore: 70 });
    const best = await seedCandidate({ headline: 'best', curationScore: 92 });
    const low = await seedCandidate({ headline: 'low', curationScore: 61 });

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const all = await parser.parseString(await readFile(join(outDir, 'all.xml'), 'utf-8'));
    expect(all.items.map((i) => i.guid)).toEqual([best, mid, low]);
  });

  it('pulse.xml renders pulse_entries newest-first with candidate links (P0.3)', async () => {
    const candId = await seedCandidate({ headline: 'Pulse story' });
    const runId = uuidv7();
    await client`
      INSERT INTO runs (id, kind, status) VALUES (${runId}, 'morning', 'completed')
    `;
    const entryCand = uuidv7();
    const entryWaves = uuidv7();
    await client`
      INSERT INTO pulse_entries (id, run_id, kind, candidate_id, rank, title, description, created_at) VALUES
        (${entryCand}, ${runId}, 'candidate', ${candId}, 1,
         'Pulse story', ${'↳ angle line\neconomy · score 84 · rising'}, NOW()),
        (${entryWaves}, ${runId}, 'waves', NULL, NULL,
         'Waves — 2026-07-05', ${'theme-a · 3 clusters · economy'}, NOW() - INTERVAL '1 minute')
    `;

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const pulse = await parser.parseString(await readFile(join(outDir, 'pulse.xml'), 'utf-8'));

    expect(pulse.items).toHaveLength(2);
    // Newest-first: the candidate entry precedes the older waves entry.
    expect(pulse.items.map((i) => i.guid)).toEqual([entryCand, entryWaves]);
    expect(pulse.items[0]!.link).toBe(`https://${PUBLIC_HOST}/c/${candId}`);
    expect(pulse.items[0]!.content).toContain('angle line');
    expect(pulse.items[1]!.link).toBe(`https://${PUBLIC_HOST}/`);
  });

  it('brief.xml renders one entry per week with full pitch HTML in content:encoded (P1)', async () => {
    const briefId = uuidv7();
    const pitches = [
      {
        hook: 'The hook <line>',
        thesis: 'T',
        steelman: 'S',
        break: 'B',
        whyNow: 'W',
        fit: 'F',
        evidence: [{ title: 'FT piece', url: 'https://ft.example.com/x' }],
        candidateIds: [],
      },
    ];
    await client`
      INSERT INTO briefs (id, week_of, pitches, content_md, model)
      VALUES (${briefId}, '2026-07-05'::date,
              ${JSON.stringify(pitches)}::jsonb, 'md body', 'claude-sonnet-4.5')
    `;

    await generateAllFeeds(db, outDir, PUBLIC_HOST);
    const raw = await readFile(join(outDir, 'brief.xml'), 'utf-8');
    const brief = await parser.parseString(raw);

    expect(brief.items).toHaveLength(1);
    expect(brief.items[0]!.title).toBe('Weekly Ideation Brief — 2026-07-05 (1 pitches)');
    expect(brief.items[0]!.guid).toBe(briefId);
    expect(brief.items[0]!.link).toBe(`https://${PUBLIC_HOST}/brief/2026-07-05`);
    // description carries the hooks; content:encoded carries escaped HTML
    // (raw-byte check: the pitch HTML is entitised, not raw markup).
    expect(brief.items[0]!.contentSnippet ?? brief.items[0]!.content).toContain('The hook');
    expect(raw).toContain('&lt;h2&gt;');
    expect(raw).toContain('The hook &amp;lt;line&amp;gt;');
  });
});
