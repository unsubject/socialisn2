// Phase 3 sub-budget buckets.
//
// Why buckets and not just per-stage ceilings: a stage label
// ('normalise', 'embed', 'stage4_summarise', 'stage6_curate') is the
// fine-grained breakdown used for reporting. A bucket is the coarser
// allowance over which we enforce a separate daily ceiling. We want
// runaway costs in ONE bucket not to consume the whole daily ceiling
// before the OTHER bucket gets a fair share.
//
// Two buckets today:
//   - 'normalize'   — covers normalise + embed: per raw-item work,
//                     ingestion-tier volume, small per-call cost
//   - 'orchestrator'— covers stage4_summarise + stage6_curate: only
//                     fires inside the twice-daily orchestrator pass,
//                     bigger per-call cost (Gemini 3.5 Flash for curate)
//
// If a stage is recorded without an explicit bucket (legacy code,
// ad-hoc test), `bucketForStage` returns null — the row will count
// toward the overall daily ceiling but not against any bucket.

export const BUCKET_NORMALIZE = 'normalize' as const;
export const BUCKET_ORCHESTRATOR = 'orchestrator' as const;

export type CostBucket =
  | typeof BUCKET_NORMALIZE
  | typeof BUCKET_ORCHESTRATOR;

/**
 * Map a stage label to its bucket. Returns null for stages we don't
 * recognise (so the caller's INSERT stays valid — bucket is nullable
 * in the schema).
 *
 * Keep this list aligned with the `stage:` literals passed to
 * `recordCost()` from src/scoring/process-raw-item.ts and
 * src/orchestrator/run.ts. A new stage that lacks a mapping here will
 * silently fall through to the overall-ceiling-only path; add the
 * mapping when introducing a new stage.
 */
export function bucketForStage(stage: string | undefined): CostBucket | null {
  if (!stage) return null;
  switch (stage) {
    case 'normalise':
    case 'embed':
      return BUCKET_NORMALIZE;
    case 'stage4_summarise':
    case 'stage6_curate':
      return BUCKET_ORCHESTRATOR;
    default:
      return null;
  }
}
