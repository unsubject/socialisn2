// Smoke-tests the seed migrations 002-004. Resets `public`, applies every
// migrations/*.sql in order, then asserts row counts and a handful of
// representative rows. Confirms the migration set produces a coherent
// initial sources/competitors state.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('migrations 001-004 (schema + seeds)', () => {
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    const dir = resolve(process.cwd(), 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf-8');
      await client.unsafe(sql);
    }
  });

  afterAll(async () => {
    await client?.end();
  });

  it('seeds the expected row counts by sources.kind', async () => {
    const rows = await client<{ kind: string; n: number }[]>`
      SELECT kind, COUNT(*)::int AS n FROM sources GROUP BY kind ORDER BY kind
    `;
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    // 31 = 7 (§6.9 newsletter-only) + 10 (§6.1) + 8 (§6.2) + 6 (§6.4)
    expect(byKind.email_bridge).toBe(31);
    expect(byKind.arxiv).toBe(3);
    // 80 RSS rows in 002 (§6.1–§6.6 entries with URLs in SPEC).
    expect(byKind.rss).toBe(80);
  });

  it('seeds Reuters via email-bridge (§6.1 → §6.9)', async () => {
    const rows = await client<{ url: string; authority_score: number }[]>`
      SELECT url, authority_score
      FROM sources
      WHERE kind = 'email_bridge' AND name = 'Reuters'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.url).toBe('https://inbox.socialisn.com/feeds/reuters.xml');
    expect(rows[0]?.authority_score).toBe(85);
  });

  it('seeds NBER via email-bridge (§6.4 → §6.9)', async () => {
    const rows = await client<{ url: string; authority_score: number }[]>`
      SELECT url, authority_score
      FROM sources
      WHERE kind = 'email_bridge' AND name = 'NBER Working Papers'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.url).toBe('https://inbox.socialisn.com/feeds/nber.xml');
    expect(rows[0]?.authority_score).toBe(70);
  });

  it('leaves competitors empty (003 is placeholder)', async () => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM competitors
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it('seeds the Anthropic email-bridge with the expected feed URL', async () => {
    const rows = await client<{ url: string; authority_score: number }[]>`
      SELECT url, authority_score
      FROM sources
      WHERE kind = 'email_bridge' AND name = 'Anthropic news'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.url).toBe('https://inbox.socialisn.com/feeds/anthropic.xml');
    expect(rows[0]?.authority_score).toBe(80);
  });

  it('seeds Sinocism (§6.6) with authority 80', async () => {
    const rows = await client<{ authority_score: number }[]>`
      SELECT authority_score FROM sources WHERE url = 'https://sinocism.com/feed'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.authority_score).toBe(80);
  });

  it('seeds arXiv cs.AI / cs.CL / cs.LG with kind=arxiv', async () => {
    const rows = await client<{ name: string }[]>`
      SELECT name FROM sources WHERE kind = 'arxiv' ORDER BY name
    `;
    expect(rows.map((r) => r.name)).toEqual(['arXiv cs.AI', 'arXiv cs.CL', 'arXiv cs.LG']);
  });
});
