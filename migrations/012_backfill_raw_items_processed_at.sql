-- 012_backfill_raw_items_processed_at.sql
--
-- Backfill raw_items.processed_at for rows that already have a
-- corresponding items row.
--
-- Migration 011 added processed_at to raw_items but left every
-- existing row's value at NULL. The continuous scoring worker
-- (src/workers/scoring.ts) polls `WHERE processed_at IS NULL AND
-- processing_attempts < N`, so on any database that already had
-- items rows from a prior worker run, the worker would re-pick every
-- one and re-run normalise/embed against them — real LLM spend on
-- already-done work, plus likely dedup-hit or UNIQUE-violation churn.
--
-- The src/scoring/process-raw-item.ts idempotency pre-check that
-- ships in this PR catches the case at the application layer too —
-- a re-picked raw_item with an existing items row short-circuits to
-- "normal" without firing any deps. But the DB-level backfill is
-- still worth doing so the polling query doesn't keep re-pulling
-- the same already-done rows tick after tick.
--
-- One-shot UPDATE. Idempotent: if processed_at is already set (e.g.
-- the worker happened to land there before this migration in some
-- weird order), the WHERE clause skips. On a freshly-deployed DB
-- with no items rows yet, the UPDATE matches zero rows and is a
-- no-op.

UPDATE raw_items r
SET processed_at = i.processed_at
FROM items i
WHERE i.raw_item_id = r.id
  AND r.processed_at IS NULL;
