// Post-deploy assertion: run the v1 backfill (SPEC §13 + ADR-012) and
// require `brain_corpus_status === 'available'` before the deploy
// workflow declares success.
//
// Intentionally strict on 'not_configured': PR #64 review P2 #3 flagged
// that silently shipping a prod with TWO_BRAIN_MCP_URL/TOKEN unset
// would degrade scoring Stage 5 to a no-op without surfacing as a
// failure. The deploy aborts visibly here instead.
//
// Intentionally lenient on YouTube fetch failures: runBackfill
// aggregates `youtube_fetch_failed: ...` into result.error alongside
// the brain status, but isDeployGreen only consults brainCorpusStatus.
// A transient YT quota error or 5xx shouldn't fail the entire deploy
// because the corpus_size column is informational, not load-bearing.
// The error column on the backfill_run row still records it for
// triage.
//
// Invoked from .github/workflows/deploy-vps.yml via
//   docker compose run --rm app node dist/scripts/post-deploy-backfill.js
// so the env inside the container matches what the freshly-restarted
// app/scoring-worker will run with.

import process from 'node:process';

import { createDb } from '../src/db/client.js';
import { runBackfill, type BackfillResult } from '../src/backfill/run.js';

/**
 * Decide whether the backfill result represents a green deploy.
 * Exported so the unit test can drive each status path without
 * spinning up the full createDb + runBackfill stack.
 */
export function isDeployGreen(result: BackfillResult): {
  ok: boolean;
  reason: string;
} {
  switch (result.brainCorpusStatus) {
    case 'available':
      return {
        ok: true,
        reason: `brain_corpus_status='available' (hits via probeArchiveSearch). youtube_corpus_size=${result.youtubeCorpusSize}.`,
      };
    case 'unreachable':
      return {
        ok: false,
        reason:
          `brain_corpus_status='unreachable' — TWO_BRAIN_MCP_URL/TOKEN are set but probeArchiveSearch failed. ` +
          `Backfill error: ${result.error ?? '(none recorded)'}. ` +
          `Stage 5 archive overlap will degrade to 0 on every scoring run until this is fixed.`,
      };
    case 'not_configured':
      return {
        ok: false,
        reason:
          `brain_corpus_status='not_configured' — TWO_BRAIN_MCP_URL and/or TWO_BRAIN_MCP_TOKEN unset in the deployed .env. ` +
          `Aborting rather than silently shipping a prod with archive_overlap=0 every run.`,
      };
    // Defensive — ArchiveProbeStatus is a closed union, but a future
    // status value would default to abort so the deploy isn't tricked
    // into green by an unrecognised string.
    default:
      return {
        ok: false,
        reason: `brain_corpus_status='${result.brainCorpusStatus as string}' — unrecognised status, aborting.`,
      };
  }
}

async function main(): Promise<void> {
  const { db, close } = createDb();
  try {
    const result = await runBackfill(db);
    const verdict = isDeployGreen(result);
    if (verdict.ok) {
      console.log(`[post-deploy] OK: ${verdict.reason}`);
      console.log(`[post-deploy] backfill_run id=${result.backfillRunId}`);
      // Surface YT-fetch degradations (they don't fail the deploy but
      // operators still want to see them in the workflow log without
      // SELECTing from backfill_run).
      if (result.error) {
        console.warn(`[post-deploy] backfill_run.error recorded: ${result.error}`);
      }
      return;
    }
    console.error(`[post-deploy] DEPLOY ABORT: ${verdict.reason}`);
    console.error(`[post-deploy] backfill_run id=${result.backfillRunId}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

// Allow tests to import isDeployGreen without main() executing.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('[post-deploy] fatal:', err);
    process.exit(1);
  });
}
