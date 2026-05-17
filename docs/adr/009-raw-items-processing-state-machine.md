# ADR-009: raw_items processing state machine + multi-worker guard

- **Status:** accepted
- **Date:** 2026-05-17
- **Resolves:** none (Phase 3.5 design choice)

## Context

Phase 2 modules (`normalize`, `embeddings`, `semantic-dedup`, `cluster`)
ship + are tested individually, but nothing drives them on each
`raw_items` insert. The Phase 3 orchestrator (`src/orchestrator/run.ts`)
assumes `items` + `clusters` are pre-populated. Phase 3.5 closes that
gap with a continuous worker (`src/workers/scoring.ts`) that polls
pending `raw_items` and runs them through the pipeline.

Three design questions arose, each with multiple defensible answers,
and the resolutions don't live anywhere durable unless captured here.

### Q1 — How to track "this raw_item has been processed"

Options:
- **Status columns on `raw_items`** — add `processed_at` plus whatever
  ancillary fields are needed.
- **Separate work-queue table** — `raw_items_processing` with `(raw_item_id,
  status, attempts, ...)`. Polled by the worker; insertion driven by an
  AFTER INSERT trigger on `raw_items`.
- **Items row as the marker** — rely on `items.raw_item_id`'s presence
  to mean "processed". Polling SELECT becomes a `LEFT JOIN ... WHERE
  items.id IS NULL`.

The third option breaks down under SPEC §7.2 step 2: dedup-hits
("merged into the same cluster without creating new items rows") DO NOT
insert an items row, so they'd look pending forever. We need a separate
marker that survives the dedup-hit case.

The first vs second is the real trade-off: column adds vs a new table
with its own FK + index. Worker behaviour is identical either way.

### Q2 — How to record which cluster a dedup-hit belongs to

A successful normal-path processing leaves the cluster id on the
`items` row (`items.cluster_id`). A dedup-hit produces no items row,
so the cluster id needs to live elsewhere on the `raw_items` side.

A column named `cluster_id` would technically work but introduces a
trap at review time: queries joining the raw side and the items side
would mention two different `cluster_id` columns meaning two different
things ("the dedup target" vs "the assigned cluster").

### Q3 — How to guarantee at most one `items` row per `raw_item`

The application code in `src/scoring/process-raw-item.ts` already
serializes correctly under a single worker. The question is what
happens if Phase 5 ever scales `scoring-worker` to multiple replicas.

Options:
- **`FOR UPDATE SKIP LOCKED` on the batch SELECT**, wrapped in a
  transaction held for the duration of processing. Two workers don't
  pick the same row in the first place.
- **`UNIQUE(items.raw_item_id)`**: schema-level guarantee, independent
  of how many workers race. A losing-side race becomes a UNIQUE
  violation → transaction rollback → `processing_attempts++` → retry
  next tick.
- **Claim-and-release column** (`claimed_at TIMESTAMPTZ`) — workers
  atomically `UPDATE … RETURNING` rows where `claimed_at IS NULL`,
  processing only what they claimed.

## Decision

1. **State machine via column additions on `raw_items`.** No side table.
   Added by migration 011:
   - `processed_at TIMESTAMPTZ` — completion marker, set regardless of
     dedup-hit vs normal-path.
   - `dedup_cluster_id UUID REFERENCES clusters(id)` — set ONLY on
     dedup-hit, carries the matched cluster.
   - `processing_attempts INT NOT NULL DEFAULT 0` — poison-row counter.
   - `idx_raw_items_pending` partial index `WHERE processed_at IS NULL`
     for cheap polling.

2. **Distinct column name `dedup_cluster_id`** (not `cluster_id`) on
   `raw_items` to avoid the two-meanings-of-`cluster_id` trap.

3. **`UNIQUE (items.raw_item_id)`** added in the same migration as the
   multi-worker safety net. NOT `FOR UPDATE SKIP LOCKED`.

## Rationale

**Why column additions, not a side queue table:**

- The state IS conceptually a property of the raw_item ("is this thing
  processed?"), not a separate object with its own lifecycle. A side
  table would mostly mirror raw_item ids + add operational ceremony
  (extra FK, extra index, AFTER INSERT trigger or app-level dual-write).
- Partial index `WHERE processed_at IS NULL` keeps the polling query
  O(in-flight tail), not O(table). Equivalent cost to scanning a
  status='pending' rows in a side table.
- Migration is reversible by dropping three columns; a side table
  reversal is a drop + adjust of any code that read it.

**Why `dedup_cluster_id`, not reusing `cluster_id`:**

- A reviewer reading `SELECT r.cluster_id, i.cluster_id FROM raw_items
  r JOIN items i ON ...` would see two same-named columns with
  different semantics in their respective rows. Distinct naming makes
  the difference visible at every callsite.
- The column is genuinely sparse — populated only on dedup-hits, which
  the production rate is unknown today. A name that reads "dedup"
  signals "expect mostly NULL".

**Why `UNIQUE`, not `FOR UPDATE SKIP LOCKED`:**

- **Lock scope.** `FOR UPDATE SKIP LOCKED` only enforces serialization
  while the lock is held — in our pipeline, that's the full duration
  of `processRawItem` (~1–5 seconds for normalise + embed + dedup +
  cluster). Holding a row lock that long is fine; the price is that
  the SELECT and the entire processing pipeline must live in the same
  transaction, which couples the LLM call latency to the DB connection
  lifetime in a way that complicates error handling.
- **UNIQUE is forever.** A schema-level guarantee can't be accidentally
  removed by someone refactoring the worker. A `FOR UPDATE` clause can.
- **Useful index regardless.** `items.raw_item_id` was previously
  unindexed (FK constraints don't auto-create indexes in PG). The
  UNIQUE index gives us per-raw_item lookups for free.
- **The race cost is acceptable.** The losing worker's items insert
  rolls back; its `recordCost` rows for normalise + embed have ALREADY
  committed outside that transaction (see `src/cost/ledger.ts`), so the
  losing raw_item is double-billed for normalise + embed (~$0.0006).
  On retry, semantic-dedup usually catches the winner's freshly-inserted
  row and resolves via the dedup-hit path. Three races in a row poisons
  the raw_item, which is the right pressure relief.
- **Claim-and-release is the more correct shape for true multi-worker
  scale** but adds a column and a worker convention we don't need at
  v1 single-process scale. Re-evaluate at Phase 5 if multi-replica
  becomes a deploy requirement.

## Consequences

- `src/scoring/process-raw-item.ts` is the only writer to
  `raw_items.processed_at`, `raw_items.dedup_cluster_id`,
  `raw_items.processing_attempts`, and `items` rows from the Phase 2
  pipeline. The orchestrator (`src/orchestrator/run.ts`) reads but
  doesn't write these.
- The poison-row threshold (`SCORING_WORKER_MAX_ATTEMPTS`, default 3)
  caps retries. A poisoned row is still visible via
  `WHERE processed_at IS NULL AND processing_attempts >= 3` for triage;
  the worker just stops re-pulling it.
- The cost ledger CAN be double-billed (~$0.0006) per UNIQUE-race loser.
  Latent under v1 single-process. If multi-replica deploy lands without
  also switching to a claim-and-release model, watch `cost_ledger` for
  back-to-back `normalise` + `embed` pairs with no corresponding `items`
  insert as a tell.
- Re-running a successfully-processed normal-path raw_item is not
  idempotent at the application level: the second insert hits the
  UNIQUE constraint and rolls back. Manual replay requires clearing
  `processed_at` AND deleting the corresponding `items` row first.
  Documented in `src/scoring/process-raw-item.ts`.
- A future "claim-and-release" upgrade would add a `claimed_at` column,
  not remove `processed_at`. The migration path is forward-compatible.

## References

- SPEC §7.2 step 2 (semantic dedup), §7.4 (clustering), §12 (cost
  ceiling)
- ADR-007 (centroid-update strategy) — the "decision lives in code,
  doc lives here" precedent this ADR mirrors
- `migrations/011_raw_items_processing.sql` — the schema change
- `src/scoring/process-raw-item.ts` — the orchestrator that uses these
  columns
- `src/workers/scoring-core.ts` — the polling query (`loadBatch`) that
  consumes the partial index
