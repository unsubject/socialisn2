# Phase 4 — Output Layer: Phase Report

**Status:** complete — three feature PRs + one post-review bugfix.
**Date:** 2026-05-17.
**Scope:** SPEC §11 (the three delivery surfaces — RSS, Telegram,
MCP) + the Fastify HTTP entry that hosts two of them.

## What shipped

| PR | SHA | What |
|---|---|---|
| #56 | `b44182b` | Phase 4 PR 1 — RSS feed generation + `/c/:id` detail route. 6 static XML files (`all.xml` + 5 per-domain) via `src/rss/generate.ts` with the custom `<socialisn2:*>` namespace (temperature/trajectory/exclusive/archive_overlap). Atomic write via tmp+rename. First Fastify entry in the repo: `src/app.ts` exposes `GET /healthz` + `GET /c/:id`; `src/index.ts` boots the lifecycle. Orchestrator gained a tail `regenerateFeeds` dep slot — RSS regen errors join `runs.error` via `combineErrors` without rolling back persisted candidates. |
| #57 | `e95fdeb` | Phase 4 PR 2 — Telegram bot via grammy. 8 commands (`/today`, `/domain`, `/cand`, `/pick`, `/pass`, `/defer`, `/status`, `/help`) plus inline Pick/Pass/Defer keyboard callbacks. Outbound digest + instant-exclusive push via a grammy-free `src/telegram/push.ts` so the orchestrator's cron path doesn't load the bot framework. ADR-010 codifies the four design choices (long-polling vs webhook, bot-in-app vs separate worker, instant-vs-tail exclusive push, ordered shutdown invariant). `src/telegram/decisions.ts` exposes `decide()` — race-safe via `UPDATE..WHERE status='new' RETURNING *` — reused by both the bot and Phase 4 PR 3's MCP. |
| #58 | `0362641` | Phase 4 PR 3 — MCP server (`@modelcontextprotocol/sdk@1.29.0` pinned, no caret). 11 SPEC §11.4 tools wired: list/get/search candidates, pick/pass/defer (reusing `decide()` with `interfaceLabel='mcp'`), expand_competitor_list, add_influencer, compare_against_archive, run_now (fire-and-forget with caller-supplied runId), system_status. Bearer auth via Fastify preHandler scoped to `/mcp` prefix; `StreamableHTTPServerTransport` in stateless mode, **fresh Server AND transport per request** to avoid the shared-writer concurrency race. Orchestrator gained `RunOptions.runId?: string` so the tool can pre-insert the row and return its id synchronously while `runScoring` runs in the background. `src/index.ts` got an orphaned-runs cleanup at boot. |
| #59 | `b508184` | Post-review bugfix bundle. Three real bugs surfaced by external review on already-merged code: (1) `(${items.length})` in `formatTodayList` emitted bare MarkdownV2 parens — Telegram 400s every non-empty `/today` / `/domain` reply (silently broken since #57 merged). (2) `processRawItem` had no idempotency pre-check, so a crash post-success-pre-mark or a multi-worker UNIQUE race inflated cluster `item_count` per retry. (3) Migration 011 left every existing `raw_items` row with `processed_at=NULL`, which would have made the scoring worker re-process the entire dev DB on first boot. Migration 012 backfills, and the in-app idempotency check kills the inflation loop at the source. |

## Key decisions made and why

1. **Single-process app container hosts everything that's not a worker.**
   Fastify + telegram bot lifecycle + MCP route all live in the
   `app` Docker container. Phase 5 deploy script doesn't grow; one
   process to monitor; one shared DB pool. The bot, MCP, and HTTP
   surfaces are all built as independent units (`buildBot(db)`,
   `buildMcpServer(db)`, `buildApp(db)`) so a future split into
   multi-container is a wiring change, not a refactor. Codified in
   ADR-010.

2. **Long-polling over webhooks for Telegram (ADR-010).** No public
   ingress required, survives nginx config drift, no `setWebhook`
   call at deploy time. Webhook latency would be ~100ms tighter for
   instant pushes but at single-user scale and the bot client's own
   notification batching, imperceptible.

3. **`decide()` is the single source of truth for pick/pass/defer
   across both interfaces.** Both Telegram and MCP call the same
   function with `interfaceLabel='telegram'` or `'mcp'` so feedback
   rows segregate by surface. The race-safety contract
   (`UPDATE..WHERE status='new' RETURNING *`) is owned in one place;
   adding the MCP surface in #58 required zero changes to `decide()`
   because `feedback.interface` CHECK already allowed `'mcp'`.

4. **Outbound push is grammy-free.** `src/telegram/push.ts` uses
   plain `fetch` to api.telegram.org. The orchestrator imports it for
   the tail digest + per-insert exclusive push and never loads grammy
   on the cron path. Bot-side outages (polling 502s) cannot slow down
   scoring runs.

5. **MCP fresh Server+Transport per request (post-CI fix).** The
   first cut shared one Server + one Transport across requests;
   `Server.connect(transport)` mutates `Server._transport`, so two
   parallel `connect()` calls race and one client's writer reference
   is clobbered (loser returns 500). The SDK's own
   `simpleStreamableHttp` example builds both per request.
   `buildMcpServer(db)` is cheap (handler wiring only, no DB/network)
   so per-request rebuild is fine; if profiling ever shows it's hot,
   memoize the handler functions outside.

6. **MCP SDK pinned to `1.29.0` (no caret).** The
   `@modelcontextprotocol/sdk` package had a SSE→StreamableHTTP
   migration in late 2024 that broke APIs across what should have
   been backward-compatible minors. Pinning trades convenience for
   reproducibility; bumps require an explicit reviewed change.

7. **`run_now` returns the runId synchronously.** Orchestrator's
   `RunOptions.runId?: string` lets the tool pre-insert the runs row
   and return the id immediately while `runScoring` executes in the
   background. The "MCP caller asks for a run, gets a poll-able id
   in milliseconds" contract holds; the "scoring run is long and
   shouldn't block the API" contract holds too. The orphaned-runs
   cleanup in `src/index.ts` reconciles `status='running'` rows on
   every app boot so a SIGKILL mid-run doesn't leave a stale id.

8. **`decide()` test pattern: dep-injected `recordPick`.** Tests
   pass `{recordPick: async () => ({ok:true})}` so the 2nd-brain MCP
   isn't required. The default uses the real client which is already
   graceful (`{ok:false}` on any failure). Identical pattern carried
   into the MCP `decisions.ts` test set.

## Tried and abandoned

- **Hand-rolled JSON-RPC for the MCP server.** Considered the
  same raw-fetch approach `src/lib/two_brain_client.ts` (the CLIENT)
  uses, since the MCP protocol shape is simple. Rejected: the SERVER
  side has tool registry + schema advertisement + protocol-level
  error codes worth getting right via the SDK. SPEC §4.2 mandates
  `@modelcontextprotocol/sdk` and the SDK's StreamableHTTP transport
  is the right shape for a Fastify-mounted route.

- **Shared MCP transport across requests** (mentioned in decision 5
  above). Caught by the concurrency test I deliberately added in
  PR #58 to lock the fix in. Took two CI iterations to land the
  per-request pattern correctly.

- **Webhook mode for Telegram.** Considered for the latency win on
  instant exclusive pushes. Rejected — three new moving parts
  (`setWebhook` call, nginx path, webhook-secret env) at v1
  single-user scale. ADR-010 documents the re-evaluation trigger
  (multi-user, multi-replica deploy).

- **MCP `pick` reporting granular `archive_recorded` boolean from
  the 2nd-brain side.** SPEC §11.4 says `pick -> {ok, archive_recorded}`,
  but `decide()` doesn't thread `recordPick`'s response back —
  recordPick degrades to `{ok:false}` on failure and that's swallowed.
  v1 reports `archive_recorded = ok && !alreadyDecided` (true on a
  successful new decision, regardless of whether the MCP call landed).
  Build-list item to plumb the granular signal through; not blocking
  for v1.

## Test coverage notes

- **528 tests pass on main as of #59 close.** Each Phase 4 PR added
  its own test surface: RSS generator (9 cases incl. multi-label
  contract, expires_at filter, custom-namespace round-trip), Fastify
  app (11 cases incl. XSS escape + 4 distinct 404 paths), Telegram
  bot (9 cases via `bot.handleUpdate()` + API spy), MCP server (auth
  unit + 12 candidates + 8 sources + 3 runs + 6 integration).
- **Two coverage holes documented and tracked**:
  1. Positive `notifyExclusive` test in the orchestrator suite. The
     current "is_exclusive=false multi-source" fixture happens to be
     interpreted as exclusive by `computeExclusive` (caught and
     flipped to a positive assertion in #57); a true negative case
     would need a single-source-with-only-late-items fixture that
     doesn't exist yet.
  2. No test against real Telegram. The bot test's API stub returns
     `{ok:true}` regardless of MarkdownV2 validity, which is exactly
     what let the `(2)` paren bug ship in #57.

## Open questions for Phase 5

- **`/search`, `/add_competitor`, `/add_influencer` Telegram
  commands** — deferred from #57. The semantic-search embedding
  plumbing now exists in MCP `searchCandidates`; the Telegram
  command can thin-wrap it (~30 lines). Same for the two add_*
  commands once the MCP equivalents are exercised by real use.

- **`gdelt_coverage` row population is still empty in production.**
  Orchestrator's `geographic_spread_bonus` is therefore 0 for every
  cluster. Phase 5 PR 1 backfill territory.

- **`expires_at` formula revisit.** Phase 4 PR 1 surfaces expiry to
  RSS consumers (drops candidates whose `expires_at < NOW()`). The
  half-life-as-expiry choice from Phase 3 is now user-visible; if
  Simon's first pilot week shows candidates dropping off too fast,
  switch to `2×half-life` (decay-to-25% as expiry).

- **Skip-if-busy guard on the scoring-worker tick cron.** Carried
  from #55. Current chain pattern can backlog under sustained
  slowness. Cost ceiling would short-circuit before memory becomes
  an issue, so deferring.

- **Granular `archive_recorded` in MCP `pick`** (see decisions
  above) — thread `recordPick`'s ok/false back through `decide()`.

## What unblocks Phase 5

The full output layer is now operational. Phase 5 (backfill, deploy,
observability) can proceed against:

- Three delivery surfaces with real test coverage.
- A single-process app container that exposes everything via
  `node dist/index.js`.
- An MCP endpoint reachable at `https://socialisn2.<host>/mcp` per
  SPEC §11.4, ready to host a remote-MCP client connection from
  Claude Desktop.
- A Telegram bot that long-polls without needing public ingress.
- A Fastify HTTP server serving `/c/:id` candidate detail pages and
  ready to mount future health/status routes.

## ADRs landed in Phase 4

- **ADR-010** (PR #57): Telegram bot — transport, process boundary,
  push timing.

(No new ADRs in PRs #56 or #58 — PR #56's design choices were small
enough to live in the PR body; PR #58's choices were partially
codified in ADR-010 already and partially in the SPEC §4.2 SDK
mandate.)

## Branch state at phase close

- `main` at this PR's merge sha (post #59 + #60 sequence).
- Feature branches `phase4-pr1-rss-feeds`, `phase4-pr2-telegram-bot`,
  `phase4-pr3-mcp-server`, `post-pr58-review-bugfixes`,
  `phase4-pr4-phase-report` deletable post-merge.
- Next: Phase 5 PR 1 (backfill) per BUILD-PHASES.
