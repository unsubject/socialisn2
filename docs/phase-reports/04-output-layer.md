# Phase 4 — Output Layer: Phase Report

**Status:** complete — three feature PRs + one post-review bugfix.
**Date:** 2026-05-17.
**Scope:** SPEC §11 (delivery surfaces — RSS, Telegram, MCP) + the
Fastify HTTP entry that hosts two of them.

## What shipped

| PR | SHA | Commits | What |
|---|---|---|---|
| #56 | `b44182b` | 17 | Phase 4 PR 1 — RSS feed generation + `/c/:id` detail route. 6 static XML files (`all.xml` + 5 per-domain) via `src/rss/generate.ts` with the custom `<socialisn2:*>` namespace. Atomic write via tmp+rename. First Fastify entry in the repo: `src/app.ts` exposes `GET /healthz` + `GET /c/:id`; `src/index.ts` boots the lifecycle. Orchestrator gained a tail `regenerateFeeds` dep slot — RSS regen errors join `runs.error` via `combineErrors` without rolling back persisted candidates. |
| #57 | `e95fdeb` | 34 | Phase 4 PR 2 — Telegram bot via grammy. **Ships 8 of the 11 SPEC §11.3 commands**: `/today`, `/domain`, `/cand`, `/pick`, `/pass`, `/defer`, `/status`, `/help` plus inline Pick/Pass/Defer keyboard callbacks. The three SPEC commands explicitly NOT shipped — `/search`, `/add_competitor`, `/add_influencer` — are deferred (see "Open questions"). Outbound digest + instant-exclusive push via a grammy-free `src/telegram/push.ts` so the orchestrator's cron path doesn't load the bot framework. ADR-010 codifies the four design choices. `src/telegram/decisions.ts:decide()` is race-safe via `UPDATE..WHERE status='new' RETURNING *` and reused by Phase 4 PR 3's MCP. |
| #58 | `0362641` | 31 | Phase 4 PR 3 — MCP server (`@modelcontextprotocol/sdk@1.29.0` pinned, no caret). All 11 SPEC §11.4 tools wired. Bearer auth via Fastify preHandler scoped to `/mcp` prefix; `StreamableHTTPServerTransport` in stateless mode, fresh Server + transport per request to avoid a concurrency race (see "Bugs caught and fixed mid-PR" below). Orchestrator gained `RunOptions.runId?: string` so `runNow` can pre-insert the row internally and return its id synchronously while `runScoring` runs in the background. `src/index.ts` got an orphaned-runs cleanup at boot. |
| #59 | `b508184` | 6 | Post-review bugfix bundle. Three real bugs caught by external review on already-merged code: (1) `formatTodayList` emitted bare MarkdownV2 parens — Telegram 400s every non-empty `/today` / `/domain` reply (silently broken since #57 merged, see "Test coverage notes"). (2) `processRawItem` had no idempotency pre-check, so a crash post-success-pre-mark or a multi-worker UNIQUE race inflated cluster `item_count` per retry. (3) Migration 011 left every existing `raw_items` row with `processed_at=NULL`, which would have made the scoring worker re-process the entire dev DB on first boot. Migration 012 backfills; the in-app idempotency check kills the inflation loop at the source. |

**Iteration density.** 88 commits across 4 PRs. PRs #57 and #58 took
the most CI iterations (5 and 6 to land green respectively), driven
by: lockfile-regeneration churn for two new top-level deps (`grammy`,
`@modelcontextprotocol/sdk`); SDK-API-discovery (MarkdownV2 escape
discipline, grammy's `bot.api.config.use` transformer shape, MCP
SDK's per-request transport requirement); and the concurrency test
in #58 that caught my own partial fix. Phase 5 should budget for
similar density on any PR that adds a new HTTP/protocol surface.

## Architectural decisions

Five genuinely independent decisions. Two adjacent ones (`decide()`
dep-shape and dep-injection of `recordPick`) are folded under #3
because they're the same idea viewed twice.

1. **Single-process app container hosts everything that's not a
   worker.** Fastify + Telegram bot lifecycle + MCP route all live in
   the `app` Docker container. Shared DB pool, one process to
   monitor, splittable later via the existing per-surface builders
   (`buildBot(db)`, `buildMcpServer(db)`, `buildApp(db)`). Codified
   in ADR-010.
   *What would change my mind:* container memory pressure from
   grammy + Fastify + MCP transports above a measured threshold, OR
   multi-replica scaling needs (in which case telegram-worker and/or
   mcp-worker split out, sharing the DB pool via separate `app.ts`
   entries).

2. **Long-polling over webhook for Telegram (ADR-010).** No public
   ingress required, survives nginx config drift, no `setWebhook`
   call at deploy time.
   *What would change my mind:* multi-user expansion of the bot
   (would need per-user webhook secrets anyway), OR latency
   complaints on instant exclusive pushes.

3. **`decide()` as single source of truth for pick/pass/defer.**
   Both Telegram and MCP call the same function with
   `interfaceLabel='telegram'|'mcp'`. Race-safety contract
   (`UPDATE..WHERE status='new' RETURNING *`) lives in one place;
   adding the MCP surface in #58 required zero changes to `decide()`
   because `feedback.interface` CHECK already allowed `'mcp'`. The
   `recordPick` dep is injectable so tests don't need a 2nd-brain
   MCP — default uses the real client which is already graceful.
   *What would change my mind:* if `recordPick` ever grows DB writes
   that need to land in the same transaction as the `feedback`
   INSERT, the dep-injection contract has to change.

4. **MCP fresh Server + Transport per request (caught mid-PR).** SDK
   stateless mode mutates `Server._transport` on each `connect()`;
   two parallel `connect()` calls race and one client's writer
   reference is clobbered. `buildMcpServer(db)` is cheap so
   per-request rebuild is fine.
   *What would change my mind:* profiling shows handler wiring is
   hot (it isn't — the actual work is the per-tool DB or LLM call).

5. **MCP SDK pinned to `1.29.0` (no caret).** The
   `@modelcontextprotocol/sdk` package had a SSE→StreamableHTTP API
   break in late 2024 across what should have been backward-
   compatible minors. Pinning trades convenience for reproducibility.
   *What would change my mind:* an SDK release that fixes a tool we
   need and the changelog shows the migration is bounded.

## Bugs caught and fixed mid-PR

Documented here as the honest record of what shipped through CI vs.
what was caught later. Reframe of the earlier draft's "Tried and
abandoned" — these weren't deliberate explorations.

- **Shared MCP transport across requests (#58).** First cut held one
  `StreamableHTTPServerTransport` for the lifetime of the plugin; the
  concurrency test I added in the same PR caught the resulting 500
  on the second of two parallel `tools/call` requests. Fix is the
  per-request transport in decision #4 above. The earlier partial
  fix (per-request transport, shared Server) was itself broken —
  `Server.connect()` mutates Server-side state too. Took two commits
  to land the right shape.

- **`run_now` orchestrator wiring silently no-op'd by a patch script
  (#58).** A pre-commit patch helper's anchor string didn't match the
  current `RunOptions` block on the branch; the patch script printed
  success but applied nothing, so `RunOptions.runId?: string` never
  landed in run.ts in the original push. Re-fix landed in commit
  `acaf3fe`. Caught by external review before merge.

- **Hand-rolled JSON-RPC as MCP alternative was NOT a real decision
  point** — SPEC §4.2 mandates the SDK. The earlier draft listed it;
  cutting now.

## Test coverage notes

The suite passes on `main` (latest CI on PR #59: `527 passed, 1
fixed → 528 passed`; the exact count after PR #60 will need a fresh
`npm test` run since this PR adds no test files).

Per-surface coverage:
- **RSS generator** — 9 cases incl. multi-label contract, expires_at
  filter, custom-namespace round-trip via rss-parser.
- **Fastify app** — 11 cases incl. XSS escape + 4 distinct 404
  paths.
- **Telegram bot** — 9 cases via `bot.handleUpdate()` + `bot.api.config.use`
  transformer spy.
- **MCP server** — auth (8) + candidates (12) + sources (8) + runs
  (3) + integration via `app.inject()` (6).

**Documented coverage gaps (Phase 5 should close at least the first):**

1. **No end-to-end smoke against the live Telegram API.** The
   `bot.api.config.use` transformer stub returns `{ok:true}` for any
   payload, which is exactly how the `formatTodayList` paren bug
   shipped silently in #57. The class of bug — MarkdownV2 / Bot API
   payload validation — cannot be caught by the current test infra.
   Phase 5 PR 3 (observability) should add a real-API smoke that
   exercises the daily-use commands against a throwaway bot, OR
   accept the class and write a payload-validation linter.
2. **No positive `notifyExclusive` test in the orchestrator suite.**
   The current 2-source fixture happens to qualify as exclusive
   (caught and flipped to a positive assertion in #57); a true
   negative case would need a single-source-with-only-late-items
   fixture that doesn't exist.
3. **No MCP-client integration test.** `app.inject()` exercises the
   Fastify → transport → tool path but never speaks the wire
   protocol from an actual MCP client (mcp-remote, Claude Desktop,
   or another `@modelcontextprotocol/sdk` client). Misconfiguration
   in transport headers or session handling would not be caught.

**Misleading source comment to fix on Phase 5 contact:**
`src/telegram/format.ts:formatTodayList` justifies the paren escape
as "MarkdownV2 reserves `(` and `)` outside link/code contexts" —
that's not actually accurate per the Bot API docs; the parens need
escape in body text in all contexts. Functional fix is correct;
explanation is wrong. Fix when next touched.

## Env-vars added by Phase 4

For Phase 5 deploy. All gate behavior; empty values disable the
corresponding surface so non-prod can opt out.

| Var | Required for | Notes |
|---|---|---|
| `PUBLIC_HOST` | RSS generation + `/c/:id` links | E.g. `socialisn2.<host>` per SPEC §17. Required when `RSS_PATH` set. |
| `RSS_PATH` | Static feed write target | E.g. `/var/www/socialisn2/feeds`. Empty disables the orchestrator's regenerate-feeds tail hook. |
| `TELEGRAM_BOT_TOKEN` | Bot lifecycle | Empty skips `bot.start()` in `src/index.ts`. Pair with `TELEGRAM_CHAT_ID`. |
| `TELEGRAM_CHAT_ID` | Bot whitelist | Whitelist gate. Note: group chat IDs are negative (`-100xxx`) — missing leading `-` silently drops every message. |
| `SOCIALISN2_MCP_TOKEN` | MCP route mount | Empty disables the `/mcp` route entirely (Fastify plugin not registered). |

## Open questions for Phase 5

- **Reverse proxy choice contradicts itself.** SPEC §11.4 says MCP
  endpoint behind Caddy/nginx. BUILD-PHASES Phase 5 PR 2 says "join
  existing Traefik network (`n8n-traefik-1`, resolver
  `mytlschallenge`) for the MCP HTTPS endpoint". One of those has to
  give. Traefik is already running on the target VPS; SPEC was
  written before. Resolve before Phase 5 PR 2 lands the deploy script.

- **Telegram surface is a subset of SPEC §11.3.** Three SPEC commands
  deferred: `/search` (needs query embedding plumbing — now exists in
  MCP `searchCandidates`, can be thin-wrapped in ~30 lines), and
  `/add_competitor` / `/add_influencer` (canonical impl is in MCP
  `expand_competitor_list` / `add_influencer`; Telegram wrapper is
  ~50 lines each). Track explicitly so a future maintainer doesn't
  assume §11.3 is fully shipped.

- **Claude Desktop / remote-MCP-client wiring is unverified.** The
  `/mcp` endpoint exists, takes a bearer, and routes correctly
  under app.inject(). No actual MCP client has connected to it. Known
  wrinkle: bearer-authed remote MCPs need `mcp-remote` stdio proxy
  with `--header` (per personal-memory note) — Claude Desktop's
  native HTTP transport doesn't support custom auth headers cleanly.
  Phase 5 PR 2 or 3 should verify the first real client connection.

- **`gdelt_coverage` row population is still empty.** Orchestrator's
  `geographic_spread_bonus` is therefore 0 for every cluster. Phase
  5 PR 1 backfill territory.

- **`expires_at` formula revisit.** Phase 4 PR 1 surfaces expiry to
  RSS consumers (drops candidates whose `expires_at < NOW()`). The
  half-life-as-expiry choice from Phase 3 is now user-visible; if
  Simon's first pilot week shows candidates dropping off too fast,
  switch to `2×half-life` (decay-to-25% as expiry).

- **Skip-if-busy guard on the scoring-worker tick cron.** Carried
  from #55. Current chain pattern can backlog under sustained
  slowness. Cost ceiling would short-circuit before memory becomes
  an issue, so deferring.

- **Granular `archive_recorded` in MCP `pick`.** Currently reports
  `ok && !alreadyDecided` regardless of whether the 2nd-brain
  `recordPick` MCP call landed. Plumbing the granular signal through
  `decide()` is the right long-term fix.

- **Live-API Telegram smoke** (see test coverage notes above).

## ADRs landed in Phase 4

- **ADR-010** (PR #57): Telegram bot — transport, process boundary,
  push timing. Four decisions in one ADR.

No new ADRs in PRs #56 or #58 — #56's choices were small enough to
live in the PR body; #58's were partially covered by ADR-010
already and partially in the SPEC §4.2 SDK mandate.
