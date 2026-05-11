# Socialisn2 — Personal Editorial Intelligence System

**Version:** 1.0
**Owner:** Simon Lee (利世民)
**Purpose document:** This specification is the source of truth for the Socialisn2 development project, to be implemented by Claude Code. It supersedes the existing `unsubject/socialisn` repository entirely; v1 is not migrated.

---

## 1. Executive Summary

Socialisn2 is a personal editorial intelligence system that produces, twice daily, a curated pool of episode candidates for Simon Lee's YouTube channel 利世民頻道. Candidates are surfaced from a continuously-monitored signal layer (news, social influencers, academic feeds, GDELT coverage, competitor channels), clustered, de-duplicated, scored against Simon's editorial positioning, and stored in a Postgres database. The system exposes the candidate pool through three interfaces: an MCP server for AI-chat interaction, a bidirectional Telegram bot for mobile access, and RSS feeds (per-domain and master, tagged with keywords).

The system replaces an earlier system (`unsubject/socialisn`) which failed for two reasons: it was expensive (every signal item ran through Claude) and its outputs were generic (no better than running Perplexity manually). Socialisn2 is designed around four differentiators that Perplexity-grade search cannot provide:

1. **Personalization** — uses Simon's prior essay corpus and YouTube episode history (stored in `unsubject/2nd-brain`) to score candidates against his voice and to dedup against work he has already done.
2. **Persistence** — watches sources continuously, including obscure ones he would never search manually.
3. **Curation** — has already filtered tens of thousands of raw signals down to a small ranked pool before he opens the tool.
4. **Surprise** — surfaces candidates flagged as overlooked-by-mainstream or first-mover-exclusive that would not appear in a general-purpose search.

### 1.1 Success Criteria

After two weeks of operation, Socialisn2 is successful if:

- Simon picks at least one candidate per day, on average, that he would not have found via Perplexity, Google, or YouTube browsing.
- Total inference cost stays under **USD $1.50/day**.
- Candidate pool freshness: morning candidates are available by 06:00 US Eastern; afternoon candidates by 15:00 US Eastern.
- False positive rate (candidates Simon marks "pass" because they are off-positioning) is below 50% by end of week 2.
- No candidate appearing in the pool duplicates a topic Simon has already covered in the past 90 days.

---

## 2. What Socialisn2 Is Not

To prevent scope drift, the following are explicitly out of scope for v1:

- It is not a research tool. It does not generate thesis briefs, debate angles, or scripts. Those remain the job of the `episode-prep` skill downstream.
- It is not an essay writer or summariser of full articles. The context shown per candidate is bounded (see §7.3).
- It is not a CRM, project tracker, or task manager. Picks are training signal and a handoff event, nothing more.
- It is not multi-user. Simon is the sole user. No auth beyond a single shared secret.
- It does not run on Railway. It runs on Simon's existing Hostinger VPS, alongside `unsubject/2nd-brain`.
- It does not use Chinese-hosted models (no Qwen, DeepSeek, GLM, etc).
- It does not use Perplexity API. Direct ingestion from primary sources only.
- It is not an email service in v1. Daily email digest is explicitly deferred to a later version.

---

## 3. Editorial Domains

Socialisn2 surfaces candidates in five domains. Domain assignment is multi-label (one candidate can belong to multiple domains, with a primary).

| Code | Name | Definition |
|------|------|------------|
| `economy` | Economy & Finance | Macro and market developments with impact on wealth and income. Fed/central banks, fiscal policy, market structure, capital flows, financial stability, commodities. |
| `economics` | Economics (the discipline) | New academic working papers and peer-reviewed research from economics, psychology, sociology, and adjacent social sciences. Focus on papers that change how society or markets are understood. Not market commentary. |
| `scitech` | Science & Technology | Breakthroughs and significant attempts in (a) information technology / computer science, (b) energy, (c) biological / pharmaceutical / medical science. Bias toward developments with 1-3 year market implications. |
| `geopolitics` | Global Political Economy | Major global political-economic phenomena, with explicit emphasis on the post-America era — shifts in alliance structures, trade regimes, currency systems, technology decoupling, regional realignments. |
| `national` | National Political Economy | Country-specific political-economic developments in: USA, China, UK, Canada, Australia, Taiwan. (Hong Kong is implicit context but not a primary domain — HK-specific signal is covered via the competitor monitoring layer, which is HK-diaspora-heavy.) |

Each domain has its own source list, scoring weights, and temporal decay function (see §8 and §9).

---

## 4. System Architecture

### 4.1 High-Level Funnel

The pipeline is a cost-controlled funnel: cheap operations filter aggressively before expensive operations run.

```
Stage 0: Raw signals          ~10,000s items/day        (free — RSS/API fetch)
Stage 1: De-dup (URL/title)   ~5,000 unique             (free — hashing)
Stage 2: Embed + cluster      ~5,000 → ~500 clusters    (cheap — embedding $0.04/day)
Stage 3: Heuristic scoring    rank clusters             (free — source authority, recency, volume)
Stage 4: English summarise    top ~200 clusters          (cheap — Gemini Flash-lite ~$0.15/day)
Stage 5: Archive similarity   compare to 2nd-brain      (free — vector cosine, embeddings cached)
Stage 6: LLM curation         top ~100 clusters         (Sonnet ~$0.54/day)
Stage 7: Annotate + persist   temperature, trajectory, exclusive flags
Stage 8: Deliver              DB → MCP, Telegram, RSS
```

Estimated daily total: **~$0.75/day** with twice-daily runs. Hard ceiling enforced: **$1.50/day**.

### 4.2 Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 20 + TypeScript | Mirrors `2nd-brain` stack for one mental model |
| Web framework | Fastify | Lightweight, fast |
| ORM | Drizzle | Type-safe, low overhead |
| Database | PostgreSQL 16 + pgvector | On Hostinger VPS |
| Queue | BullMQ + Redis 7 | Job orchestration |
| Scheduler | node-cron | In-process, no external dependency |
| LLM router | LiteLLM proxy | Simon's existing instance |
| Embeddings | OpenAI `text-embedding-3-small` | 1536-dim, multilingual, cheap |
| Summarisation LLM | Gemini 2.5 Flash-Lite (via LiteLLM) | Cheap normalisation stage |
| Curation LLM | Claude Sonnet 4.5 (via LiteLLM) | Top-of-funnel decisions only |
| Audio transcription | Whisper (faster-whisper, on VPS) | For high-priority competitor videos |
| MCP server | `@modelcontextprotocol/sdk` | TypeScript SDK |
| Telegram | `grammy` library | Bidirectional bot |
| Container | Docker + docker-compose | Mirrors `2nd-brain` deployment |
| Reverse proxy | Caddy or nginx | TLS termination, MCP endpoint |

### 4.3 Deployment Topology

Single Hostinger VPS, single docker-compose stack:

```
hostinger-vps/
├── 2nd-brain (existing)        — postgres-A, redis-A, app-A
└── socialisn2 (new)            — postgres-B, redis-B, app-B, whisper-worker
```

Each project gets its own Postgres + Redis to avoid coupling, but they share the host. 2nd-brain integration is **via MCP only**, not via direct DB access (see §10).

### 4.4 Container Layout

```
socialisn2/
├── app                     # Main Fastify + MCP + Telegram process
├── ingestion-worker        # BullMQ worker: fetches sources
├── scoring-worker          # BullMQ worker: embed, cluster, score
├── whisper-worker          # CPU-bound transcription jobs
├── postgres                # pgvector enabled
└── redis                   # job queue + pub/sub
```

---

## 5. Data Model

All tables use UUIDv7 primary keys (sortable, time-ordered). Timestamps in UTC, displayed in US Eastern at the UI layer.

### 5.1 Core Tables

```sql
-- A configured ingestion source
CREATE TABLE sources (
  id              UUID PRIMARY KEY,
  kind            TEXT NOT NULL,         -- 'rss' | 'youtube_channel' | 'gdelt' | 'arxiv' | 'twitter_list' | 'substack'
  url             TEXT NOT NULL,
  name            TEXT NOT NULL,
  language        TEXT,                  -- ISO 639-1, NULL = mixed
  domains         TEXT[] NOT NULL,       -- ['economy', 'national'], etc
  authority_score INT NOT NULL DEFAULT 50, -- 0-100, see §9.4
  fetch_interval_min INT NOT NULL DEFAULT 60,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  last_status     TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raw, untransformed signal items
CREATE TABLE raw_items (
  id              UUID PRIMARY KEY,
  source_id       UUID NOT NULL REFERENCES sources(id),
  external_id     TEXT,                  -- the source's own id (guid, video_id, etc)
  url             TEXT NOT NULL,
  url_hash        TEXT NOT NULL,         -- sha256, for dedup
  title           TEXT NOT NULL,
  title_hash      TEXT NOT NULL,         -- normalized + sha256, for fuzzy dedup
  content         TEXT,                  -- full text where available
  author          TEXT,
  published_at    TIMESTAMPTZ NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  language        TEXT,
  raw_meta        JSONB DEFAULT '{}'::jsonb,
  UNIQUE (source_id, external_id)
);
CREATE INDEX idx_raw_items_url_hash ON raw_items(url_hash);
CREATE INDEX idx_raw_items_title_hash ON raw_items(title_hash);
CREATE INDEX idx_raw_items_published_at ON raw_items(published_at DESC);

-- Processed, normalized items (one per raw_item that survives dedup)
CREATE TABLE items (
  id                   UUID PRIMARY KEY,
  raw_item_id          UUID NOT NULL REFERENCES raw_items(id),
  title_original       TEXT NOT NULL,
  summary_en           TEXT NOT NULL,    -- 1-2 sentence English normalization
  context_en           TEXT NOT NULL,    -- 3-5 sentence neutral background
  language_original    TEXT NOT NULL,
  entities             TEXT[] DEFAULT '{}', -- people, organisations, places
  domains              TEXT[] NOT NULL,  -- multi-label
  primary_domain       TEXT NOT NULL,
  embedding            VECTOR(1536) NOT NULL,
  published_at         TIMESTAMPTZ NOT NULL,
  processed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cluster_id           UUID REFERENCES clusters(id),
  is_first_publisher   BOOLEAN,           -- for exclusive detection
  authority_weighted   FLOAT              -- source authority × recency
);
CREATE INDEX idx_items_cluster_id ON items(cluster_id);
CREATE INDEX idx_items_published_at ON items(published_at DESC);
CREATE INDEX idx_items_primary_domain ON items(primary_domain);
CREATE INDEX idx_items_embedding ON items USING hnsw (embedding vector_cosine_ops);

-- A cluster of items covering the same story/topic
CREATE TABLE clusters (
  id              UUID PRIMARY KEY,
  centroid        VECTOR(1536) NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  item_count      INT NOT NULL DEFAULT 1,
  domains         TEXT[] NOT NULL,
  primary_domain  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived' | 'merged'
  merged_into     UUID REFERENCES clusters(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_clusters_status_domain ON clusters(status, primary_domain);
CREATE INDEX idx_clusters_centroid ON clusters USING hnsw (centroid vector_cosine_ops);

-- A candidate is a cluster promoted to the user-facing pool
CREATE TABLE candidates (
  id                       UUID PRIMARY KEY,
  cluster_id               UUID NOT NULL REFERENCES clusters(id),
  headline                 TEXT NOT NULL,      -- chosen from cluster
  context_summary          TEXT NOT NULL,      -- 4-6 sentence background, neutral
  primary_domain           TEXT NOT NULL,
  domains                  TEXT[] NOT NULL,
  temperature              TEXT NOT NULL,      -- 'cold' | 'warm' | 'hot' | 'over_saturated'
  trajectory               TEXT NOT NULL,      -- 'new' | 'rising' | 'peaking' | 'declining'
  is_exclusive             BOOLEAN NOT NULL DEFAULT false,
  exclusive_source_id      UUID REFERENCES sources(id),
  similarity_score         FLOAT NOT NULL,     -- semantic similarity across sources in cluster, 0-1
  archive_overlap          FLOAT NOT NULL,     -- max cosine sim to Simon's archive, 0-1
  archive_overlap_links    JSONB,              -- references to matching prior essays/episodes
  curation_score           FLOAT NOT NULL,     -- final LLM score, 0-100
  curation_rationale       TEXT,               -- LLM-generated reason for inclusion
  keywords                 TEXT[] NOT NULL,    -- for RSS tags
  tags                     TEXT[] NOT NULL,    -- e.g. ['post-america', 'energy-transition']
  status                   TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'picked' | 'passed' | 'deferred' | 'expired'
  shown_at                 TIMESTAMPTZ,
  decided_at               TIMESTAMPTZ,
  decision_reason          TEXT,
  generated_run_id         UUID NOT NULL,      -- which scoring run produced this
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL -- per domain decay (see §9.2)
);
CREATE INDEX idx_candidates_status ON candidates(status);
CREATE INDEX idx_candidates_primary_domain_status ON candidates(primary_domain, status);
CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);

-- Records every pick/pass/defer for feedback loop
CREATE TABLE feedback (
  id              UUID PRIMARY KEY,
  candidate_id    UUID NOT NULL REFERENCES candidates(id),
  action          TEXT NOT NULL,         -- 'pick' | 'pass' | 'defer'
  reason          TEXT,
  interface       TEXT NOT NULL,         -- 'mcp' | 'telegram'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Competitor channels
CREATE TABLE competitors (
  id               UUID PRIMARY KEY,
  platform         TEXT NOT NULL,        -- 'youtube' | 'facebook' | 'substack'
  external_id      TEXT NOT NULL,        -- channel ID
  url              TEXT NOT NULL,
  name             TEXT NOT NULL,
  priority_tier    INT NOT NULL DEFAULT 2,  -- 1 = whisper, 2 = cheap signal only
  language         TEXT NOT NULL DEFAULT 'zh-HK',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_video_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, external_id)
);

-- Competitor video metadata + transcripts
CREATE TABLE competitor_videos (
  id                  UUID PRIMARY KEY,
  competitor_id       UUID NOT NULL REFERENCES competitors(id),
  external_id         TEXT NOT NULL,
  url                 TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  published_at        TIMESTAMPTZ NOT NULL,
  duration_sec        INT,
  transcript_text     TEXT,
  transcript_method   TEXT,              -- 'whisper' | 'cheap_signal' | NULL
  topic_summary_en    TEXT,
  embedding           VECTOR(1536),
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competitor_id, external_id)
);
CREATE INDEX idx_competitor_videos_embedding ON competitor_videos USING hnsw (embedding vector_cosine_ops);

-- GDELT enrichment cache
CREATE TABLE gdelt_coverage (
  id                  UUID PRIMARY KEY,
  cluster_id          UUID REFERENCES clusters(id),
  query_hash          TEXT NOT NULL,     -- hash of query parameters used
  first_seen_gdelt    TIMESTAMPTZ,
  total_article_count INT,
  country_count       INT,
  language_count      INT,
  source_outlets      TEXT[],
  themes              TEXT[],
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scoring run metadata
CREATE TABLE runs (
  id                  UUID PRIMARY KEY,
  kind                TEXT NOT NULL,     -- 'morning' | 'afternoon' | 'manual'
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL,     -- 'running' | 'completed' | 'failed'
  raw_items_count     INT,
  items_count         INT,
  clusters_count      INT,
  candidates_count    INT,
  total_cost_usd      NUMERIC(10,4),
  error               TEXT,
  metadata            JSONB DEFAULT '{}'::jsonb
);
```

### 5.2 Why These Choices

- **Separate `raw_items` and `items` tables.** Raw is immutable archival; items is the processed, embedded layer. Reprocessing (e.g. better summarisation prompt) replays from raw without re-fetching.
- **Clusters are durable, not session-scoped.** A cluster created Monday morning can grow throughout the day; we don't recluster from scratch every run.
- **Candidates have hard expiry.** Per-domain decay (§9.2) writes `expires_at` at creation. A nightly job moves expired candidates to `status='expired'`.
- **`generated_run_id` on candidates.** Lets us A/B compare runs and roll back if a scoring prompt regression dumps garbage.

---

## 6. Signal Sources

All sources live in the `sources` table and are configured by seed data (`migrations/seed_sources.sql`) on initial deploy. New sources are added via Simon's MCP tool or directly via SQL.

### 6.1 News — General

Authority score in `()`. Higher = more weight in heuristic ranking. Scale 0-100.

| Source | Authority | Domains | Language |
|--------|-----------|---------|----------|
| Reuters | 85 | economy, geopolitics, national | en |
| Bloomberg | 85 | economy, geopolitics, national | en |
| Financial Times | 90 | economy, geopolitics, national | en |
| The Economist | 85 | economy, geopolitics, national, economics | en |
| Wall Street Journal | 80 | economy, national | en |
| Nikkei Asia | 80 | geopolitics, national | en |
| The Information | 85 | scitech | en |
| Politico (US/EU) | 75 | national, geopolitics | en |
| Foreign Affairs | 80 | geopolitics | en |
| Foreign Policy | 75 | geopolitics | en |
| Project Syndicate | 70 | economics, geopolitics | en |
| Asia Times | 70 | geopolitics, national | en |
| South China Morning Post | 70 | national (China/HK) | en |

**Note on "exclusive report" detection:** for any cluster where the first-published source has authority ≥ 75 and was published more than 4 hours before the second source in the cluster, mark `is_exclusive = true` and store `exclusive_source_id`.

### 6.2 Frontier Tech — Mass Market

| Source | Authority | Sub-area |
|--------|-----------|----------|
| Wired | 70 | general |
| MIT Technology Review | 80 | general |
| The Information | 85 | IT/business |
| Ars Technica | 75 | IT |
| The Verge | 65 | IT |
| Nature News | 85 | bio/sci |
| Stat News | 80 | bio/pharma/medical |
| Endpoints News | 80 | pharma |
| Canary Media | 75 | energy |
| Heatmap News | 75 | energy/climate |

### 6.3 Frontier Tech — Niche & Expert

**IT / Computer Science:**
- arXiv `cs.AI`, `cs.CL`, `cs.LG` (daily listing)
- Hugging Face Daily Papers
- Anthropic, OpenAI, DeepMind, Meta AI, Google Research blogs
- Stratechery (Ben Thompson)
- Semianalysis
- Import AI (Jack Clark)
- Hacker News top stories (filtered by domain whitelist)

**Energy:**
- IEA reports
- RMI (Rocky Mountain Institute) publications
- Volts newsletter (David Roberts)
- NBER working papers — energy & environment
- BloombergNEF reports (open content)

**Biological / Pharmaceutical / Medical:**
- bioRxiv (daily new postings, filtered by sub-categories: synthetic biology, neuroscience, immunology, cancer biology, genomics)
- medRxiv (daily, filtered for therapeutic relevance)
- Nature Medicine, NEJM (open abstracts)
- Stat News, Endpoints News (already listed in mass market — overlap fine)
- In the Pipeline (Derek Lowe)
- The Transmitter (neuroscience)

### 6.4 Academic — Economics & Adjacent

- NBER Working Papers (daily)
- SSRN — top downloads in Economics, Finance, Political Science
- VoxEU
- Marginal Revolution (Tyler Cowen — also influencer, see §6.6)
- AEA papers and proceedings (when in season)
- Behavioral Scientist
- Psychological Science (current issue)
- American Sociological Review (current issue)

### 6.5 Country-Specific Political Economy

**USA:**
- Politico, Axios, The Atlantic, The Bulwark, Slow Boring, The Dispatch, Reason

**China:**
- Sinocism (Bill Bishop), Trivium China, China Books Review, Caixin Global, ChinaTalk (Jordan Schneider), MacroPolo

**UK:**
- The Guardian (filtered: politics + business), The Times (where accessible), Tortoise, UnHerd, ConservativeHome, LabourList

**Canada:**
- The Globe and Mail (politics + business), National Post, The Hub, The Line, Maclean's

**Australia:**
- The Australian, ABC News politics, The Conversation AU, Crikey, Inside Story

**Taiwan:**
- Focus Taiwan, Taipei Times, 天下雜誌, 報導者, China-Taiwan-focused English commentary

### 6.6 Social Influencers — Seed List

Twitter/X handles to monitor (system creates Twitter lists, or scrapes via nitter or RSS-bridge). Substack-published authors are also tracked via Substack RSS.

**Economy & Finance:**
- @TylerCowen (Marginal Revolution)
- @Noahpinion (Noah Smith — Substack)
- @adam_tooze (Adam Tooze — Chartbook Substack)
- @M_C_Klein (Matthew Klein — The Overshoot Substack)
- @JosephPolitano (Apricitas Economics Substack)
- @ConorSen
- @cullenroche
- @soberlook
- @C_Barraud (Christophe Barraud — macro)

**Academic Economics:**
- @Claudia_Sahm
- @Brad_Setser
- @BrankoMilan
- @JustinWolfers
- @JosephEStiglitz
- @PaulKrugman

**US Politics:**
- @mattyglesias (Slow Boring)
- @ezraklein
- @Yascha_Mounk
- @derek_h_thompson
- @perrybaconjr

**China:**
- @niubi (Bill Bishop — Sinocism)
- @LingLingWei
- @bonniegirard
- @Sino_Market
- @jordanschnyc (Jordan Schneider — ChinaTalk)
- @IanDenisJohnson

**UK:**
- @HelenHet20 (Helen Thompson)
- @rcolvile (Robert Colvile)
- @s8mb (Sam Bowman)

**Canada:**
- @acoyne (Andrew Coyne)
- @stephenfgordon (Stephen Gordon)
- @trevortombe

**Australia:**
- @JohnQuiggin
- @SaulEslake

**Taiwan:**
- @wenti_sung (Wen-Ti Sung)
- @LevNachman

**Frontier Tech — AI/CS:**
- @karpathy (Andrej Karpathy)
- @simonw (Simon Willison)
- @dwarkesh_sp (Dwarkesh Patel)
- @sarahookr (Sara Hooker)
- @blancheminerva (Stella Biderman)
- @jackclarkSF (Jack Clark — Import AI)

**Frontier Tech — Energy:**
- @drvolts (David Roberts — Volts)
- @doomberg
- @robinsonmeyer

**Frontier Tech — Bio/Pharma:**
- @Dereklowe (Derek Lowe)
- @EricTopol

> **Note for Simon:** Validate and expand this list on first run. The MCP tool `add_influencer` accepts handles/URLs and assigns them to domains.

### 6.7 Competitor Channels

Simon maintains his own list of HK-diaspora competitor channels (predominantly YouTube, some Facebook). The schema (§5.1) supports both platforms. Seed via MCP tool `expand_competitor_list` on first run.

Two priority tiers:

- **Tier 1 (whisper):** Up to 10 channels. Every new video gets full Whisper transcription (faster-whisper, on VPS). Whisper output is then summarised by Gemini Flash-Lite into a topic summary, embedded, and treated as a high-quality signal item in the candidate pool. Estimated CPU load: ~30-60 min/day on the VPS.
- **Tier 2 (cheap signal):** Unlimited channels. Title + description + chapter timestamps (where available) only. No transcription. Treated as low-authority signal — provides clustering volume but rarely a primary candidate source.

> **v2.1 roadmap (documented per Simon's instruction):** Add promotion logic from Tier 2 to Tier 1 on demand: if a Tier 2 channel's new video clusters with an existing high-temperature candidate, automatically trigger Whisper transcription for that video and re-score the candidate with the better signal. This avoids wasting Whisper cycles on cold topics while ensuring high-signal moments get the full treatment.

### 6.8 GDELT (Enrichment Layer, Not Primary)

GDELT 2.0 GKG API is queried after clustering to enrich candidates, not before to find them. For each top-scored cluster:

- Query GDELT for the cluster's primary entities + date range
- Pull: first-seen timestamp (compare to our `first_seen_at`), total article count, country count, language count, top source outlets, GDELT themes
- Use these to:
  - Cross-validate the `is_exclusive` flag (if GDELT first-seen is earlier than our earliest source, the story broke elsewhere first)
  - Compute geographic spread for temperature
  - Detect "overlooked" signal: high relevance score but low total article count = under-reported

GDELT is rate-limited (free tier) — cache responses for 6 hours per query.

---

## 7. Ingestion Pipeline

### 7.1 Fetching

The `ingestion-worker` consumes a BullMQ queue. Cron schedule populates the queue at staggered intervals based on each source's `fetch_interval_min`. Defaults:

- News RSS: every 60 min
- arXiv / bioRxiv / medRxiv daily listings: once per day at 09:30 ET
- NBER / SSRN: once per day at 10:00 ET
- Twitter/X lists: every 90 min (rate-limited)
- YouTube competitor channels: every 4 hours (RSS feed via YouTube channel feed URL)
- GDELT GKG: on-demand per cluster, cached 6h

Each fetch writes new items to `raw_items` (idempotent on `(source_id, external_id)`).

### 7.2 De-duplication

Two-pass:

1. **Hash dedup (free, immediate):** `url_hash` (sha256 of canonical URL) and `title_hash` (sha256 of normalized title — lowercase, strip punctuation, collapse whitespace). Reject exact duplicates at insert.

2. **Semantic dedup (cheap, deferred):** Within each scoring run, after embedding, items with cosine similarity ≥ 0.93 to an existing item from the same domain in the past 7 days are merged into the same cluster without creating new `items` rows.

### 7.3 Normalization

For each new `raw_item` that passes dedup:

1. **English summarisation (Gemini Flash-Lite):**
   Prompt produces three outputs:
   - `summary_en` (1-2 sentences, ~30 words): a neutral, factual summary
   - `context_en` (3-5 sentences, ~80 words): background a reader needs to understand why this matters
   - `entities` (array): people, organisations, places, products mentioned
   - `domains` + `primary_domain`: classification into the five domains
   - `keywords` (3-7): topical tags

   System prompt enforces neutrality: no thesis, no angle, no editorial framing. The downstream stage adds editorial framing; this stage is pure information.

2. **Embedding:** OpenAI `text-embedding-3-small` over `summary_en + context_en + entities`.

3. **Authority weighting:** `authority_weighted = source.authority_score * recency_decay(published_at, domain)` (see §9.2 for decay function).

### 7.4 Clustering

For each new item:

- Query Postgres for clusters in the same `primary_domain` with `last_seen_at > NOW() - INTERVAL '7 days'` and centroid cosine distance < 0.30 (i.e. similarity > 0.70).
- If a match: assign `cluster_id`, update cluster centroid (running mean), increment `item_count`, update `last_seen_at`.
- If no match: create a new cluster with the item's embedding as centroid.
- Periodic compaction (daily 03:00 ET): merge clusters with centroid similarity > 0.85 that share entities.

---

## 8. Per-Domain Configuration

Each domain has overrides in a config file (`config/domains.ts`). Key per-domain parameters:

| Domain | Recency half-life | Default authority weight | Cluster threshold | Notes |
|--------|------------------|--------------------------|-------------------|-------|
| `economy` | 48 hours | 1.0 | 0.70 | News cycle dominated; fast decay |
| `economics` | 14 days | 1.2 (academic sources boosted) | 0.72 | Working papers stay relevant longer |
| `scitech` | 7 days | 1.0 | 0.70 | Mixed — papers slower, news faster |
| `geopolitics` | 5 days | 1.1 | 0.68 | Stories develop over days, weeks |
| `national` | 3 days | 1.0 | 0.70 | Country-specific, country sources |

Recency decay function: `exp(-ln(2) * age_hours / half_life_hours)`.

---

## 9. Scoring & Curation Engine

This is the heart of the system. It runs twice daily, triggered by cron at:

- **Morning run:** 05:00 ET (candidates available by 06:00 ET for Simon's morning recording window)
- **Afternoon run:** 14:00 ET (candidates available by 15:00 ET)

Each run executes Stages 3-7 of the funnel (§4.1).

### 9.1 Stage 3 — Heuristic Cluster Scoring (free)

For each active cluster (status='active', last_seen_at within decay window):

```
cluster_heuristic_score =
    log(1 + sum_of_authority_weighted_items)
  * domain_weight
  * (1 + 0.5 * geographic_spread_bonus)
  * exclusive_bonus_multiplier
```

Where:
- `geographic_spread_bonus`: number of distinct countries in source set, from GDELT if available (0-1, capped)
- `exclusive_bonus_multiplier`: 1.5 if `is_exclusive`, else 1.0

Top 200 clusters per run advance to Stage 4. Below 200 is fine on quiet days; no padding.

### 9.2 Stage 4 — Cluster Summarisation (Gemini Flash-Lite)

For each Stage 3 advancer, the LLM is given all `items` in the cluster (their `summary_en`, `context_en`, source name, `published_at`) and produces:

- `headline`: the best single headline for the candidate (drawn from a real item, paraphrased if needed for clarity)
- `context_summary` (4-6 sentences, ~120 words): the unified background — what is this, what happened, what's the factual situation. **No thesis, no angle.**
- `keywords` (5-8): topical tags
- `tags`: 1-3 strategic tags like `'post-america'`, `'energy-transition'`, `'china-decoupling'` from a controlled vocabulary in `config/tags.ts`

Hard rule: this stage does not opine. It produces facts and context, nothing else.

### 9.3 Stage 5 — Archive Similarity (free, calls 2nd-brain MCP)

For each Stage 4 cluster, call `2nd-brain` MCP tool `archive_search(embedding, top_k=5)` and compute:

- `archive_overlap`: max cosine similarity to any prior essay or YouTube episode
- `archive_overlap_links`: top 3 matches with their URLs/titles

If `archive_overlap > 0.85` AND match published in last 90 days → cluster is dropped from the candidate pool (already covered).

If `0.70 < archive_overlap ≤ 0.85` → cluster proceeds but is flagged in metadata as `related_to_recent_work`. The MCP and Telegram views surface this so Simon knows.

### 9.4 Stage 6 — LLM Curation (Sonnet, top ~100 clusters only)

For each cluster surviving Stage 5, Sonnet receives:

- The headline, context_summary, keywords, tags
- The cluster's source list with authority scores
- The temperature/trajectory annotations (pre-computed, see §9.5)
- The archive_overlap metadata
- Simon's positioning statement (from `config/positioning.md`, contents below)

And outputs:

- `curation_score` (0-100)
- `curation_rationale` (1-2 sentences explaining why this scored as it did)

The positioning statement (`config/positioning.md`):

```markdown
# Positioning — Simon Lee, 利世民頻道

## Voice
Economist-first, classical liberal, targeting educated HK diaspora with
graduate-level analytical depth. The analytical default is to find the
rational and logical reasoning that explains a phenomenon. Economic
reasoning is the most common manifestation but not the only one; other
social sciences are equally welcome where they fit the evidence better.

## Three things that make a candidate good
1. Unique perspective with cross-disciplinary analysis available
2. Subject or angle overlooked by mainstream commentators
3. Rational/logical reasoning can be applied to explain it

## Two things that make a candidate weak
1. Old news with no new development
2. Over-saturated topics where every outlet says the same thing AND no
   contrarian or under-explored angle is available

## Note on over-saturated topics
Over-saturated does NOT mean disqualified. If a contrarian, counter-
evidence-based, or cross-disciplinary angle is available, an over-
saturated topic can be one of the strongest picks. Score the angle
availability, not the topic popularity.

## Hard exclusions
- Pure horse-race political coverage with no policy substance
- Personality drama, scandal-as-spectacle
- Pure financial market trading commentary (technicals, day-trading)
- Pure HK domestic politics (covered separately by competitor channels)
```

Curation cutoff: only clusters with `curation_score ≥ 60` become candidates. On a low-quality day this might be 0; that's acceptable.

### 9.5 Temperature & Trajectory Computation

Computed once per scoring run, before Stage 6 (the LLM sees them).

**Temperature** — current discussion intensity for this cluster:

```
volume_z = (cluster.item_count - domain_30d_mean_item_count) / domain_30d_stddev
```

- `volume_z < 0`: `cold`
- `0 ≤ volume_z < 1`: `warm`
- `1 ≤ volume_z < 2.5`: `hot`
- `volume_z ≥ 2.5` AND average pairwise item similarity > 0.75: `over_saturated`

**Trajectory** — 24-hour derivative on `item_count`:

```
trajectory_ratio = items_added_last_24h / max(items_added_24_to_48h_ago, 1)
```

- First-seen within 24h: `new`
- `trajectory_ratio > 1.5`: `rising`
- `0.7 ≤ trajectory_ratio ≤ 1.5`: `peaking`
- `trajectory_ratio < 0.7`: `declining`

### 9.6 Stage 7 — Persist as Candidates

For each Stage 6 cluster scoring ≥ 60, INSERT into `candidates`. Compute `expires_at` from domain decay (e.g. economy: NOW + 48h; economics: NOW + 14d).

After insert, fire BullMQ jobs:
- `notify-telegram` for the user push
- `regenerate-rss` to rebuild feeds

---

## 10. Integration with `unsubject/2nd-brain`

Communication is **strictly via MCP**. Socialisn2 acts as an MCP client to 2nd-brain's MCP server. No direct database access between the two systems.

### 10.1 Tools Consumed from 2nd-brain

Socialisn2 expects these tools to be available on the 2nd-brain MCP server. If their exact signatures differ at integration time, document the deltas and adapt.

- `archive_search(query_embedding: float[1536], top_k: int) -> [{id, title, url, published_at, similarity, type: 'essay'|'episode'}]`
  Returns prior essays and YouTube episodes by vector similarity.

- `archive_search_text(query: string, top_k: int) -> [{...}]`
  Text-based fallback if embedding cannot be supplied.

- `record_pick(candidate: {headline, context, domain, keywords, tags, urls[]}, decision: 'pick'|'pass'|'defer', reason?: string) -> {ok: boolean}`
  Writes Simon's pick/pass/defer decisions into 2nd-brain as training signal.

- `record_episode_link(candidate_id: string, episode_url: string) -> {ok: boolean}`
  Called when Simon eventually publishes an episode tracing back to a picked candidate (this is fired manually or by future automation; not in the v1 critical path).

### 10.2 Integration Mechanics

- 2nd-brain MCP URL stored as `TWO_BRAIN_MCP_URL` in env vars.
- Auth token as `TWO_BRAIN_MCP_TOKEN`.
- All calls retried up to 3x with exponential backoff. On final failure, candidate scoring proceeds with `archive_overlap=0` and a warning logged; better to surface a possibly-redundant candidate than to drop the run.
- Embeddings in Socialisn2 and 2nd-brain MUST use the same model (`text-embedding-3-small`). Confirm at deployment and fail loudly on mismatch.

---

## 11. Output Layer

### 11.1 Database as System of Record

Everything Simon sees in any interface is a view over the `candidates` table. Status transitions:

```
new ──pick──▶ picked          (logged to feedback, sent to 2nd-brain)
   ──pass──▶ passed           (logged to feedback, sent to 2nd-brain)
   ──defer──▶ deferred         (re-surfaced in next run if not expired)
   ──[expires_at < NOW()]──▶ expired
```

### 11.2 RSS Feeds

Static-generated files written to `/var/www/socialisn2/feeds/` and served by nginx/Caddy.

- `/feeds/all.xml` — master feed, all `new` candidates
- `/feeds/economy.xml`, `/feeds/economics.xml`, `/feeds/scitech.xml`, `/feeds/geopolitics.xml`, `/feeds/national.xml` — per-domain feeds

Each item includes:

- Title: candidate `headline`
- Description: candidate `context_summary`
- Categories (RSS `<category>` tags): `keywords` + `tags`
- Custom namespace fields: `<socialisn2:temperature>`, `<socialisn2:trajectory>`, `<socialisn2:exclusive>`, `<socialisn2:archive_overlap>`
- pubDate: candidate `created_at`
- guid: candidate `id`
- link: a deep link to the candidate's detail page (a minimal HTML view at `/c/{id}` showing the full context + source list)

Regenerated on every `notify-telegram` event (i.e. after every scoring run).

### 11.3 Telegram Bot (Bidirectional)

Library: `grammy`. Single chat ID (Simon's), no multi-user.

**Push behaviour:**
- After each scoring run: a single digest message — "Morning run complete. 4 new in `economy`, 2 in `geopolitics`, 1 exclusive flagged. /today"
- When an `is_exclusive` candidate is created: instant standalone push, regardless of run cadence

**Commands:**

| Command | Behaviour |
|---------|-----------|
| `/today` | List today's `new` candidates, grouped by domain, with `temperature` and `trajectory` icons |
| `/domain <code>` | Filter to a single domain (e.g. `/domain economy`) |
| `/cand <id>` | Show full candidate detail: headline, context, sources, exclusive flag, archive overlap with links |
| `/pick <id> [reason]` | Mark picked, fire feedback + 2nd-brain write |
| `/pass <id> [reason]` | Mark passed, fire feedback + 2nd-brain write |
| `/defer <id>` | Defer for tomorrow |
| `/search <query>` | Semantic search across active candidates |
| `/add_competitor <url> [tier=1|2]` | Add a competitor channel |
| `/add_influencer <handle_or_url> [domain]` | Add a social influencer source |
| `/status` | Last run summary, cost so far today, queue depth |
| `/help` | Command reference |

Each candidate detail message includes inline keyboard buttons for Pick / Pass / Defer to avoid typing IDs on mobile.

### 11.4 MCP Server

Exposed at `https://socialisn2.<simon-host>/mcp` (TLS, behind Caddy/nginx). Single bearer token in `SOCIALISN2_MCP_TOKEN`.

**Tools:**

| Tool | Signature |
|------|-----------|
| `list_candidates` | `(domain?: string, temperature?: string, trajectory?: string, status?: string = 'new', limit?: int = 30) -> Candidate[]` |
| `get_candidate` | `(id: string) -> CandidateDetail` |
| `pick` | `(id: string, reason?: string) -> { ok: boolean, archive_recorded: boolean }` |
| `pass` | `(id: string, reason?: string) -> { ok: boolean }` |
| `defer` | `(id: string) -> { ok: boolean }` |
| `search_candidates` | `(query: string, limit?: int = 20) -> Candidate[]` |
| `expand_competitor_list` | `(channel_url: string, priority_tier?: 1\|2 = 2) -> { competitor_id: string }` |
| `add_influencer` | `(handle_or_url: string, domain?: string) -> { source_id: string }` |
| `compare_against_archive` | `(candidate_id: string) -> { matches: ArchiveMatch[], max_similarity: float }` |
| `run_now` | `() -> { run_id: string, status: 'started' }` — triggers an ad-hoc scoring run |
| `system_status` | `() -> { last_run, cost_today_usd, queue_depth, candidate_pool_size }` |

`Candidate` shape returned by list/search:

```typescript
{
  id: string;
  headline: string;
  primary_domain: string;
  domains: string[];
  temperature: 'cold' | 'warm' | 'hot' | 'over_saturated';
  trajectory: 'new' | 'rising' | 'peaking' | 'declining';
  is_exclusive: boolean;
  similarity_score: number;     // intra-cluster source similarity
  archive_overlap: number;
  curation_score: number;
  keywords: string[];
  tags: string[];
  context_preview: string;      // first 80 chars of context_summary
  created_at: string;
}
```

`CandidateDetail` extends `Candidate` with:

```typescript
{
  context_summary: string;       // full
  curation_rationale: string;
  archive_overlap_links: ArchiveMatch[];
  sources: SourceItem[];         // every raw_item in the cluster
  exclusive_source?: { id, name, url, published_at };
}
```

---

## 12. Cost Budget & Enforcement

Hard ceiling: **USD $1.50/day**. The system tracks token spend per LLM call in `runs.total_cost_usd` and per-call rows in a `cost_ledger` table (omitted from §5 for brevity; standard fields: timestamp, run_id, model, input_tokens, output_tokens, usd).

Enforcement:
- Before each scoring stage, check today's running total. If projected stage cost would exceed ceiling, the run logs `cost_ceiling_hit` and halts at current stage — partial candidates are still persisted.
- Telegram `/status` shows daily spend; an alert fires at 80% of ceiling.

Estimated breakdown for a normal day (twice-daily runs):

| Stage | Model | Daily est |
|-------|-------|-----------|
| Embedding (~2000 items) | text-embedding-3-small | $0.04 |
| Summarisation (~2000 items) | gemini-2.5-flash-lite | $0.15 |
| Curation (~100 clusters) | claude-sonnet-4.5 | $0.54 |
| Whisper (10 priority videos) | local CPU | $0.00 |
| Telegram, RSS, MCP serving | — | $0.00 |
| **Total** | | **~$0.73** |

Headroom of $0.77/day for the inevitable noisy days.

---

## 13. Backfill Strategy (Cold-Start)

Run once on first deploy, before the first scheduled scoring run.

**Source corpus for cold start:**
- Simon's YouTube channel (`@leesimon`) — last 12 months of videos, fetched via YouTube Data API. Title + description + (where available) the cleaned subtitle file from Simon's `srt-processor` pipeline.
- 2nd-brain essay corpus — already vectorized, accessed via 2nd-brain MCP.

**Process:**
1. Pull a 30-day historical signal window from RSS archives and GDELT GKG.
2. Run the full ingestion pipeline against this historical window (no LLM curation yet — just clustering and summarisation).
3. For each historical cluster, compare its embedding against (a) the YouTube channel's last 12 months and (b) the 2nd-brain essay corpus.
4. A historical cluster with high similarity to a published episode/essay is a **positive label** (Simon would have picked this).
5. A historical cluster with low similarity to anything in the archive is a **negative or neutral label** (Simon passed or never saw it).
6. Use these labels to compute initial domain authority calibration: source authorities (§6.1-6.6) are adjusted up/down based on how often their items appeared in positive-label clusters.

This is a one-time job, expected to consume ~$5-10 of inference budget. Output is written to `backfill_run` table with full provenance for review.

---

## 14. Feedback Loop

Every `pick`, `pass`, `defer` action:

1. Writes a row to `feedback` (local).
2. Calls 2nd-brain MCP `record_pick` to push the labelled candidate into 2nd-brain's training store.

Over time (≥ 90 days of usage), 2nd-brain accumulates ~500-1000 labelled examples. A future v1.x will:

- Use 2nd-brain's pick history to fine-tune the curation prompt or to fit a small classifier that pre-filters before Sonnet sees clusters
- Re-compute source authority dynamically based on which sources surfaced picks vs passes

Both are deferred from v1 but the data collection happens from day one.

---

## 15. Roadmap — Deferred to v2.x

Explicitly noted so they are not built in v1:

- **v2.1 — Tier promotion for competitor monitoring** (per Simon's instruction): When a Tier 2 competitor video clusters with an existing high-temperature candidate, automatically promote that video to Whisper transcription and re-score the candidate with the better signal. Avoids wasted Whisper cycles on cold topics.
- **v2.2 — Email digest layer.** Daily HTML email summary, configurable cadence.
- **v2.3 — Classifier on feedback.** Train a small classifier on accumulated picks/passes to pre-filter before Sonnet.
- **v2.4 — Push-on-publish hook.** When Simon publishes a new episode, automatically run `record_episode_link` to close the feedback loop.

---

## 16. Repository Layout

```
socialisn2/
├── README.md
├── SPEC.md                       (this document)
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── config/
│   ├── domains.ts
│   ├── positioning.md
│   ├── tags.ts                   (controlled vocabulary)
│   └── prompts/
│       ├── normalize.txt         (Gemini Flash-Lite summarisation)
│       ├── curate.txt            (Sonnet curation)
│       └── headline.txt          (cluster headline generation)
├── migrations/
│   ├── 001_init.sql
│   ├── 002_seed_sources.sql
│   └── 003_seed_competitors.sql
├── src/
│   ├── app.ts                    (Fastify entrypoint)
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools/
│   ├── telegram/
│   │   ├── bot.ts
│   │   └── commands/
│   ├── ingestion/
│   │   ├── rss.ts
│   │   ├── youtube.ts
│   │   ├── twitter.ts
│   │   ├── arxiv.ts
│   │   ├── gdelt.ts
│   │   └── whisper.ts
│   ├── scoring/
│   │   ├── dedup.ts
│   │   ├── normalize.ts
│   │   ├── cluster.ts
│   │   ├── temperature.ts
│   │   ├── trajectory.ts
│   │   ├── exclusive.ts
│   │   ├── archive.ts            (calls 2nd-brain MCP)
│   │   └── curate.ts             (Sonnet call)
│   ├── db/
│   │   ├── schema.ts             (Drizzle)
│   │   └── client.ts
│   ├── rss/
│   │   └── generate.ts
│   ├── backfill/
│   │   └── run.ts
│   ├── cost/
│   │   ├── ledger.ts
│   │   └── ceiling.ts
│   └── lib/
│       ├── llm.ts                (LiteLLM client)
│       ├── embeddings.ts
│       └── two_brain_client.ts   (MCP client to 2nd-brain)
├── scripts/
│   ├── deploy.sh
│   ├── backfill.sh
│   └── seed_sources.ts
└── tests/
    ├── dedup.test.ts
    ├── cluster.test.ts
    ├── temperature.test.ts
    └── ...
```

---

## 17. Environment Variables

```
# Database
DATABASE_URL=postgresql://socialisn2:...@postgres:5432/socialisn2
REDIS_URL=redis://redis:6379

# LLM
LITELLM_BASE_URL=https://litellm.<simon-host>/
LITELLM_API_KEY=...
OPENAI_API_KEY=...                     # for embeddings only

# 2nd-brain MCP
TWO_BRAIN_MCP_URL=https://2ndbrain.<simon-host>/mcp
TWO_BRAIN_MCP_TOKEN=...

# This server's MCP
SOCIALISN2_MCP_TOKEN=...                # bearer for inbound MCP

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...                    # Simon's chat ID

# YouTube
YOUTUBE_API_KEY=...

# GDELT (no auth, but rate limit key)
GDELT_USER_AGENT=socialisn2/1.0 (simon@...)

# Twitter/X via nitter (no API key needed) or RSS-bridge
NITTER_BASE=https://nitter.<simon-host>

# Cost
COST_CEILING_DAILY_USD=1.50
COST_ALERT_THRESHOLD=0.80

# Schedule
SCHEDULE_MORNING_CRON=0 5 * * *         # 05:00 ET
SCHEDULE_AFTERNOON_CRON=0 14 * * *      # 14:00 ET
TZ=America/New_York

# Public-facing
PUBLIC_HOST=socialisn2.<simon-host>
RSS_PATH=/var/www/socialisn2/feeds
```

---

## 18. Acceptance Criteria (Definition of Done)

Socialisn2 v1 is shipped when:

1. **Ingestion** Sources from §6 are seeded; at least one item per source has been fetched and processed without error over a 24-hour observation period.
2. **Pipeline** A full scheduled scoring run completes end-to-end (Stages 0-8) in under 10 minutes.
3. **Cost** A full day of operation (two runs) stays under $1.50; cost ledger reflects actual token usage with <5% drift from LiteLLM-reported costs.
4. **Output**
   - At least 3 RSS feeds (`all.xml`, `economy.xml`, one other domain) are generated correctly and parse with a standard RSS validator.
   - Telegram bot accepts all commands in §11.3 and writes feedback rows correctly.
   - MCP server responds to all tools in §11.4 from a Claude Code session.
5. **2nd-brain integration** `archive_search` returns valid matches; `record_pick` writes to 2nd-brain and is verifiable from the 2nd-brain side.
6. **Backfill** Backfill has been run once, source authority adjustments are persisted.
7. **Observability** A `/status` endpoint and Telegram `/status` command surface: last run time, candidate pool counts by domain, cost-today, queue depths, error count last 24h.
8. **No-regression** A test suite covering dedup, clustering, temperature, trajectory, decay, and exclusive detection passes.
9. **Simon's smoke test** Over a 5-day pilot, Simon picks at least one candidate per day that he confirms (qualitatively) he would not have found via Perplexity, Google, or YouTube browsing.

---

## 19. Open Implementation Questions

Items where Claude Code may need to make a call during build — flag and ask Simon if uncertain:

- **Twitter/X ingestion mechanism.** API access requires paid tier and may be unreliable; nitter instances rotate; RSS-bridge is unofficial. Pick the most stable option at build time and document the fallback.
- **YouTube channel feed reliability.** The native RSS feed (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) is reliable but lacks chapter timestamps. For Tier 2 (cheap signal) competitors, decide whether to additionally call YouTube Data API for chapter data (paid quota cost) or to skip chapters.
- **GDELT rate limits.** The free GKG API has soft limits. If hit, fall back to GDELT 2.0 BigQuery (free, slower). Document the threshold at which fallback triggers.
- **Whisper model size.** `faster-whisper` `large-v3` is best quality but slowest. `medium` is the practical balance for Cantonese audio. Benchmark on Simon's competitor sample at build time and pick.
- **Centroid update strategy.** Running mean is simple but drifts. Consider re-centroiding clusters with > 10 items by recomputing from member embeddings — performance vs quality trade-off, decide on benchmark.
- **Headline language for candidates.** Simon's audience reads Traditional Chinese, but candidates are surfaced to Simon personally. v1 keeps headlines in the source's original language (with `summary_en` for normalization). If feedback shows he wants Chinese headlines for easier scanning, this becomes a v1.1 prompt change.

---

## 20. Handoff Notes for Claude Code

- Build in feature branches off `main`. Open a PR per major component (`ingestion`, `scoring`, `mcp`, `telegram`, `rss`, `backfill`). Each PR includes its own test suite.
- The `SPEC.md` you are reading is the source of truth. If a question arises that this document doesn't answer, raise it as an Open Question (§19) and ask Simon before assuming.
- Do NOT migrate code from `unsubject/socialisn`. Start clean. The old repo is reference material only.
- Match `2nd-brain` stylistic conventions: same TypeScript config, same Docker layout, same linting rules. If you need to make different choices, document why.
- The Perplexity API integration referenced in the old socialisn repo is **explicitly removed** in v2 (see §2). Do not re-introduce it.
- The cost ceiling (§12) is hard, not advisory. The system must halt gracefully at the ceiling, not panic.
- Simon's positioning statement (§9.4) is treated as a config file, not a prompt string. It must be editable without code changes; the curation prompt loads it at runtime.

---

**End of specification.**
