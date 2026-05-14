# Phase 1 — Ingestion: phase report

Phase 1 closes the "raw signal in, no LLM yet" tier of the pipeline. Every source category SPEC §6 enumerates can now either land items in `raw_items` (RSS / arXiv / email-bridge poll) or has the receive-side infrastructure to do so (Cloudflare Email Worker bridge for §6.9). GDELT is on-demand and wired for Phase 3 to call.

## PRs shipped

| PR | Title | Squash SHA |
|---|---|---|
| #11 | Phase 1 PR 1 — ingestion framework + RSS adapter + dedup pass 1 | `d267a1f` |
| #12 | Phase 1 PR 2 — arxiv + youtube + email_bridge adapters + ADR-004 | `9d3438a` |
| #13 | Phase 1 PR 3 — GDELT GKG enrichment adapter + ADR-005 | (merged 2026-05-13) |
| #15 / #17 / #18 / #19 / #20 / #22 / #23 / #25 / #26 / #28 / #29 / #30 / #31 / #32 | Phase 1 PR 4 — Email Worker production logic + bridge ops triad + transport-handling | this PR closes |

PR 4 broke into a series rather than a single landing: the bridge infrastructure (Workers + D1 + deploy + email-routing rule), the operational triad (`bootstrap-d1` / `inspect-d1` / `register-sender-map` / `reset-d1`), the auto-classifier (LLM + web-search, replacing static patterns), the transport-provider handling (Mailchimp / SES context-header capture), and finally this — the production email-handler with body parsing + link extraction.

## What is now in main

### Ingestion (`src/ingestion/`)

- **`rss.ts`** — generic RSS / Atom adapter covering §6.1 articles, §6.1 podcasts, §6.2 podcasts, §6.3 articles + podcasts, §6.5 articles + podcasts, §6.6 commentators. Built on `rss-parser`. Strips `at_*` BBC tracking params via the canonical-URL pipeline.
- **`arxiv.ts`** — thin wrapper. arXiv serves RSS 1.0 / RDF, which `rss-parser` handles identically. Logical separation only.
- **`email_bridge.ts`** — thin wrapper. Polls `<EMAIL_BRIDGE_BASE>/feeds/<slug>.xml` served by `feed-worker`.
- **`youtube.ts`** — competitor channel adapter (SPEC §6.7). Native YouTube RSS at `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`, custom-fields for `yt:videoId` / `yt:channelId` / `media:group`. No `videos.list` API call in v1 per ADR-004.
- **`gdelt.ts`** — GKG enrichment per SPEC §6.8. Two-fetch model (`TimelineVolRaw` for accurate volume + first-seen, `ArtList` for distribution sample), 6h cache. `themes` deferred to BigQuery loader per ADR-005.

### Workers (`email-worker/` + `feed-worker/`)

- **`email-worker`** parses inbound mail via `postal-mime`, matches against `sender_map`, writes to `inbox` (matched) or `unmatched` (triage) plus `inbox_links`. Captures transport-context headers (`Sender / List-Post / List-Unsubscribe / Reply-To / List-Owner / List-Help / Feedback-ID / X-Mailer`) into `unmatched.raw_headers` for the classifier. Optional secondary forward to `PERSONAL_FORWARD_ADDR`.
- **`feed-worker`** serves per-source Atom feeds at `https://inbox.socialisn.com/feeds/<slug>.xml` with `<link>` + `<content>` per entry. Read-only over the shared D1.

### D1 schema (`email-worker/migrations/`)

| # | Migration | What it adds |
|---|---|---|
| `0001` | `inbox.sql` | `inbox`, `inbox_links`, `sender_map`, `unmatched` |
| `0002` | `discovered_publishers.sql` | LLM-classified publisher metadata table |
| `0003` | `unmatched_raw_headers.sql` | `unmatched.raw_headers TEXT` (JSON of context headers) |

Idempotent via `IF NOT EXISTS` + a `_d1_migrations` tracker; `scripts/apply-d1-migrations.sh` is the canonical apply path, invoked by both `bootstrap-d1` and `deploy-workers`.

### Postgres schema (`migrations/`)

| # | Migration | What it adds |
|---|---|---|
| `001-006` | Phase 0 schema + seeds | (unchanged from Phase 0) |
| `007` | `add_competitor_fetch_tracking.sql` | `competitors.last_fetched_at` + `last_status` (fixed the scheduler hot-loop bug from the 2026-05-14 review) |
| `008` | `disable_anthropic_email_bridge.sql` | `enabled = false` on the Anthropic bridge — public signup not yet located |

### CI / ops workflows

| Workflow | Trigger | Role |
|---|---|---|
| `ci` | push / PR | lint, typecheck, vitest, both worker typechecks, **and now email-worker tests** |
| `bootstrap-d1` | manual | one-shot D1 create + apply all migrations |
| `deploy-workers` | push (path-filtered) + manual | applies migrations, then deploys both Workers in parallel |
| `inspect-d1` | manual | read-only summary + arbitrary SELECT (rejects multi-statement) |
| `register-sender-map` | manual | force a slug for a specific (match_field, match_value) — operator override |
| `auto-classify-bridges` | cron `*/30` + manual | LLM + web-search classifier for new publishers; tier-1 seed match short-circuits known publishers |
| `reset-d1` | manual + `RESET` confirmation | wipe all data tables, preserve schema + tracker |

### ADRs

- **ADR-001** — Architecture overview
- **ADR-002** — Stack choices
- **ADR-003** — No-scraping policy + email-bridge architecture
- **ADR-004** — YouTube chapter-data strategy (skip in v1; chapter signal lives in description text)
- **ADR-005** — GDELT rate-limit fallback (v1 GKG-only, no auto BigQuery fallback; manual threshold defined; themes deferred)

## Sources catalogue counts

Counts at end of Phase 1 (same as Phase 0 close — Phase 1 added adapters but no new sources). Migration 008 disabled Anthropic.

| `sources.kind` | count | enabled |
|---|---|---|
| `rss` | 81 | 81 |
| `arxiv` | 3 | 3 |
| `email_bridge` | 30 | 29 (anthropic disabled) |
| `competitors` | 0 | — |

## Known to be flaky / deferred

- **Reuters World News podcast** — feed serves only 2 stale items from Jan 2023; Reuters retired the show. Build task open to audit + re-verify seed feeds before next phase.
- **Anthropic email bridge** — disabled pending public newsletter discovery. Re-verification flagged in a recent review (https://www.anthropic.com/events may have a "Get the developer newsletter" form); if confirmed, re-enable via migration `009`.
- **End-to-end raw_items smoke for bridge** — the email-worker writes `inbox` rows correctly, and `feed-worker` serves them via Atom, but the ingestion-worker that polls `inbox.socialisn.com/feeds/<slug>.xml` and writes `raw_items` only runs after the VPS deploy lands (Phase 5 PR 2). Until then the bridge is "receive-side only" — emails flow through D1 and the personal mirror, but they don't reach Postgres `raw_items`.
- **HTML body stripping** — Phase 1 PR 4's `stripBoilerplate` only operates on plain text. `body_html` is stored verbatim; downstream consumers should prefer `body_text` for clustering input.
- **PR-1 unilateral SPEC decisions** — 8 in PR #1, several already corrected (Shift Key §6.9 → §6.6 via 006). The Caixin browser-UA caveat is still pending real ingestion to confirm.

## Cost so far

- D1: free tier (well under 100k rows / day, 25M reads / day).
- Cloudflare Email Routing: free tier (5k/day limit; observed traffic well below).
- Workers: free tier (100k requests/day).
- Anthropic API (auto-classify-bridges): paid per-classification, ≤ $0.20 each, ≤ 5 calls/month expected. ≪ $1.50/day ceiling.
- OpenAI / LiteLLM: nothing yet (Phase 2 territory).

## Next phase

**Phase 2 — Normalisation + clustering** per BUILD-PHASES.md. First PR is the LLM + embedding plumbing:

- `src/lib/llm.ts` (LiteLLM client)
- `src/lib/embeddings.ts` (OpenAI `text-embedding-3-small`)
- `src/cost/ledger.ts` (per-call USD tracking against the SPEC §12 ceiling)
- ADR-006 — Whisper model size for Cantonese (resolves SPEC §19 Q4; requires a Cantonese audio sample to benchmark)
