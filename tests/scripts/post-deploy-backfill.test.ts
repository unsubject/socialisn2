// Pure-function tests for the post-deploy verdict logic. The actual
// runBackfill call is integration-tested in tests/backfill/run.test.ts;
// here we just pin the deploy-green decision against every status
// the backfill can return.

import { describe, expect, it } from 'vitest';

import { isDeployGreen } from '../../scripts/post-deploy-backfill.js';
import type { BackfillResult } from '../../src/backfill/run.js';

function mkResult(overrides: Partial<BackfillResult> = {}): BackfillResult {
  return {
    backfillRunId: '00000000-0000-7000-8000-000000000000',
    status: 'completed',
    rssHistoryStatus: 'skipped',
    gdeltHistoryStatus: 'skipped',
    youtubeCorpusSize: 12,
    brainCorpusStatus: 'available',
    windowStart: new Date('2026-04-19T00:00:00Z'),
    windowEnd: new Date('2026-05-19T00:00:00Z'),
    ...overrides,
  };
}

describe('isDeployGreen', () => {
  it('green when brain_corpus_status === "available"', () => {
    const verdict = isDeployGreen(mkResult());
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toMatch(/available/);
    expect(verdict.reason).toMatch(/youtube_corpus_size=12/);
  });

  it('aborts on "unreachable" with the error text surfaced', () => {
    const verdict = isDeployGreen(
      mkResult({
        brainCorpusStatus: 'unreachable',
        error:
          'brain_probe_unreachable: ECONNREFUSED connect to 2ndbrain.example.com',
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/unreachable/);
    expect(verdict.reason).toMatch(/ECONNREFUSED/);
    expect(verdict.reason).toMatch(/Stage 5/);
  });

  it('aborts on "unreachable" even when error field is empty', () => {
    const verdict = isDeployGreen(
      mkResult({
        brainCorpusStatus: 'unreachable',
        error: undefined,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/unreachable/);
    expect(verdict.reason).toMatch(/none recorded/);
  });

  it('aborts on "not_configured" — silent-failure surface', () => {
    const verdict = isDeployGreen(
      mkResult({ brainCorpusStatus: 'not_configured' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not_configured/);
    expect(verdict.reason).toMatch(/TWO_BRAIN_MCP_URL/);
    expect(verdict.reason).toMatch(/archive_overlap=0/);
  });

  it('aborts on an unrecognised status (defensive default)', () => {
    const verdict = isDeployGreen(
      mkResult({
        // Cast to drive the unreachable-default branch — closed-set
        // union typing would normally prevent this at compile time,
        // but a future ADR could add a new value and accidentally
        // ship before this script is updated.
        brainCorpusStatus: 'pending' as BackfillResult['brainCorpusStatus'],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/unrecognised status/);
    expect(verdict.reason).toMatch(/pending/);
  });
});
