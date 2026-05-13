# Phase 0 — Foundation: phase report

Phase 0 lands the empty system: an app that builds, lints, types, runs CI against a real Postgres + pgvector, ships a typed schema for every SPEC §5 table, seeds the source catalogue, and stands up the two Cloudflare Workers behind the SPEC §6.9 bridge.

## PRs shipped

| PR | Title | Squash SHA |
|---|---|---|
| #2 | Phase 0 PR 1 — repo scaffold + CI + ADR/handoff templates | `ea1ac88` |
| #4 | fix(db): track applied migrations + guard destructive schema test | `8f9ebb1` |
| #3 | Phase 0 PR 2 — Drizzle schema + 001_init.sql + smoke test | `1faa835` |
| #5 | fix(db): detect pre-tracker baseline before replaying migrations | `411149a` |
| #6 | Phase 0 PR 3 — seed migrations + SPEC §6.9 expansion + fetch intervals | `cb2ea30` |
| #7 | fix(seeds): email-bridge cadence is 30 min, not 60 | `2757e25` |
| #9 | seeds(006): Shift Key→§6.6, §6.6 cadence 90, §6.4 authority bumps | `ff46dfd` |
| (this) | Phase 0 PR 4 — email-worker + feed-worker scaffold + ADR-001/002/003 + phase report | — |

## What is now in main

- `package.json` (Node 20 + TS 5.6), `tsconfig{,.build}.json`, Dockerfile, docker-compose (postgres pgvector / redis / app / 3 worker stubs), `.env.example` per SPEC §17, ESLint 9 flat config.
- CI: lint + typecheck + vitest with real-PG service container; `cache: 'npm'` + `npm ci`.
- `src/db/schema.ts` typed for every SPEC §5 table plus `cost_ledger` (§12) and `backfill_run` (§13). hnsw indexes on `items.embedding`, `clusters.centroid`, `competitor_videos.embedding`.
- `migrations/001_init.sql` — schema (raw SQL, canonical). `CHECK` constraints enforce all enum values per §5.
- `migrations/002_seed_sources.sql` — 81 rows (post-006) from SPEC §6.1 / §6.2 / §6.3 / §6.5 / §6.6 entries with RSS URLs.
- `migrations/003_seed_competitors.sql` — placeholder (`SELECT 1`).
- `migrations/004_seed_email_bridges.sql` — 31 initial email_bridge rows (7 newsletter-only + 10 §6.1 + 8 §6.2 + 6 §6.4); 006 transforms Shift Key into an RSS source leaving 30.
- `migrations/005_fix_email_bridge_interval.sql` — cadence correction (30 min for editorial bridges).
- `migrations/006_targeted_updates.sql` — Shift Key §6.9→§6.6 (UPDATE in-place), §6.6 substack/blog cadence 60→90, §6.4 academic authority bumps.
- `scripts/migrate.ts` — state-tracked migration runner with pre-tracker baseline detection.
- `tests/db/schema.test.ts` + `tests/db/seeds.test.ts` + shared destructive-DB guard; `vitest.config.ts` runs files serially because both reset `public`.
- `email-worker/` — Cloudflare Worker for inbound newsletter mail. Parses headers, looks up the source slug via D1 `sender_map`, writes to `inbox` or `unmatched`. Scaffold stub; full `postal-mime` parse + link extraction in Phase 1 PR 4.
- `feed-worker/` — Cloudflare Worker that serves per-source Atom feeds at `inbox.socialisn.com/feeds/<slug>.xml`, read-only over the shared D1.
- `email-worker/migrations/0001_inbox.sql` — D1 schema: `inbox`, `inbox_links` (FK→inbox CASCADE), `sender_map` (`(match_field, match_value)` → `slug`), `unmatched` (operator triage queue).
- `docs/adr/{001-architecture-overview,002-stack-choices,003-no-scraping-email-bridge}.md`.
- `docs/handoffs/_TEMPLATE.md`, `_EXAMPLE.md`, `2026-05-11.md`.
- `BUILD-PHASES.md` (Phase 1 → Phase 5 sequence + ADR index + Open Question resolution map).

## ADRs

- **ADR-001** — Architecture overview (codifies SPEC §4). Funnel rationale + deployment topology.
- **ADR-002** — Stack choices (codifies SPEC §4.2). Per-layer choice + alternatives rejected.
- **ADR-003** — No-scraping policy + email-bridge architecture (codifies SPEC §2 + §6.9, resolves SPEC §19 Open Q1). Includes the single-inbox + List-Id + two-workers rationale.

ADR-004 through ADR-008 are scheduled at specific later PRs per BUILD-PHASES.

## Sources catalogue, by `sources.kind` (asserted in seeds smoke test)

| kind | count | notes |
|---|---|---|
| `rss` | 81 | §6.1 articles (3) + §6.1 podcasts (15) + §6.2 podcasts (5) + §6.3 articles (5) + §6.3 podcasts (1) + §6.5 articles (8) + §6.5 podcasts (7) + §6.6 commentators (36) + Shift Key (transformed by 006) |
| `arxiv` | 3 | `cs.AI` / `cs.CL` / `cs.LG`, daily |
| `email_bridge` | 30 | 6 §6.9 newsletter-only (Shift Key moved to §6.6 by 006) + 10 §6.1 + 8 §6.2 + 6 §6.4 academic |
| `competitors` | 0 | placeholder; populated by Simon via MCP on first run |

## Known to be flaky / deferred

- **§6.5 outlets without public RSS** — Axios, Crikey, The Australian, Maclean's, National Post, Taipei Times (paywalled), The Times, UnHerd articles, ConservativeHome, LabourList, Reason, Tortoise/Observer articles. Some have RSS that needs per-outlet verification. Deferred to a follow-up seed migration after the per-outlet check.
- **`competitor_videos.embedding` HNSW index** is created against a NULL-able column. pgvector PG16 accepts it; switch to a partial index `WHERE embedding IS NOT NULL` if a real workload reveals issues.
- **`email-worker` + `feed-worker` end-to-end smoke** cannot run until the manual prerequisites land (NS → CF, Email Routing rule for `inbox@socialisn.com`, MX verify, `wrangler d1 create`, `wrangler deploy` for both Workers). Worker code is syntactically valid + typechecks; runtime behaviour is unverified.
- **First-email-from-new-source UX** — first email lands in `unmatched` (no sender_map entry yet). Phase 1 PR 4 adds an automatic re-process step that migrates earlier `unmatched` rows for a given List-Id into `inbox` once the operator creates the mapping.
- **`drizzle-kit generate` is intentionally not part of the workflow.** Migrations are hand-authored SQL.
- **PR 1 had 8 unilateral SPEC decisions** (Saul Eslake Substack-only, Yascha Mounk 3-feeds, Karpathy 2-blogs, Ian Johnson kept, Stratechery main feed only, Shift Key newsletter assumed — since reversed in PR #9 once open RSS confirmed, Caixin browser-UA caveat, addressing pattern — since revised in this PR from catch-all to single-inbox).

## Manual prerequisites for Phase 1 PR 4 (Email Worker end-to-end smoke)

1. `socialisn.com` nameservers → Cloudflare.
2. Cloudflare dashboard → Email Routing → enable for the zone.
3. Single rule: `inbox@socialisn.com` → forward to `socialisn2-email-worker`.
4. `dig MX socialisn.com` resolves to the CF MX records.
5. `wrangler d1 create socialisn2-inbox` → paste returned `database_id` into BOTH `email-worker/wrangler.toml` AND `feed-worker/wrangler.toml`.
6. `npm run d1:apply:remote` from `email-worker/` to apply the schema.
7. `npm run deploy` from `email-worker/` and again from `feed-worker/`.

## Cost so far

Nothing deployed; nothing running. Total spend: $0.

## Next phase

**Phase 1 — Ingestion (raw_items only, no LLM)** per BUILD-PHASES.md.
