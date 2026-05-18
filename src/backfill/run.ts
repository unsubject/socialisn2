// Phase 5 PR 1 — backfill orchestrator per SPEC §13 + ADR-012.
//
// ADR-012 superseded ADR-011 and reduced the SPEC §13 scope to a
// provenance + corpus-availability check, NOT a historical clustering
// job. The reasoning is captured in
// `docs/adr/012-backfill-skip-all-historical-sources.md`; the short
// version:
//
//   - RSS feeds are append-only ring buffers — no v1 path to query
//     30 days back.
//   - `src/ingestion/gdelt.ts` is per-cluster enrichment, not a
//     discovery firehose — no v1 path for GDELT to drive historical
//     clusters either.
//   - SPEC §14 already commits the system to forward-observation-based
//     source authority calibration; backfill calibration is redundant.
//
// What runBackfill actually does:
//
//   1. INSERT a `backfill_run` row with status='running' before any
//      network I/O. A crash mid-run leaves a triageable row.
//   2. Fetch the last-12mo of Simon's YouTube channel videos via the
//      Data API (`fetchChannelVideosSince` from
//      src/ingestion/youtube_data.ts). Failures are caught — they
//      degrade the row's `youtube_corpus_size` to 0 + add to
//      `error`, they don't fail the run.
//   3. Probe `archive_search` MCP reachability via
//      `probeArchiveSearch` from src/lib/two_brain_client.ts. The
//      probe returns one of three states (`available` |
//      `unreachable` | `not_configured`) and never throws. The
//      'unreachable' state ALSO contributes to `error`; the
//      'not_configured' state does not (it's an intentional deploy
//      state, not a failure).
//   4. UPDATE the row with `status='completed'`, both `*_history_status`
//      = 'skipped' (closed-set CHECK constraint per migration 013),
//      `youtube_corpus_size`, `brain_corpus_status`, and the
//      aggregated `error` (NULL when no degradation).
//
// The function always returns `status='completed'` unless the DB UPDATE
// itself fails (catastrophic — surfaces as a thrown error and the row
// stays 'running' for human triage). Per-component degradations are
// recorded in the row, not surfaced as failure.
//
// Dependency injection mirrors src/orchestrator/run.ts: the live YouTube
// + MCP calls are defaults, tests pass stubs so CI doesn't need network
// or API keys.

import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import {
  fetchChannelVideosSince,
  type YouTubeVideo,
} from '../ingestion/youtube_data.js';
import {
  probeArchiveSearch as defaultProbeArchiveSearch,
  type ArchiveProbeResult,
  type ArchiveProbeStatus,
} from '../lib/two_brain_client.js';

/** Window length for the YouTube corpus fetch. SPEC §13 directs
 *  "last 12 months of videos". Exported so tests can read the same
 *  constant the orchestrator uses. */
export const YOUTUBE_WINDOW_DAYS = 365;

/** Closed-set values stored in `backfill_run.rss_history_status` and
 *  `gdelt_history_status` in v1 per ADR-012. Migration 013's CHECK
 *  constraint reserves additional values for future ADRs. */
export const V1_RSS_HISTORY_STATUS = 'skipped' as const;
export const V1_GDELT_HISTORY_STATUS = 'skipped' as const;

export interface BackfillDependencies {
  /** Override the YouTube channel video fetcher. Defaults to the live
   *  Data API client (`fetchChannelVideosSince`). Tests pass a stub so
   *  CI doesn't burn YOUTUBE_API_KEY quota. */
  fetchChannelVideos?: (handle: string, since: Date) => Promise<YouTubeVideo[]>;
  /** Override the 2nd-brain probe. Defaults to `probeArchiveSearch`,
   *  which itself never throws (returns a status struct). Tests pass
   *  a stub to drive each of the three states deterministically. */
  probeBrainCorpus?: () => Promise<ArchiveProbeResult>;
}

export interface BackfillResult {
  backfillRunId: string;
  /** Always 'completed' on a successful UPDATE. The DB UPDATE failing
   *  is the only catastrophic path, and surfaces as a thrown error
   *  (caller sees no result). */
  status: 'completed';
  rssHistoryStatus: typeof V1_RSS_HISTORY_STATUS;
  gdeltHistoryStatus: typeof V1_GDELT_HISTORY_STATUS;
  youtubeCorpusSize: number;
  brainCorpusStatus: ArchiveProbeStatus;
  windowStart: Date;
  windowEnd: Date;
  /** Aggregated degradation reasons. NULL when both components succeeded
   *  (or when brain probe returned 'not_configured' — that's not a
   *  failure). */
  error?: string;
}

/**
 * Run the v1 backfill (SPEC §13 + ADR-012). Returns once the
 * `backfill_run` row has been written. See module header for the
 * runbook-level semantics; this function exists to give the deploy
 * script (Phase 5 PR 2) and a future MCP tool a single call to invoke.
 */
export async function runBackfill(
  db: Db,
  deps: BackfillDependencies = {},
): Promise<BackfillResult> {
  const fetchVideos = deps.fetchChannelVideos ?? defaultFetchChannelVideos;
  const probeBrain = deps.probeBrainCorpus ?? defaultProbeArchiveSearch;

  const backfillRunId = uuidv7();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - YOUTUBE_WINDOW_DAYS * 86_400_000);

  // INSERT before any I/O so a crash leaves a 'running' row for triage.
  await db.execute(sql`
    INSERT INTO backfill_run (id, status, window_start, window_end)
    VALUES (
      ${backfillRunId},
      'running',
      ${windowStart.toISOString()}::timestamptz,
      ${windowEnd.toISOString()}::timestamptz
    )
  `);

  const handle = env.youtubeChannelHandle();

  let youtubeCorpusSize = 0;
  let youtubeError: string | undefined;
  try {
    const videos = await fetchVideos(handle, windowStart);
    youtubeCorpusSize = videos.length;
  } catch (err) {
    youtubeError = err instanceof Error ? err.message : String(err);
    console.warn(`[backfill] youtube fetch failed: ${youtubeError}`);
  }

  let brainProbe: ArchiveProbeResult;
  try {
    brainProbe = await probeBrain();
  } catch (err) {
    // probeArchiveSearch is documented not to throw, but a stubbed
    // probe might (or a future change could regress the guarantee).
    // Treat the throw as 'unreachable' with the message captured for
    // the error column, so the row still lands.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[backfill] brain probe threw: ${msg}`);
    brainProbe = { status: 'unreachable', hitCount: 0, reason: msg };
  }

  // Aggregate per-component degradations into the row's error column.
  // 'not_configured' is intentional (no env vars in this environment)
  // and is NOT a failure — it just gets recorded in brain_corpus_status.
  const errorParts: string[] = [];
  if (youtubeError) {
    errorParts.push(`youtube_fetch_failed: ${youtubeError.slice(0, 200)}`);
  }
  if (brainProbe.status === 'unreachable') {
    errorParts.push(
      `brain_probe_unreachable: ${(brainProbe.reason ?? '').slice(0, 200)}`,
    );
  }
  const error = errorParts.length === 0 ? null : errorParts.join('; ');

  const metadata = {
    adr: 'ADR-012',
    youtube_channel_handle: handle,
    brain_corpus_hits: brainProbe.hitCount,
  };

  await db.execute(sql`
    UPDATE backfill_run
    SET completed_at         = NOW(),
        status               = 'completed',
        rss_history_status   = ${V1_RSS_HISTORY_STATUS},
        gdelt_history_status = ${V1_GDELT_HISTORY_STATUS},
        youtube_corpus_size  = ${youtubeCorpusSize},
        brain_corpus_status  = ${brainProbe.status},
        error                = ${error},
        metadata             = ${sql.raw("'" + JSON.stringify(metadata).replace(/'/g, "''") + "'")}::jsonb
    WHERE id = ${backfillRunId}
  `);

  return {
    backfillRunId,
    status: 'completed',
    rssHistoryStatus: V1_RSS_HISTORY_STATUS,
    gdeltHistoryStatus: V1_GDELT_HISTORY_STATUS,
    youtubeCorpusSize,
    brainCorpusStatus: brainProbe.status,
    windowStart,
    windowEnd,
    error: error ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

/** Real YouTube fetcher used when no stub is injected. Wraps
 *  fetchChannelVideosSince so the signature matches the dependency
 *  contract (handle, since) → videos[]. */
async function defaultFetchChannelVideos(
  handle: string,
  since: Date,
): Promise<YouTubeVideo[]> {
  return fetchChannelVideosSince(handle, since);
}
