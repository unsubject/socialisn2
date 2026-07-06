// Real-PG tests for the get_brief MCP tool (redesign P1). Matches the
// repo convention that every DB-touching tool gets a real-PG test.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema.js';
import { getBrief } from '../../src/mcp/tools/brief.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('mcp tools/brief getBrief (real PG)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, f), 'utf-8'));
    }
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE briefs CASCADE');
  });

  async function seedBrief(weekOf: string, hook: string): Promise<string> {
    const id = uuidv7();
    const pitches = [
      {
        hook,
        thesis: 'T',
        steelman: 'S',
        break: 'B',
        whyNow: 'W',
        fit: 'F',
        evidence: [{ title: 't', url: 'https://example.com/e' }],
        candidateIds: [],
      },
    ];
    await client`
      INSERT INTO briefs (id, week_of, pitches, content_md, model)
      VALUES (${id}, ${weekOf}::date, ${JSON.stringify(pitches)}::jsonb,
              ${'# Brief ' + weekOf}, 'claude-sonnet-4.5')
    `;
    return id;
  }

  it('returns the latest brief when week_of is omitted', async () => {
    await seedBrief('2026-06-28', 'older hook');
    const newest = await seedBrief('2026-07-05', 'newest hook');

    const result = await getBrief(db, {});
    expect(result.brief.id).toBe(newest);
    expect(result.brief.week_of).toBe('2026-07-05');
    expect(result.brief.pitch_count).toBe(1);
    expect(result.brief.pitches[0]!.hook).toBe('newest hook');
    expect(result.brief.content_md).toContain('2026-07-05');
  });

  it('returns a specific week when week_of is given', async () => {
    const older = await seedBrief('2026-06-28', 'older hook');
    await seedBrief('2026-07-05', 'newest hook');

    const result = await getBrief(db, { week_of: '2026-06-28' });
    expect(result.brief.id).toBe(older);
  });

  it('throws a clear not-found error', async () => {
    await expect(getBrief(db, {})).rejects.toThrow(/no briefs yet/);
    await seedBrief('2026-07-05', 'h');
    await expect(getBrief(db, { week_of: '2026-01-04' })).rejects.toThrow(
      /no brief for week 2026-01-04/,
    );
  });

  it('rejects malformed week_of via zod', async () => {
    await expect(getBrief(db, { week_of: 'next sunday' })).rejects.toThrow();
    // Shaped-but-impossible dates are rejected BEFORE the ::date cast
    // (codex #157 class) — zod refine, not a PG out-of-range error.
    await expect(getBrief(db, { week_of: '2026-13-99' })).rejects.toThrow(
      /not a real calendar date/,
    );
  });
});
