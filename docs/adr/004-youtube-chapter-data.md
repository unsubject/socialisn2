# ADR-004: YouTube chapter-data strategy

- **Status:** accepted
- **Date:** 2026-05-13
- **Resolves:** SPEC §19 Open Q2 (YouTube chapter data — fetch via Data API vs. skip)

## Context

YouTube's native per-channel RSS feed at `https://www.youtube.com/feeds/videos.xml?channel_id=<id>` is the no-scraping path established in SPEC §6.7 / ADR-003. It exposes per-video metadata sufficient for clustering and ranking:

- `<yt:videoId>` → stable identifier
- `<yt:channelId>` → channel identifier
- `<title>` / `<media:description>` → searchable text
- `<published>` → recency signal
- `<media:thumbnail>` + `<media:statistics views>` → optional ranking inputs

It does **not** expose chapter timestamps. Chapters live in the YouTube Data API `videos.list` endpoint (`part=snippet,contentDetails`), and the timestamps themselves are parsed out of the video description by YouTube's chapter detection — meaning the same data is in the RSS `<media:description>` already, just not pre-parsed.

The decision: do we additionally call `videos.list` to get pre-parsed chapters for Tier 2 (cheap-signal) competitors, or skip chapter extraction in v1?

## Decision

**Skip chapter extraction in v1.** The RSS feed's title + description is the chapter-free signal used through Phase 2 clustering and Phase 3 scoring. The YouTube Data API is not called from the ingestion-worker.

## Rationale

### Cost model

The hard cost ceiling is **USD 1.50/day** (SPEC §12). `videos.list` is 1 quota unit per call. The default daily quota is 10k units. At typical competitor list size (~25 channels × ~3 videos/day fetched = 75 videos/day), chapter fetches would cost 75 quota units/day — well within free tier. So the quota cost isn't the binding constraint.

The binding constraint is **engineering surface area**:

- A second API client (Data API key management, retries, quota-exhaustion handling)
- A second adapter pathway with a different auth model
- Parsing the `contentDetails.duration` ISO-8601 string for `duration_sec`
- Storage decisions for chapter arrays (new column, new index?)

For the v1 candidate pool, the marginal editorial value of chapters is low — clustering uses the full title + description, and Whisper transcripts (Phase 2 PR 1 per ADR-006) provide the high-fidelity signal where it matters.

### Where chapters would help, and why we still skip

Chapters help two specific downstream tasks:

1. **Cluster centroid quality** — knowing a video has chapters on Topic A, B, C means it can join multiple clusters. v1 treats one video as one signal; this is the right tradeoff at the candidate-discovery stage.
2. **Time-stamped quote retrieval** — useful for Simon's writing process. v2 territory.

Both are improvements that depend on a working v1 first. Defer.

### What we use instead

The `<media:description>` field (surfaced as `item.content` after rss-parser parsing) already includes the chapter timestamps as plain text — YouTube's chapter UI is just a render of that description. The Phase 2 normalisation prompt operates on title + description directly, so any chapter signal that's editorially relevant flows through automatically. We just don't parse it into structured chapter rows.

## Consequences

- `competitor_videos` schema (already in `001_init.sql`) does not get a `chapters` column in v1. If v2 adds chapter parsing, add then.
- `duration_sec` stays nullable; v1 leaves it `NULL` for RSS-discovered videos. Whisper-processed videos populate it (a Whisper transcript implies we have the audio file's runtime).
- The `youtube.ts` adapter does not import any YouTube Data API client; the `YOUTUBE_API_KEY` env var stays present in `.env.example` for future use but is not read in v1.
- v2.x can add a `videos.list` post-fetch pass against Tier 1 competitors only (small N, predictable cost) without needing schema changes — chapters would live in a new column added at that time.

## References

- SPEC §6.7 (Competitor Channels)
- SPEC §12 (Cost ceiling)
- SPEC §19 Open Q2 (YouTube chapter data)
- ADR-003 (No-scraping policy)
- ADR-006 to-come (Whisper model size for Cantonese, Phase 2 PR 1)
- BUILD-PHASES.md Phase 1 PR 2 (YouTube adapter lands here)
