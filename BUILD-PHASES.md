# BUILD-PHASES.md

Working sequence for building Socialisn2 against `SPEC.md`. Five phases, multi-PR each, ending in a phase-report PR. ADRs land where they are needed; Open Questions in SPEC §19 each resolve at a specific ADR PR below.

## Conventions

- Every PR branches from `main`. No stacking.
- vitest + real-Postgres integration tests via a CI service container. No DB mocks.
- Each phase ends with a phase-report PR summarising what shipped, what is known to be flaky, and what is deferred.
- ADRs live at `docs/adr/NNN-slug.md` and are written in the PR that introduces the decision.
- Handoff notes at `docs/handoffs/YYYY-MM-DD*.md` are written end-of-session when warranted.

## Phase 0 — Foundation

*Goal: empty system that builds, lints, types, runs migrations, and (separately) deploys an empty Cloudflare Email Worker.*

- **PR 1** — Repo scaffold
  - `package.json` (Node 20 / TS), `tsconfig`, `Dockerfile`, `docker-compose.yml` (postgres-B + redis-B + app-B + ingestion-worker + scoring-worker + whisper-worker placeholders)
  - `.env.example` matching SPEC §17 (no `NITTER_BASE`; includes `EMAIL_BRIDGE_BASE=https://inbox.socialisn.com`)
  - `README.md`
  - CI (GitHub Actions): lint, typecheck, vitest with real-PG service container
  - `docs/adr/_TEMPLATE.md`, `docs/handoffs/_TEMPLATE.md`, `docs/handoffs/_EXAMPLE.md`

- **PR 2** — Drizzle setup + initial schema
  - `src/db/schema.ts`, drizzle-kit config
  - `migrations/001_init.sql` covering all SPEC §5 tables: `sources` (with `kind = 'email_bridge'` enum value), `raw_items`, `items`, `clusters`, `candidates`, `feedback`, `competitors`, `competitor_videos`, `gdelt_coverage`, `runs`, `cost_ledger`, `backfill_run`

- **PR 3** — Source seeds
  - `migrations/002_seed_sources.sql` — SPEC §6.1 (news) + podcast subsection, §6.2 (mass-market tech) + podcasts, §6.3 (niche/expert) + podcasts, §6.4 (academic econ), §6.5 (country-specific) + podcasts, §6.6 (independent commentators)
  - `migrations/003_seed_competitors.sql` — placeholder; populated by Simon via MCP on first run
  - `migrations/004_seed_email_bridges.sql` — SPEC §6.9 seed rows pointing to `https://inbox.socialisn.com/feeds/<slug>.xml`

- **PR 4** — Cloudflare Email Worker scaffold + foundation ADRs
  - `inbox-worker/` directory: `wrangler.toml`, `package.json`, `tsconfig.json`, stub `email-handler.ts` + `feed-handler.ts`, D1 binding declared
  - `inbox-worker/migrations/0001_inbox.sql` — D1 schema `(slug, received_at, message_id, subject, body_text, body_html, links)`
  - **`ADR-001` — Architecture overview** (codifies SPEC §4)
  - **`ADR-002` — Stack choices** (codifies SPEC §4.2)
  - **`ADR-003` — No-scraping policy and email-bridge architecture** (codifies SPEC §2 + §6.9; resolves SPEC §19 Open Q1)
  - Manual prerequisite documented in PR description: socialisn.com nameservers on Cloudflare, Email Routing enabled with catch-all → `inbox-worker`, MX records verified
  - Phase report

## Phase 1 — Ingestion (raw_items only, no LLM)

*Goal: every source in §6 produces `raw_items` rows with dedup, on schedule. The email bridge actually receives emails and serves Atom feeds end-to-end.*

- **PR 1** — Ingestion framework + general RSS adapter
  - BullMQ + node-cron, ingestion-worker container
  - Dedup pass 1 (URL/title hash — SPEC §7.2 step 1)
  - `src/ingestion/rss.ts` — single adapter that handles RSS/Atom for §6.1 news, §6.2 mass-market, §6.4 academic, §6.5 country-specific, §6.6 commentators, and all podcast feeds (title + show notes only in v1)

- **PR 2** — Specialised ingestion adapters
  - `src/ingestion/arxiv.ts` — daily listings for `cs.AI`, `cs.CL`, `cs.LG` (plus bioRxiv/medRxiv per SPEC §6.3)
  - `src/ingestion/youtube.ts` — competitor channel RSS at `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`
  - `src/ingestion/email_bridge.ts` — polls Worker Atom feeds at `EMAIL_BRIDGE_BASE/feeds/<slug>.xml`
  - **`ADR-004` — YouTube chapter-data strategy** (resolves SPEC §19 Open Q2: skip chapters in v1 vs pay YouTube Data API quota)

- **PR 3** — GDELT enrichment adapter
  - `src/ingestion/gdelt.ts` — GKG API caller, on-demand per cluster, 6h cache
  - **`ADR-005` — GDELT rate-limit fallback** (resolves SPEC §19 Open Q3: threshold for switching to BigQuery export)

- **PR 4** — Email Worker production logic + end-to-end smoke + phase report
  - `inbox-worker/src/email-handler.ts` — `postal-mime` parse, boilerplate strip (List-Unsubscribe, tracking pixels, unsubscribe footer regex), D1 insert
  - `inbox-worker/src/feed-handler.ts` — Atom XML generator querying D1
  - Subscribe one bridge source (Anthropic news) end-to-end and verify it lands as `raw_items` through the ingestion worker
  - Phase report: source coverage table, items/day per source, email-bridge smoke result

## Phase 2 — Normalisation & clustering

*Goal: `raw_items` → `items` → `clusters` with embeddings, on the cheap stages only.*

- **PR 1** — LLM + embedding plumbing
  - `src/lib/llm.ts` — LiteLLM client
  - `src/lib/embeddings.ts` — OpenAI `text-embedding-3-small`
  - `src/cost/ledger.ts` — start tracking spend
  - **`ADR-006` — Whisper model size for Cantonese** (resolves SPEC §19 Open Q4 — benchmarked on a sample of Simon's competitor channels at build time)

- **PR 2** — Normalisation
  - `src/scoring/normalize.ts` — Gemini Flash-Lite, produces `summary_en`, `context_en`, `entities`, `domains`/`primary_domain`, `keywords` per SPEC §7.3
  - `config/prompts/normalize.txt`

- **PR 3** — Clustering
  - `src/scoring/cluster.ts` — centroid match + create/update per SPEC §7.4
  - Daily compaction job (SPEC §7.4)
  - **`ADR-007` — Centroid update strategy** (resolves SPEC §19 Open Q5 — running mean vs periodic recentroiding)

- **PR 4** — Semantic dedup + phase report
  - SPEC §7.2 step 2 (semantic dedup at cosine ≥ 0.93)
  - Phase report: clusters/day, items/day, embedding cost/day, normalise cost/day

## Phase 3 — Archive integration & scoring engine

*Goal: clusters → candidates with curation, temperature, trajectory, archive overlap, and hard cost ceiling.*

- **PR 1** — 2nd-brain MCP client + headline-language ADR
  - `src/lib/two_brain_client.ts` — calls `archive_search` and `record_pick`, graceful fallback per SPEC §10.2
  - **`ADR-008` — Headline language for candidates** (resolves SPEC §19 Open Q6 — source-language for v1)

- **PR 2** — Heuristic ranking + signal annotations
  - `src/scoring/archive.ts` — computes `archive_overlap` and links
  - `src/scoring/temperature.ts` — `volume_z` computation (SPEC §9.5)
  - `src/scoring/trajectory.ts` — 24h derivative (SPEC §9.5)
  - `src/scoring/exclusive.ts` — first-publisher detection (SPEC §6.1 note)
  - `src/scoring/heuristic.ts` — Stage 3 ranking (SPEC §9.1)

- **PR 3** — Curation + cost ceiling
  - `src/scoring/curate.ts` — Sonnet curation call (SPEC §9.4)
  - `config/positioning.md` — verbatim from SPEC §9.4
  - `config/tags.ts` — controlled tag vocabulary
  - `config/domains.ts` — per-domain config (SPEC §8)
  - `config/prompts/curate.txt`, `config/prompts/headline.txt`
  - `src/cost/ceiling.ts` — hard halt at `COST_CEILING_DAILY_USD` (SPEC §12)

- **PR 4** — End-to-end run orchestration + phase report
  - Cron-triggered `morning` (05:00 ET) and `afternoon` (14:00 ET) runs writing a `runs` row, fanning through Stages 0-7
  - Phase report: candidate distribution per domain, real cost breakdown for one production run

## Phase 4 — Outputs (RSS + Telegram + MCP server)

*Goal: all three interfaces from SPEC §11 wired to live candidates.*

- **PR 1** — RSS feed generation
  - `src/rss/generate.ts` — 6 feeds (master + 5 domain) with custom namespace tags per SPEC §11.2
  - `/c/{id}` detail HTML route
  - RSS validator integration test

- **PR 2** — Telegram bot
  - `src/telegram/bot.ts` (grammy)
  - Every SPEC §11.3 command + inline Pick/Pass/Defer buttons + digest push + instant push for exclusives

- **PR 3** — Socialisn2 MCP server
  - `src/mcp/server.ts` + every SPEC §11.4 tool
  - Bearer-token auth via `SOCIALISN2_MCP_TOKEN`

- **PR 4** — Phase report

## Phase 5 — Backfill, deploy, observability

*Goal: shipped to Hostinger VPS, through SPEC §18 acceptance gates.*

- **PR 1** — Backfill
  - `src/backfill/run.ts` per SPEC §13
  - `backfill_run` table populated, authority recalibration logic landed
  - Note: backfill uses §6.1–§6.6 RSS only — email-bridge sources have no historical backlog

- **PR 2** — Deployment
  - VPS deploy script — join existing Traefik network (`n8n-traefik-1`, resolver `mytlschallenge`) for the MCP HTTPS endpoint
  - Static-RSS path under nginx at `/var/www/socialisn2/feeds`
  - `inbox-worker` deployed independently via `wrangler deploy` (no docker-compose entry)

- **PR 3** — Observability
  - `/status` HTTP + Telegram `/status`
  - Cost alert at 80% ceiling
  - Structured logs

- **PR 4** — Phase report + 5-day pilot
  - Result against SPEC §18 acceptance criteria
  - Confirm Simon picks ≥ 1 candidate/day he would not have found via Perplexity / Google / YouTube browsing

## ADR index

| # | Title | Lands in |
|---|-------|----------|
| 001 | Architecture overview | Phase 0 PR 4 |
| 002 | Stack choices | Phase 0 PR 4 |
| 003 | No-scraping policy and email-bridge architecture | Phase 0 PR 4 |
| 004 | YouTube chapter-data strategy | Phase 1 PR 2 |
| 005 | GDELT rate-limit fallback | Phase 1 PR 3 |
| 006 | Whisper model size for Cantonese | Phase 2 PR 1 |
| 007 | Centroid update strategy | Phase 2 PR 3 |
| 008 | Headline language for candidates | Phase 3 PR 1 |

## SPEC §19 — Open Questions resolution map

| SPEC §19 question | Resolved by |
|---|---|
| Twitter/X ingestion mechanism | Policy (SPEC §2 + §6.9) + ADR-003 |
| YouTube chapter data | ADR-004 |
| GDELT rate limits | ADR-005 |
| Whisper model size | ADR-006 |
| Centroid update strategy | ADR-007 |
| Headline language | ADR-008 |
