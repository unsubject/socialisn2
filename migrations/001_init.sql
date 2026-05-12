-- 001_init.sql
-- Initial schema for socialisn2. Matches src/db/schema.ts.
--
-- Run order matters: extensions → sources → clusters → items (items FK clusters,
-- so clusters must already exist). gdelt_coverage and candidates also FK clusters.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- sources
CREATE TABLE sources (
  id              UUID PRIMARY KEY,
  kind            TEXT NOT NULL,
  url             TEXT NOT NULL,
  name            TEXT NOT NULL,
  language        TEXT,
  domains         TEXT[] NOT NULL,
  authority_score INT NOT NULL DEFAULT 50,
  fetch_interval_min INT NOT NULL DEFAULT 60,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  last_status     TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('rss', 'youtube_channel', 'gdelt', 'arxiv', 'email_bridge'))
);

-- ---------------------------------------------------------------------------
-- raw_items
CREATE TABLE raw_items (
  id              UUID PRIMARY KEY,
  source_id       UUID NOT NULL REFERENCES sources(id),
  external_id     TEXT,
  url             TEXT NOT NULL,
  url_hash        TEXT NOT NULL,
  title           TEXT NOT NULL,
  title_hash      TEXT NOT NULL,
  content         TEXT,
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

-- ---------------------------------------------------------------------------
-- clusters (created before items — items.cluster_id FKs clusters.id)
CREATE TABLE clusters (
  id              UUID PRIMARY KEY,
  centroid        VECTOR(1536) NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  item_count      INT NOT NULL DEFAULT 1,
  domains         TEXT[] NOT NULL,
  primary_domain  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  merged_into     UUID REFERENCES clusters(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'archived', 'merged'))
);
CREATE INDEX idx_clusters_status_domain ON clusters(status, primary_domain);
CREATE INDEX idx_clusters_centroid ON clusters USING hnsw (centroid vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- items
CREATE TABLE items (
  id                   UUID PRIMARY KEY,
  raw_item_id          UUID NOT NULL REFERENCES raw_items(id),
  title_original       TEXT NOT NULL,
  summary_en           TEXT NOT NULL,
  context_en           TEXT NOT NULL,
  language_original    TEXT NOT NULL,
  entities             TEXT[] DEFAULT '{}',
  domains              TEXT[] NOT NULL,
  primary_domain       TEXT NOT NULL,
  embedding            VECTOR(1536) NOT NULL,
  published_at         TIMESTAMPTZ NOT NULL,
  processed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cluster_id           UUID REFERENCES clusters(id),
  is_first_publisher   BOOLEAN,
  authority_weighted   FLOAT
);
CREATE INDEX idx_items_cluster_id ON items(cluster_id);
CREATE INDEX idx_items_published_at ON items(published_at DESC);
CREATE INDEX idx_items_primary_domain ON items(primary_domain);
CREATE INDEX idx_items_embedding ON items USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- candidates
CREATE TABLE candidates (
  id                       UUID PRIMARY KEY,
  cluster_id               UUID NOT NULL REFERENCES clusters(id),
  headline                 TEXT NOT NULL,
  context_summary          TEXT NOT NULL,
  primary_domain           TEXT NOT NULL,
  domains                  TEXT[] NOT NULL,
  temperature              TEXT NOT NULL,
  trajectory               TEXT NOT NULL,
  is_exclusive             BOOLEAN NOT NULL DEFAULT false,
  exclusive_source_id      UUID REFERENCES sources(id),
  similarity_score         FLOAT NOT NULL,
  archive_overlap          FLOAT NOT NULL,
  archive_overlap_links    JSONB,
  curation_score           FLOAT NOT NULL,
  curation_rationale       TEXT,
  keywords                 TEXT[] NOT NULL,
  tags                     TEXT[] NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'new',
  shown_at                 TIMESTAMPTZ,
  decided_at               TIMESTAMPTZ,
  decision_reason          TEXT,
  generated_run_id         UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,
  CHECK (temperature IN ('cold', 'warm', 'hot', 'over_saturated')),
  CHECK (trajectory IN ('new', 'rising', 'peaking', 'declining')),
  CHECK (status IN ('new', 'picked', 'passed', 'deferred', 'expired'))
);
CREATE INDEX idx_candidates_status ON candidates(status);
CREATE INDEX idx_candidates_primary_domain_status ON candidates(primary_domain, status);
CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);

-- ---------------------------------------------------------------------------
-- feedback
CREATE TABLE feedback (
  id              UUID PRIMARY KEY,
  candidate_id    UUID NOT NULL REFERENCES candidates(id),
  action          TEXT NOT NULL,
  reason          TEXT,
  interface       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (action IN ('pick', 'pass', 'defer')),
  CHECK (interface IN ('mcp', 'telegram'))
);

-- ---------------------------------------------------------------------------
-- competitors
CREATE TABLE competitors (
  id               UUID PRIMARY KEY,
  platform         TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  url              TEXT NOT NULL,
  name             TEXT NOT NULL,
  priority_tier    INT NOT NULL DEFAULT 2,
  language         TEXT NOT NULL DEFAULT 'zh-HK',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_video_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, external_id),
  CHECK (platform IN ('youtube', 'facebook', 'substack'))
);

-- ---------------------------------------------------------------------------
-- competitor_videos
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
  transcript_method   TEXT,
  topic_summary_en    TEXT,
  embedding           VECTOR(1536),
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competitor_id, external_id)
);
CREATE INDEX idx_competitor_videos_embedding ON competitor_videos USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- gdelt_coverage
CREATE TABLE gdelt_coverage (
  id                  UUID PRIMARY KEY,
  cluster_id          UUID REFERENCES clusters(id),
  query_hash          TEXT NOT NULL,
  first_seen_gdelt    TIMESTAMPTZ,
  total_article_count INT,
  country_count       INT,
  language_count      INT,
  source_outlets      TEXT[],
  themes              TEXT[],
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- runs
CREATE TABLE runs (
  id                  UUID PRIMARY KEY,
  kind                TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL,
  raw_items_count     INT,
  items_count         INT,
  clusters_count      INT,
  candidates_count    INT,
  total_cost_usd      NUMERIC(10,4),
  error               TEXT,
  metadata            JSONB DEFAULT '{}'::jsonb,
  CHECK (kind IN ('morning', 'afternoon', 'manual')),
  CHECK (status IN ('running', 'completed', 'failed'))
);

-- ---------------------------------------------------------------------------
-- cost_ledger (per SPEC §12 — omitted from §5 for brevity)
CREATE TABLE cost_ledger (
  id              UUID PRIMARY KEY,
  run_id          UUID REFERENCES runs(id),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model           TEXT NOT NULL,
  input_tokens    INT NOT NULL,
  output_tokens   INT NOT NULL,
  usd             NUMERIC(10,6) NOT NULL,
  stage           TEXT
);
CREATE INDEX idx_cost_ledger_run_id ON cost_ledger(run_id);
CREATE INDEX idx_cost_ledger_occurred_at ON cost_ledger(occurred_at DESC);

-- ---------------------------------------------------------------------------
-- backfill_run (per SPEC §13)
CREATE TABLE backfill_run (
  id                     UUID PRIMARY KEY,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  status                 TEXT NOT NULL,
  window_start           TIMESTAMPTZ NOT NULL,
  window_end             TIMESTAMPTZ NOT NULL,
  historical_clusters    INT,
  positive_labels        INT,
  negative_labels        INT,
  authority_adjustments  JSONB,
  total_cost_usd         NUMERIC(10,4),
  error                  TEXT,
  metadata               JSONB DEFAULT '{}'::jsonb,
  CHECK (status IN ('running', 'completed', 'failed'))
);
