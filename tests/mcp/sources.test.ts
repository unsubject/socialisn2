// Real-PG tests for src/mcp/tools/sources.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { addInfluencer, expandCompetitorList } from '../../src/mcp/tools/sources.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('mcp tools/sources', () => {
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
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE competitors CASCADE');
    await client.unsafe('TRUNCATE TABLE sources CASCADE');
  });

  // -------------------------------------------------------------------------
  // expand_competitor_list
  // -------------------------------------------------------------------------

  it('expand_competitor_list: inserts a youtube row with parsed channel id', async () => {
    const result = await expandCompetitorList(db, {
      channel_url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuvwx',
      priority_tier: 1,
    });
    expect(result.competitor_id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await client<{ external_id: string; priority_tier: number; platform: string }[]>`
      SELECT external_id, priority_tier, platform FROM competitors WHERE id = ${result.competitor_id}
    `;
    expect(rows[0]?.external_id).toBe('UCabcdefghijklmnopqrstuvwx');
    expect(rows[0]?.priority_tier).toBe(1);
    expect(rows[0]?.platform).toBe('youtube');
  });

  it('expand_competitor_list: defaults priority_tier to 2', async () => {
    const result = await expandCompetitorList(db, {
      channel_url: 'https://youtube.com/channel/UC12345678901234567890123',
    });
    const rows = await client<{ priority_tier: number }[]>`
      SELECT priority_tier FROM competitors WHERE id = ${result.competitor_id}
    `;
    expect(rows[0]?.priority_tier).toBe(2);
  });

  it('expand_competitor_list: idempotent on duplicate channel id', async () => {
    const url = 'https://www.youtube.com/channel/UCqwertyuiopasdfghjklzxcv';
    const a = await expandCompetitorList(db, { channel_url: url });
    const b = await expandCompetitorList(db, { channel_url: url });
    expect(a.competitor_id).toBe(b.competitor_id);
    const rows = await client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM competitors`;
    expect(rows[0]?.n).toBe(1);
  });

  it('expand_competitor_list: throws on /@handle URL form', async () => {
    await expect(
      expandCompetitorList(db, { channel_url: 'https://youtube.com/@handle' }),
    ).rejects.toThrow(/cannot extract channel id/);
  });

  it('expand_competitor_list: rejects non-URL via zod', async () => {
    await expect(
      expandCompetitorList(db, { channel_url: 'not-a-url' }),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // add_influencer
  // -------------------------------------------------------------------------

  it('add_influencer: inserts an rss source with SPEC §6.6 defaults', async () => {
    const result = await addInfluencer(db, {
      handle_or_url: 'https://noahpinion.blog/feed',
      domain: 'economics',
    });
    expect(result.source_id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await client<{
      kind: string;
      authority_score: number;
      fetch_interval_min: number;
      enabled: boolean;
      domains: string[];
      name: string;
    }[]>`
      SELECT kind, authority_score, fetch_interval_min, enabled, domains, name
      FROM sources WHERE id = ${result.source_id}
    `;
    expect(rows[0]?.kind).toBe('rss');
    expect(rows[0]?.authority_score).toBe(60);
    expect(rows[0]?.fetch_interval_min).toBe(60);
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.domains).toEqual(['economics']);
    expect(rows[0]?.name).toBe('noahpinion.blog');
  });

  it('add_influencer: defaults domain to economy when omitted', async () => {
    const result = await addInfluencer(db, {
      handle_or_url: 'https://example.com/rss',
    });
    const rows = await client<{ domains: string[] }[]>`
      SELECT domains FROM sources WHERE id = ${result.source_id}
    `;
    expect(rows[0]?.domains).toEqual(['economy']);
  });

  it('add_influencer: throws on non-URL shorthand', async () => {
    await expect(
      addInfluencer(db, { handle_or_url: 'noahpinion' }),
    ).rejects.toThrow(/must be a full URL/);
  });
});
