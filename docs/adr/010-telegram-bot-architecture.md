# ADR-010: Telegram bot — transport, process boundary, push timing

- **Status:** accepted
- **Date:** 2026-05-17
- **Resolves:** none (Phase 4 PR 2 design choices)

## Context

Phase 4 PR 2 lands the bot side of SPEC §11.3 — 8 commands, inline
keyboards, digest push after each scoring run, and instant push for
`is_exclusive=true` candidates. Four non-obvious choices need to be
recorded somewhere durable so the rationale survives the PR body.

### Q1 — Transport: long polling vs webhook

The Bot API supports both. Webhook is push-driven (Telegram POSTs to
us); long polling is pull-driven (we GET /getUpdates).

### Q2 — Process boundary: bot lives where?

Three options:
- In the existing `app` container alongside Fastify
- As a separate `telegram-worker` docker-compose service
- Inside the `scoring-worker` container (no — fundamentally different
  lifecycle: scoring is cron-batch, bot is long-lived)

### Q3 — Exclusive push: instant on insert, or batched at tail?

SPEC §11.3 says *"When an `is_exclusive` candidate is created: instant
standalone push, regardless of run cadence."* Two interpretations:

- **Tail**: collect exclusives during the run, push at the same point
  as the digest. Simpler, batches outbound HTTP, but introduces a
  multi-minute delay between candidate creation and notification on a
  long run.
- **Insert**: push the instant `insertCandidate` returns inside the
  per-cluster loop. Honours "instant" but doubles the outbound API
  call rate during high-exclusive runs.

### Q4 — Shutdown ordering

The `app` process now runs three components: Fastify HTTP server,
grammy long-polling bot, postgres connection pool. SIGTERM has to
drain them in the right order; getting it wrong wedges the container
on shutdown or leaks in-flight requests.

## Decision

1. **Long polling**, via `grammy`'s `bot.start()`.
2. **Bot lives in the `app` container** alongside Fastify. Single
   process, gated on `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` being
   set.
3. **Instant push on `insertCandidate` return**, inside the per-cluster
   loop. The tail `notifyDigest` excludes exclusives from the "X new"
   counts conceptually — but in practice the digest still mentions
   exclusives in a "N flagged" tail clause for at-a-glance ops.
4. **Ordered shutdown:** `bot.stop()` → `app.close()` → DB close.
   Documented in `src/index.ts`'s `shutdown` closure inline.

## Rationale

**Long polling over webhook (Q1):**

- **No public ingress needed.** Webhook needs a public HTTPS URL, the
  Caddy/nginx path to that URL, a `setWebhook` call at deploy time,
  and a `X-Telegram-Bot-Api-Secret-Token` env var for source
  verification. Three new moving parts at v1 single-user single-VPS
  scale.
- **Survives reverse-proxy config drift.** A misconfigured nginx
  vhost during a deploy can silently swallow webhook traffic; long
  polling reconnects automatically.
- **Bandwidth is irrelevant.** Single user, ~10 commands/day worst
  case. The constant `/getUpdates` open connection is overhead-free
  at this volume.
- **Trade-off**: webhook latency can be ~100ms tighter for instant
  pushes (Telegram pushes vs us polling). At single-user scale and
  with the Telegram client's own notification batching, imperceptible.

**Bot in the `app` container (Q2):**

- **One process to deploy.** Phase 5 deploy script stays trivial
  (`docker compose up -d`); no second service to add to compose.
- **Shared DB handle.** Both Fastify and the bot read from the same
  drizzle/postgres pool. A separate worker would either need its own
  pool (extra connections) or coordinate via Redis.
- **The `app` container is small.** Fastify + bot is still ~80MB
  total resident. No memory pressure justifying a split.
- **Splittability preserved.** If multi-replica scale ever needs to
  split inbound bot traffic from outbound HTTP, the lifecycle is
  already extracted (`buildBot(db)` is independent of `buildApp(db)`).
  Phase 5 can revisit.

**Instant push on insert (Q3):**

- **SPEC wording wins.** "Instant standalone push, regardless of run
  cadence" is unambiguous; batching at tail is a different contract.
- **The per-cluster loop is the natural seam.** `insertCandidate`
  already returns the candidate id; firing `notifyExclusive` on the
  next line is one extra `await` per cluster.
- **Cost is bounded.** Exclusives are by definition rare (single
  source first-publisher). Empirical bound at the configured source
  set: ≤2 exclusives per run. One extra Bot API call per is_exclusive
  candidate ≈ +2 round trips/run; trivial.
- **Failure isolation:** if an instant push fails, the per-insert path
  log-and-continues (`safeNotifyExclusive` swallows). The tail digest
  push surfaces failures into `runs.error` because it's a single
  atomic ops signal; per-insert failures don't crowd that field.

**Ordered shutdown (Q4):**

The dependency chain on shutdown is the inverse of dependency at
runtime:

- Bot handlers depend on the DB. So bot stops FIRST — handlers in
  flight finish their DB queries against a still-open pool.
- Fastify handlers depend on the DB. So Fastify stops SECOND —
  in-flight HTTP responses also drain against the open pool.
- DB stops LAST.

Closing the DB before bot.stop() means: a callback handler currently
processing a `/pick` button tap calls `db.execute` mid-shutdown, the
pool is closed, the query throws "connection ended", the handler
errors out, grammy doesn't send `answerCallbackQuery`, Telegram's
client shows the spinning button forever and re-delivers the update
on the next polling cycle.

This is enforced in `src/index.ts`'s shutdown closure with an inline
comment. Future edits must preserve the order.

## Consequences

- `src/index.ts` is the only place that orchestrates the bot
  lifecycle. `buildBot(db)` is independent — `tests/telegram/bot.test.ts`
  uses `bot.handleUpdate()` directly without invoking the start /
  stop machinery.
- `src/telegram/push.ts` deliberately depends on `fetch`, NOT on
  grammy. The orchestrator's tail hook + the per-insert exclusive
  hook both import `push.ts` for outbound Bot API calls; a future
  cron path running scoring out-of-process never loads grammy.
- The `app` container's compose CMD stays `node dist/index.js`. No
  new service.
- If we ever migrate to webhook: replace `bot.start()` with the
  Fastify route plugin in `buildApp` + `setWebhook` call at startup,
  delete the long-polling lifecycle from `src/index.ts`. The command
  handlers don't change.
- If we ever split bot out of the `app` container: lift the
  `if (env.telegramBotToken() ...)` block from `src/index.ts` into a
  new `src/workers/telegram.ts` entry, add a `telegram-worker`
  compose service. The orchestrator's `notifyDigest` / `notifyExclusive`
  hooks stay where they are (they only touch `push.ts`, not grammy).

## References

- SPEC §11.3 (Telegram Bot — bidirectional)
- ADR-009 (raw_items processing state machine) — the "decision lives
  in code, doc lives here" precedent this ADR mirrors
- grammy docs: https://grammy.dev/guide/getting-started
- Telegram Bot API webhook vs long-polling:
  https://core.telegram.org/bots/api#getting-updates
