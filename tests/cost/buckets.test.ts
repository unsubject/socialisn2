// Pure-function unit test for bucketForStage.
//
// Why this file exists separately from tests/cost/ledger.test.ts: the
// real-PG bucket tests are gated by DATABASE_URL and only run in
// CI / on a developer with a local pgvector instance. A stage→bucket
// regression would silently miscategorise spend in every environment
// without PG. This 10-line pure-function test runs in every CI lane
// AND on `vitest run` against a dev machine without DATABASE_URL set,
// so the operator-facing scope signal stays correct even if the
// real-PG suite is skipped.

import { describe, expect, it } from 'vitest';

import {
  BUCKET_NORMALIZE,
  BUCKET_ORCHESTRATOR,
  bucketForStage,
} from '../../src/cost/buckets.js';

describe('bucketForStage', () => {
  it('maps the normalize tier stages', () => {
    expect(bucketForStage('normalise')).toBe(BUCKET_NORMALIZE);
    expect(bucketForStage('embed')).toBe(BUCKET_NORMALIZE);
  });

  it('maps the orchestrator tier stages', () => {
    expect(bucketForStage('stage4_summarise')).toBe(BUCKET_ORCHESTRATOR);
    expect(bucketForStage('stage6_curate')).toBe(BUCKET_ORCHESTRATOR);
  });

  it('returns null for legacy / unknown stages so the row is still recorded but does not affect any sub-budget total', () => {
    // Legacy stages from before the bucket migration.
    expect(bucketForStage('curate')).toBeNull();
    // Anything outside the closed set.
    expect(bucketForStage('unknown_future_stage')).toBeNull();
    expect(bucketForStage('Stage4_Summarise')).toBeNull(); // case-sensitive
  });

  it('returns null for undefined / empty so recordCost without a stage is still valid', () => {
    expect(bucketForStage(undefined)).toBeNull();
    expect(bucketForStage('')).toBeNull();
  });
});
