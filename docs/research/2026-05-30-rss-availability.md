# Outlet RSS-availability research

**Closes audit item (2)** from the 2026-05-16 Phase 0-2 deferred list
(Google Tasks `aEkwZ1ZuS2lGaFQyalRUeQ`). The audit flagged 10 outlets whose
public RSS availability was unverified at seed time; this is the audit pass.

**Methodology.** Each outlet probed with `curl -A 'Mozilla/5.0 (compatible;
FeedFetcher/1.0; +https://socialisn.com/rss)'` (a realistic RSS-reader User-
Agent) at 2026-05-30. A "feed" requires HTTP 200 + a content body that begins
with `<?xml` or `<rss` or `<rdf:RDF`. HTML responses dressed up as feeds
(common Cloudflare challenge pages or section listings under a `?service=rss`
query that just renders the section page) are treated as "no public RSS."

## Summary

7 of 10 confirmed available; 4 unavailable (1 of which is `BLOCKED`, where a
feed may exist but Cloudflare gates fetches).

| # | Outlet | Status | URL | Notes |
|---|---|---|---|---|
| 1 | **Globe & Mail** (politics, business) | ❌ NO PUBLIC RSS | — | `theglobeandmail.com/about/rss/` 404; `/politics/feed/`, `/business/feed/`, `/feeds/`, `/rss`, `feed.theglobeandmail.com` all 404 or return HTML. Homepage `<head>` declares no `application/rss+xml`. Site appears to have dropped RSS support. |
| 2 | **The Times UK** | ❌ NO PUBLIC RSS | — | `thetimes.com/?service=rss`, `/uk/feed`, `/help/rss`, legacy `thetimes.co.uk` all return HTML (200 OK but body is the section page, not RSS). |
| 3 | **ABC News** (politics) | ✅ AVAILABLE | `https://abcnews.com/abcnews/politicsheadlines` | RSS 2.0, ~25 items, fresh. Pattern generalises: `abcnews/<section>headlines` works for `us`, `international`, `technology`. Original `abcnews.go.com` URL 301s to the `abcnews.com` host. |
| 4 | **The Australian** | ⚠ BLOCKED | — | Cloudflare bot-detection gates all probed paths (`/feed`, `/business/feed`, `/help/rss`). May exist behind News Corp's auth wall; not practical to ingest via the standard adapter. |
| 5 | **Crikey** | ✅ AVAILABLE | `https://www.crikey.com.au/feed/` | RSS, 10 items, last build < 24h. Paywalled long-form, but the feed exposes headline + intro of every story — usable for clustering signal. |
| 6 | **The Bulwark** | ✅ AVAILABLE | `https://www.thebulwark.com/feed` | RSS, 10 items, very fresh (< 1h). Mix of articles + podcast episodes. |
| 7 | **The Dispatch** | ✅ AVAILABLE | `https://thedispatch.com/feed/` | RSS, 10 items, < 24h. Generally paywalled, feed exposes summaries. |
| 8 | **China Books Review** | ✅ AVAILABLE | `https://chinabooksreview.com/feed/` | RSS, 5 items, last build 2026-05-26. Low cadence (~weekly); deep editorial signal for the China-books-and-ideas beat. |
| 9 | **NEJM** | ✅ AVAILABLE | `https://www.nejm.org/action/showFeed?type=etoc&feed=rss&jc=nejm` | RDF (RSS 1.0), 103 KB body, ~table-of-contents shape. Alt: `?type=axatoc&jc=nejm` (49 KB) for current-issue articles. Open-access subset only; full-text requires subscription. |
| 10 | **IEA** | ⚠ BLOCKED | — | Cloudflare blocks all probed paths (`/news/rss`, `/rss/news`, `/news/index.rss`, `/reports.rss`). Even the news landing page itself 403s. No practical fetch path via the standard adapter. |
| 11 | **BloombergNEF** (bonus, was flagged "deferred — no RSS confirmed" in migration 010) | ✅ AVAILABLE | `https://about.bnef.com/feed/` | RSS, 10 items, last build 2026-05-27. Slow cadence (~weekly), useful editorial for energy/cleantech. The `/blog/feed/` and `/shorts/feed/` paths return HTML, not RSS — only the root `/feed/` works. |

## Recommendation — what to ingest

Suggest **7 new sources** for the next seed migration (`017_seed_audit_outlets.sql`
or similar). All confirmed RSS, all relevant to existing editorial domains.

| Source | Domain tag | URL | Authority seed | Cadence (min) |
|---|---|---|---|---|
| ABC News (politics) | `national` + `geopolitics` | `https://abcnews.com/abcnews/politicsheadlines` | 70 | 60 |
| Crikey | `national` (AU-focused) | `https://www.crikey.com.au/feed/` | 65 | 60 |
| The Bulwark | `national` (US political) | `https://www.thebulwark.com/feed` | 65 | 60 |
| The Dispatch | `national` (US political) | `https://thedispatch.com/feed/` | 70 | 60 |
| China Books Review | `geopolitics` (China-focus) | `https://chinabooksreview.com/feed/` | 75 | 1440 |
| NEJM (TOC) | `scitech` | `https://www.nejm.org/action/showFeed?type=etoc&feed=rss&jc=nejm` | 90 | 1440 |
| BloombergNEF | `economy` + `scitech` | `https://about.bnef.com/feed/` | 75 | 1440 |

Authority seeds are first-pass — the daily Bayesian recalibration (ADR-013)
will adjust each from real pick / pass / defer signal within ~20 decisions.

## Outlets we cannot ingest — what to do

- **Globe & Mail.** No public RSS. Most G&M editorial coverage is also wired
  through Reuters/AP, which we already ingest. Acceptable redundancy gap. No
  action.
- **The Times UK / The Australian.** Both News Corp properties with hostile
  bot detection. Alternatives:
  - Subscribe to their email newsletters and route via the existing
    email-bridge (`kind = 'email_bridge'`). The bridge already handles the
    boilerplate strip path (see `email-worker/src/parse.ts`).
  - Defer until the email bridge has spare capacity.
- **IEA.** Cloudflare gates all RSS paths. Same email-bridge workaround would
  work for the press-release newsletter; alternatively the public reports
  page could be polled via a future scraper exception — but that would
  violate ADR-003 / SPEC §2 no-scraping. Recommend email-bridge route.

## Method notes for the next audit pass

- A status 200 response is necessary but not sufficient — many sites return a
  200 HTML page from RSS-shaped URLs. Always inspect the first bytes for
  `<?xml`, `<rss`, or `<rdf:RDF`.
- Cloudflare's "Just a moment…" challenge page (status 403, ~5KB HTML with a
  meta-refresh + JS challenge) is distinct from a real 403 forbidden. Worth
  retrying through an authenticated HTTP fetch if a feed is suspected to
  exist behind the gate, but the standard ingestion adapter won't get
  through.
- For Substack-hosted newsletters, `/<author>.substack.com/feed` is the
  universal pattern and always available — those don't need a manual probe.
- For WordPress-based publishers (common in independent journalism), the
  `/feed/` and `/<section>/feed/` paths are the de-facto convention and worth
  always probing first.
