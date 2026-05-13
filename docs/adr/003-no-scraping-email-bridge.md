# ADR-003: No-scraping policy and email-bridge architecture

- **Status:** accepted
- **Date:** 2026-05-12
- **Resolves:** SPEC §19 Open Q1 (Twitter/X ingestion mechanism)

## Context

Several writers Simon wants to follow publish primarily on Twitter/X, which has no public RSS and an API with hostile pricing/access for low-volume use. The available workarounds are all scraping proxies — nitter, RSS-Bridge, RSSHub, and similar — that reverse-engineer Twitter's web interface, break on every UI rev, and ride on someone else's volunteer-run infrastructure.

A separate gap: a meaningful set of high-value outlets don't expose article-level RSS but do offer free email digests — Reuters, Bloomberg, FT, Economist, WSJ, MIT Tech Review, NBER, plus newsletter-only publishers (Anthropic news, Heatmap, Brad Setser, etc.).

## Decision

**No-scraping policy** (SPEC §2 final bullet):

> The system does not scrape. Sources must expose an RSS/Atom feed or an official API. Twitter/X via nitter, RSS-Bridge, RSSHub, or any other unofficial scraping path is explicitly excluded. Voices that publish only on Twitter/X without a parallel Substack / blog / podcast are dropped from v1.

**Email-bridge architecture** (SPEC §6.9) — single inbox + List-Id + two Workers + shared D1.

### Mechanism

1. One Email Routing rule on the zone `socialisn.com` forwards `inbox@socialisn.com` to the **email-worker** Cloudflare Worker.
2. email-worker parses each inbound message with `postal-mime` and looks up a source slug in the D1 `sender_map` table using a three-step priority — `List-Id` header → full `From:` address → `From:` domain.
3. On match → INSERT into `inbox(slug, message_id, received_at, subject, body_text, body_html)` + zero-or-more rows in the `inbox_links` join table.
4. On no match → INSERT into `unmatched(received_at, list_id, from_addr, subject)`; the operator inspects periodically and registers the source with one `sender_map` insert + one `sources` insert (or via the Phase 4 MCP tool `add_email_bridge_source`).
5. **feed-worker**, a separate Cloudflare Worker on the route `inbox.socialisn.com/feeds/*`, serves per-source Atom feeds read-only over the same D1 database. Socialisn2's ingestion-worker polls those URLs like any other RSS source (`sources.kind = 'email_bridge'`).

### D1 schema

| Table | Role |
|---|---|
| `inbox` | matched emails, `PRIMARY KEY (slug, message_id)` |
| `inbox_links` | extracted links, FK→inbox with `ON DELETE CASCADE` |
| `sender_map` | `(match_field, match_value)` → slug, primary key on the pair |
| `unmatched` | triage queue for emails with no sender_map hit |

## Rationale

### Why no scraping at all

- **Volunteer instances break.** Nitter / RSS-Bridge instances are maintained by individuals with no SLA; every TOS change at the upstream platform takes down a wave of them.
- **Self-hosted scrapers shift the maintenance burden onto us.** Reverse-engineering changes is a project, not a side task.
- **Twitter/X excluded** doesn't materially hurt source coverage. Of 49 writers initially considered for §6.6, 13 were Twitter/X-only and were dropped; the remaining 36 publish via Substack / blog / podcast with verified RSS.

### Why Cloudflare Email Worker over Kill The Newsletter

- **VPS-independent.** Newsletters keep arriving during VPS reboots and Odoo redeploys; the bridge sits at the CF edge.
- **Anti-spam built in.** CF Email Routing handles SPF/DKIM/DMARC and basic spam filtering; KTN-on-VPS would require Postfix + greylisting + RBL config.
- **Free tier.** Projected volume ~10–30 emails/day; CF free tier covers that by 1000×.
- **Existing CF use.** Simon's stack already runs DNS through Cloudflare; no new vendor.

### Why single inbox + List-Id, not catch-all + To: local-part

The PR #6 design used per-source addresses (`anthropic@socialisn.com` → slug `anthropic`) via a catch-all rule. Operationally simpler at first glance, but problematic:

- Spam directed at `random@socialisn.com` lands in the catch-all and consumes Worker invocations.
- The slug is committed at subscription time; if a publisher routes through a forwarding service or changes sender domains, the To: address still works but no longer reflects the publisher.
- It conflates two concerns: the subscribe address (operational artifact) and the source slug (data identity).

The single-inbox + List-Id mechanism decouples those: there is one subscribe address, and source identity is established post-receipt via the message itself. `List-Id` (RFC 2919) is set by every legitimate mailing-list operator and uniquely identifies the list — Substack publishers, for example, share `substack.com` as a sender domain but each publication has its own `<noahpinion.substack.com>` style List-Id.

### Why two Workers, not one

- **Independent scaling and monitoring.** Inbound mail bursts are bursty; feed reads are steady. Decoupling lets each Worker scale and alarm on its own profile.
- **Read vs. write blast radius.** A bug in the feed-handler can't accidentally corrupt the inbox; a bug in the email-handler can't take down feed serving.
- **Independent deploys.** Iterating on `postal-mime` parsing doesn't require redeploying the feed reader and vice versa.

### Fallback chain order

`List-Id` first because it's the strongest publisher identifier. `from_addr` second for outlets that don't set List-Id (a few corporate newsletters skip it). `from_domain` last as the broadest catch — useful when a publisher uses rotating From: local-parts within a domain.

## Consequences

- Adding a Twitter/X-only voice in the future requires that voice opening a non-Twitter path (Substack, personal newsletter, podcast). Hard guardrail.
- The bridge becomes a critical dependency for the §6.1 / §6.2 / §6.4 outlets bridged through it (30 sources after migration 006 — Shift Key returned to §6.6). A CF outage means processing pauses; delivery continues queueing at the CF edge.
- D1 storage is per-row TEXT; no JSONB. The dedicated `inbox_links` join table replaces what would have been a JSON-encoded `links` column — enables queries like "all bridges where Reuters linked to bloomberg.com" via `SELECT DISTINCT slug FROM inbox_links WHERE link_url LIKE '%bloomberg.com%'`.
- The first email per new source goes to `unmatched`; the operator must register the mapping. Phase 1 PR 4 adds a re-processing step that migrates earlier unmatched rows for a given List-Id into `inbox` when the mapping is created.
- Two Workers means two `wrangler.toml` files referencing the same `database_id`. Paste once after `wrangler d1 create`.

## References

- SPEC §2 (out-of-scope — final bullet)
- SPEC §6.9 (Cloudflare Email Worker bridge)
- SPEC §19 Open Q1 (Twitter/X ingestion mechanism)
- ADR-001 (Architecture overview)
- BUILD-PHASES.md Phase 0 PR 4 / Phase 1 PR 4 (worker scaffold + implementation)
