// Real-PG integration test for src/backfill/run.ts (SPEC §13 + ADR-012).
// Both external surfaces (YouTube Data API + 2nd-brain MCP) are
// dependency-injected so CI doesn't need YOUTUBE_API_KEY or a live
// 2nd-brain endpoint.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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
import {
  runBackfill,
  V1_GDELT_HISTORY_STATUS,
  V1_RSS_HISTORY_STATUS,
  YOUTUBE_WINDOW_DAYS,
} from '../../src/backfill/run.js';
import type { YouTubeVideo } from '../../src/ingestion/youtube_data.js';
import type { ArchiveProbeResult } from '../../src/lib/two_brain_client.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.YOUTUBE_CHANNEL_HANDLE = '@test-channel';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeVideos(count: number): YouTubeVideo[] {
  return Array.from({ length: count }, (_, i) => ({
    videoId: `vid-${i}`,
    url: `https://www.youtube.com/watch?v=vid-${i}`,
    title: `Video ${i}`,
    description: `desc ${i}`,
    publishedAt: new Date(Date.now() - i * 86_400_000),
    channelId: 'UCtest',
  }));
}

describe.skipIf(!DATABASE_URL)('runBackfill (SPEC §13 + ADR-012)', () => {
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
    await client.unsafe('TRUNCATE TABLE backfill_run CASCADE');
  });

  it('happy path: writes a completed row with both corpora present', async () => {
    const handleSeen: string[] = [];
    const sinceSeen: Date[] = [];

    const result = await runBackfill(db, {
      fetchChannelVideos: async (handle, since) => {
        handleSeen.push(handle);
        sinceSeen.push(since);
        return makeVideos(12);
      },
      probeBrainCorpus: async (): Promise<ArchiveProbeResult> => ({
        status: 'available',
        hitCount: 5,
      }),
    });

    expect(result.status).toBe('completed');
    expect(result.rssHistoryStatus).toBe(V1_RSS_HISTORY_STATUS);
    expect(result.gdeltHistoryStatus).toBe(V1_GDELT_HISTORY_STATUS);
    expect(result.youtubeCorpusSize).toBe(12);
    expect(result.brainCorpusStatus).toBe('available');
    expect(result.error).toBeUndefined();

    // Window is exactly YOUTUBE_WINDOW_DAYS long.
    const ms = result.windowEnd.getTime() - result.windowStart.getTime();
    expect(ms).toBe(YOUTUBE_WINDOW_DAYS * 86_400_000);

    // Handle from env, since matches windowStart exactly.
    expect(handleSeen).toEqual(['@test-channel']);
    expect(sinceSeen[0]!.getTime()).toBe(result.windowStart.getTime());

    // Row reflects everything. postgres-js's tagged-template client
    // returns timestamp columns as strings (no pg type parsers run
    // on the raw-SQL path), so timestamp reads are typed as `string`
    // and wrapped with `new Date(...)` at the assertion site — same
    // pattern as `started_at` below.
    const rows = await client<
      Array<{
        id: string;
        status: string;
        rss_history_status: string;
        gdelt_history_status: string;
        youtube_corpus_size: number;
        brain_corpus_status: string;
        error: string | null;
        metadata: Record<string, unknown>;
        started_at: string;
        completed_at: string;
      }>
    >`SELECT * FROM backfill_run`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(result.backfillRunId);
    expect(row.status).toBe('completed');
    expect(row.rss_history_status).toBe('skipped');
    expect(row.gdelt_history_status).toBe('skipped');
    expect(row.youtube_corpus_size).toBe(12);
    expect(row.brain_corpus_status).toBe('available');
    expect(row.error).toBeNull();
    expect(row.completed_at).not.toBeNull();
    // Pins the INSERT→UPDATE state transition: started_at is set by the
    // initial 'running' insert, completed_at by the final 'completed'
    // update. Both must be set, and completion must follow start.
    expect(row.started_at).not.toBeNull();
    expect(new Date(row.completed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.started_at).getTime(),
    );
    expect(row.metadata).toMatchObject({
      adr: 'ADR-012',
      youtube_channel_handle: '@test-channel',
      brain_corpus_hits: 5,
    });
  });

  it('records youtube_fetch_failed in error when fetch throws', async () => {
    const result = await runBackfill(db, {
      fetchChannelVideos: async () => {
        throw new Error('YOUTUBE_API_KEY not set');
      },
      probeBrainCorpus: async () => ({ status: 'available', hitCount: 0 }),
    });

    expect(result.status).toBe('completed');
    expect(result.youtubeCorpusSize).toBe(0);
    expect(result.brainCorpusStatus).toBe('available');
    expect(result.error).toMatch(/youtube_fetch_failed/);
    expect(result.error).toMatch(/YOUTUBE_API_KEY not set/);

    const rows = await client<{ error: string | null; youtube_corpus_size: number }[]>`
      SELECT error, youtube_corpus_size FROM backfill_run
    `;
    expect(rows[0]!.error).toMatch(/youtube_fetch_failed/);
    expect(rows[0]!.youtube_corpus_size).toBe(0);
  });

  it('records brain_probe_unreachable in error when probe returns unreachable', async () => {
    const result = await runBackfill(db, {
      fetchChannelVideos: async () => makeVideos(3),
      probeBrainCorpus: async () => ({
        status: 'unreachable',
        hitCount: 0,
        reason: 'connect ECONNREFUSED 127.0.0.1:8787',
      }),
    });

    expect(result.status).toBe('completed');
    expect(result.youtubeCorpusSize).toBe(3);
    expect(result.brainCorpusStatus).toBe('unreachable');
    expect(result.error).toMatch(/brain_probe_unreachable/);
    expect(result.error).toMatch(/ECONNREFUSED/);

    const rows = await client<{ error: string | null; brain_corpus_status: string }[]>`
      SELECT error, brain_corpus_status FROM backfill_run
    `;
    expect(rows[0]!.brain_corpus_status).toBe('unreachable');
  });

  it('does NOT treat brain_corpus_status=not_configured as an error', async () => {
    const result = await runBackfill(db, {
      fetchChannelVideos: async () => makeVideos(4),
      probeBrainCorpus: async () => ({
        status: 'not_configured',
        hitCount: 0,
        reason: 'TWO_BRAIN_MCP_URL or TWO_BRAIN_MCP_TOKEN unset',
      }),
    });

    expect(result.status).toBe('completed');
    expect(result.brainCorpusStatus).toBe('not_configured');
    expect(result.error).toBeUndefined();

    const rows = await client<{ error: string | null; brain_corpus_status: string }[]>`
      SELECT error, brain_corpus_status FROM backfill_run
    `;
    expect(rows[0]!.error).toBeNull();
    expect(rows[0]!.brain_corpus_status).toBe('not_configured');
  });

  it('aggregates both component errors into runs.error when both fail', async () => {
    const result = await runBackfill(db, {
      fetchChannelVideos: async () => {
        throw new Error('quota exceeded');
      },
      probeBrainCorpus: async () => ({
        status: 'unreachable',
        hitCount: 0,
        reason: 'HTTP 503',
      }),
    });

    expect(result.status).toBe('completed');
    expect(result.youtubeCorpusSize).toBe(0);
    expect(result.brainCorpusStatus).toBe('unreachable');
    expect(result.error).toMatch(/youtube_fetch_failed.*quota exceeded/);
    expect(result.error).toMatch(/brain_probe_unreachable.*HTTP 503/);
    // Joined with `; ` between parts (mirroring the runs.error convention).
    expect(result.error).toContain('; ');
  });

  it('survives a probe stub that throws (defensive wrapper)', async () => {
    const result = await runBackfill(db, {
      fetchChannelVideos: async () => makeVideos(1),
      probeBrainCorpus: async () => {
        throw new Error('stub regression — probe never throws in prod');
      },
    });

    expect(result.status).toBe('completed');
    expect(result.brainCorpusStatus).toBe('unreachable');
    expect(result.error).toMatch(/brain_probe_unreachable.*stub regression/);
  });

  it('window_start matches Now minus YOUTUBE_WINDOW_DAYS within 5s', async () => {
    const t0 = Date.now();
    const result = await runBackfill(db, {
      fetchChannelVideos: async () => makeVideos(0),
      probeBrainCorpus: async () => ({ status: 'available', hitCount: 0 }),
    });
    const t1 = Date.now();

    const expectedStart = (t0 + t1) / 2 - YOUTUBE_WINDOW_DAYS * 86_400_000;
    expect(Math.abs(result.windowStart.getTime() - expectedStart)).toBeLessThan(5000);
  });
});
