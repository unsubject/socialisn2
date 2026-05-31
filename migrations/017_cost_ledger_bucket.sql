-- Phase 3: per-stage sub-budgets.
--
-- Adds a `bucket` column to cost_ledger so per-bucket daily totals can
-- be enforced independently of the overall daily ceiling. The fine
-- `stage` column stays for breakdown / reporting; `bucket` is the
-- coarser grouping over which we enforce a separate ceiling.
--
-- Bucket values (defined in src/cost/buckets.ts):
--   'normalize'    — covers stage='normalise' + stage='embed' (per
--                    raw-item work, runs all day at high volume).
--   'orchestrator' — covers stage='stage4_summarise' + 'stage6_curate'
--                    (twice-daily orchestrator pass).
--
-- Older rows have NULL bucket. The bucket-specific daily total query
-- skips NULL via the WHERE clause, so historical rows still appear in
-- the overall total but don't count against any single bucket. New
-- writes after this migration always carry a bucket.

ALTER TABLE cost_ledger
  ADD COLUMN bucket TEXT;

-- Partial index — only non-NULL buckets are queried by
-- dailyTotalUsdByBucket. Avoids index-bloat on the historical NULL
-- rows.
CREATE INDEX idx_cost_ledger_bucket_occurred_at
  ON cost_ledger (bucket, occurred_at DESC)
  WHERE bucket IS NOT NULL;
