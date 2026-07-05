// Typed schema for socialisn2. Mirrors migrations/001_init.sql.
//
// Migrations are hand-authored SQL (per BUILD-PHASES). drizzle-kit is wired
// in drizzle.config.ts for introspection / diff, NOT for `generate` — do not
// blindly regenerate migrations from this file without reviewing the diff.
//
// IDs are UUIDv7 (sortable, time-ordered) generated in application code via
// `uuid` package's `v7()` — there is no native PG function for UUIDv7. The SQL
// columns are plain UUID with no DEFAULT.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

export const EMBEDDING_DIM = 1536;

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(), // CHECK: 'rss'|'arxiv'|'email_bridge' (see migration 016)
  url: text('url').notNull(),
  name: text('name').notNull(),
  language: text('language'),
  domains: text('domains').array().notNull(),
  authorityScore: integer('authority_score').notNull().default(50),
  // ADR-013: hand-curated authority at first insertion. Anchors the
  // Beta-Bernoulli prior; survives recalibration so a long defer streak
  // can't permanently demote a source past its seed-intended weight.
  // Migration 015 backfilled this from authority_score for all existing
  // rows; add_influencer (src/mcp/tools/sources.ts) sets it at insert.
  authorityScoreSeed: integer('authority_score_seed').notNull().default(50),
  // Stamped by the daily recalibrate cron on every successful update.
  // NULL until the first recalibrate pass touches the row.
  authorityScoreCalibratedAt: timestamp('authority_score_calibrated_at', {
    withTimezone: true,
  }),
  fetchIntervalMin: integer('fetch_interval_min').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  lastStatus: text('last_status'),
  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rawItems = pgTable(
  'raw_items',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    externalId: text('external_id'),
    url: text('url').notNull(),
    urlHash: text('url_hash').notNull(),
    title: text('title').notNull(),
    titleHash: text('title_hash').notNull(),
    content: text('content'),
    author: text('author'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    language: text('language'),
    rawMeta: jsonb('raw_meta').default(sql`'{}'::jsonb`),
    // Phase 2 processing tracking — added by migration 011. processed_at
    // marks completion of normalise → embed → dedup/cluster regardless of
    // path (normal items insert OR dedup-hit). dedup_cluster_id is set
    // ONLY for dedup hits — the normal path keeps cluster_id on items.
    // processing_attempts caps retries on poison rows; see
    // src/workers/scoring.ts for the cap value.
    processedAt: timestamp('processed_at', { withTimezone: true }),
    dedupClusterId: uuid('dedup_cluster_id').references((): AnyPgColumn => clusters.id),
    processingAttempts: integer('processing_attempts').notNull().default(0),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex('raw_items_source_external_unique').on(
      t.sourceId,
      t.externalId,
    ),
    urlHashIdx: index('idx_raw_items_url_hash').on(t.urlHash),
    titleHashIdx: index('idx_raw_items_title_hash').on(t.titleHash),
    publishedAtIdx: index('idx_raw_items_published_at').on(t.publishedAt.desc()),
    // idx_raw_items_pending is a partial index (WHERE processed_at IS NULL)
    // — declared in migration 011's SQL only. The drizzle index builder
    // here would create a full b-tree; the runtime query path doesn't need
    // the typed handle, so leaving it out of the schema avoids drift.
  }),
);

export const clusters = pgTable(
  'clusters',
  {
    id: uuid('id').primaryKey(),
    centroid: vector('centroid', { dimensions: EMBEDDING_DIM }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    itemCount: integer('item_count').notNull().default(1),
    domains: text('domains').array().notNull(),
    primaryDomain: text('primary_domain').notNull(),
    status: text('status').notNull().default('active'), // CHECK: 'active'|'archived'|'merged'
    mergedInto: uuid('merged_into').references((): AnyPgColumn => clusters.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusDomainIdx: index('idx_clusters_status_domain').on(t.status, t.primaryDomain),
    centroidHnsw: index('idx_clusters_centroid').using(
      'hnsw',
      t.centroid.op('vector_cosine_ops'),
    ),
  }),
);

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey(),
    rawItemId: uuid('raw_item_id')
      .notNull()
      .references(() => rawItems.id),
    titleOriginal: text('title_original').notNull(),
    summaryEn: text('summary_en').notNull(),
    contextEn: text('context_en').notNull(),
    languageOriginal: text('language_original').notNull(),
    entities: text('entities').array().default(sql`'{}'::text[]`),
    // `keywords` added by migration 009 (post-normalisation tag set per
    // SPEC §7.3 — 3-7 topical keywords from the normalize stage).
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    domains: text('domains').array().notNull(),
    primaryDomain: text('primary_domain').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
    clusterId: uuid('cluster_id').references(() => clusters.id),
    isFirstPublisher: boolean('is_first_publisher'),
    authorityWeighted: doublePrecision('authority_weighted'),
  },
  (t) => ({
    // raw_item_id is UNIQUE (migration 011) — at most one items row per
    // raw_item. Multi-worker race safety net + per-raw_item lookup index.
    rawItemIdUnique: uniqueIndex('items_raw_item_id_unique').on(t.rawItemId),
    clusterIdx: index('idx_items_cluster_id').on(t.clusterId),
    publishedAtIdx: index('idx_items_published_at').on(t.publishedAt.desc()),
    primaryDomainIdx: index('idx_items_primary_domain').on(t.primaryDomain),
    embeddingHnsw: index('idx_items_embedding').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  }),
);

export const candidates = pgTable(
  'candidates',
  {
    id: uuid('id').primaryKey(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => clusters.id),
    headline: text('headline').notNull(),
    contextSummary: text('context_summary').notNull(),
    primaryDomain: text('primary_domain').notNull(),
    domains: text('domains').array().notNull(),
    temperature: text('temperature').notNull(), // CHECK: 'cold'|'warm'|'hot'|'over_saturated'
    trajectory: text('trajectory').notNull(),   // CHECK: 'new'|'rising'|'peaking'|'declining'
    isExclusive: boolean('is_exclusive').notNull().default(false),
    exclusiveSourceId: uuid('exclusive_source_id').references(() => sources.id),
    similarityScore: doublePrecision('similarity_score').notNull(),
    archiveOverlap: doublePrecision('archive_overlap').notNull(),
    archiveOverlapLinks: jsonb('archive_overlap_links'),
    curationScore: doublePrecision('curation_score').notNull(),
    curationRationale: text('curation_rationale'),
    keywords: text('keywords').array().notNull(),
    tags: text('tags').array().notNull(),
    status: text('status').notNull().default('new'), // CHECK: 'new'|'picked'|'passed'|'deferred'|'expired'
    shownAt: timestamp('shown_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    generatedRunId: uuid('generated_run_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Migration 018 (supersede): set on every in-place refresh of a
    // persisting story's 'new' row; runs_seen counts how many runs the
    // story has re-qualified in. created_at stays first-seen.
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    runsSeen: integer('runs_seen').notNull().default(1),
  },
  (t) => ({
    statusIdx: index('idx_candidates_status').on(t.status),
    primaryDomainStatusIdx: index('idx_candidates_primary_domain_status').on(
      t.primaryDomain,
      t.status,
    ),
    createdAtIdx: index('idx_candidates_created_at').on(t.createdAt.desc()),
    // Migration 018: partial unique — at most ONE 'new' row per cluster.
    // Schema-level backstop against the pre-2026-07 duplicate re-mint bug.
    clusterNewIdx: uniqueIndex('idx_candidates_cluster_new')
      .on(t.clusterId)
      .where(sql`status = 'new'`),
  }),
);

// Migration 019 (feed redesign P0.3): append-only Daily Pulse entries.
// Each scoring run contributes at most PULSE_TOP_N candidate entries
// plus one morning 'waves' entry; pulse.xml renders the newest window.
// Rows are write-once snapshots so feed GUIDs stay stable.
export const pulseEntries = pgTable(
  'pulse_entries',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull(),
    kind: text('kind').notNull(), // CHECK: 'candidate'|'waves'
    candidateId: uuid('candidate_id').references(() => candidates.id),
    rank: integer('rank'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index('idx_pulse_entries_created_at').on(t.createdAt.desc()),
  }),
);

// Migration 021 (redesign P1): weekly ideation briefs. One row per
// week_of (Sunday of the generating run); re-runs upsert in place.
export const briefs = pgTable(
  'briefs',
  {
    id: uuid('id').primaryKey(),
    weekOf: date('week_of').notNull(),
    pitches: jsonb('pitches').notNull(),
    contentMd: text('content_md').notNull(),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => ({
    weekOfIdx: uniqueIndex('briefs_week_of_key').on(t.weekOf),
    createdAtIdx: index('idx_briefs_created_at').on(t.createdAt.desc()),
  }),
);

export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey(),
  candidateId: uuid('candidate_id')
    .notNull()
    .references(() => candidates.id),
  action: text('action').notNull(),       // CHECK: 'pick'|'pass'|'defer'
  reason: text('reason'),
  interface: text('interface').notNull(), // CHECK: 'mcp'|'telegram'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const competitors = pgTable(
  'competitors',
  {
    id: uuid('id').primaryKey(),
    platform: text('platform').notNull(), // CHECK: 'youtube'|'facebook'|'substack'
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    name: text('name').notNull(),
    priorityTier: integer('priority_tier').notNull().default(2),
    language: text('language').notNull().default('zh-HK'),
    enabled: boolean('enabled').notNull().default(true),
    lastVideoAt: timestamp('last_video_at', { withTimezone: true }),
    // Scheduler-side bookkeeping (mirrors the sources table convention),
    // both added by migration 007. last_video_at is the newest video's
    // publishedAt; it does NOT advance when the worker fetches and finds
    // nothing new. Scheduling decisions run off last_fetched_at instead.
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    platformExternalUnique: uniqueIndex('competitors_platform_external_unique').on(
      t.platform,
      t.externalId,
    ),
  }),
);

export const competitorVideos = pgTable(
  'competitor_videos',
  {
    id: uuid('id').primaryKey(),
    competitorId: uuid('competitor_id')
      .notNull()
      .references(() => competitors.id),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    durationSec: integer('duration_sec'),
    transcriptText: text('transcript_text'),
    transcriptMethod: text('transcript_method'), // 'whisper' | 'cheap_signal' | NULL
    topicSummaryEn: text('topic_summary_en'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    competitorExternalUnique: uniqueIndex(
      'competitor_videos_competitor_external_unique',
    ).on(t.competitorId, t.externalId),
    embeddingHnsw: index('idx_competitor_videos_embedding').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  }),
);

export const gdeltCoverage = pgTable('gdelt_coverage', {
  id: uuid('id').primaryKey(),
  clusterId: uuid('cluster_id').references(() => clusters.id),
  queryHash: text('query_hash').notNull(),
  firstSeenGdelt: timestamp('first_seen_gdelt', { withTimezone: true }),
  totalArticleCount: integer('total_article_count'),
  countryCount: integer('country_count'),
  languageCount: integer('language_count'),
  sourceOutlets: text('source_outlets').array(),
  themes: text('themes').array(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),    // CHECK: 'morning'|'afternoon'|'manual'|'recalibrate'
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  status: text('status').notNull(), // CHECK: 'running'|'completed'|'failed'
  rawItemsCount: integer('raw_items_count'),
  itemsCount: integer('items_count'),
  clustersCount: integer('clusters_count'),
  candidatesCount: integer('candidates_count'),
  totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 4 }),
  error: text('error'),
  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
});

// Per SPEC §12 — omitted from §5 "for brevity"; standard fields per spec.
export const costLedger = pgTable(
  'cost_ledger',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').references(() => runs.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    usd: numeric('usd', { precision: 10, scale: 6 }).notNull(),
    stage: text('stage'), // optional pipeline-stage tag for cost breakdown
    bucket: text('bucket'), // Phase 3 sub-budget bucket; see src/cost/buckets.ts
  },
  (t) => ({
    runIdIdx: index('idx_cost_ledger_run_id').on(t.runId),
    occurredAtIdx: index('idx_cost_ledger_occurred_at').on(t.occurredAt.desc()),
  }),
);

// Obs-2 — one-row-per-UTC-day persistence for the 80% cost-alert fire
// path. The orchestrator calls maybeFireCostAlert after each successful
// assertWithinCeiling; INSERT ... ON CONFLICT (alert_day) DO NOTHING
// guarantees the Telegram push fires exactly once per UTC day.
// pct_at_fire snapshots pctOfCeiling so a later /status surface can
// show "alerted at 84.3%" without re-reading the ledger.
export const costAlertState = pgTable('cost_alert_state', {
  alertDay: date('alert_day').primaryKey(),
  firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
  pctAtFire: numeric('pct_at_fire', { precision: 5, scale: 4 }).notNull(),
});

// Per SPEC §13 — one row per cold-start backfill run, with full provenance.
// Migration 013 added the *_status + youtube_corpus_size columns to record
// the ADR-012 backfill shape (skip historical, observe forward — see
// docs/adr/012-backfill-skip-all-historical-sources.md). All NULLable so a
// future ADR can re-enable historical-discovery paths without a schema
// migration.
export const backfillRun = pgTable('backfill_run', {
  id: uuid('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  status: text('status').notNull(), // CHECK: 'running'|'completed'|'failed'
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  // v1 (ADR-012): historical_clusters / positive_labels / negative_labels /
  // authority_adjustments stay NULL. They become populated only if a future
  // ADR re-opens RSS or GDELT-discovery as a backfill input.
  historicalClusters: integer('historical_clusters'),
  positiveLabels: integer('positive_labels'),
  negativeLabels: integer('negative_labels'),
  authorityAdjustments: jsonb('authority_adjustments'),
  totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 4 }),
  error: text('error'),
  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
  // ADR-012 provenance columns — values constrained to a closed set in
  // migration 013's CHECK constraints. The TS type stays `text` because
  // drizzle's enum() would force a duplicate definition we don't need.
  rssHistoryStatus: text('rss_history_status'),     // 'skipped'|'wayback'|'newsapi'
  gdeltHistoryStatus: text('gdelt_history_status'), // 'skipped'|'topic_seeds'|'bigquery'
  youtubeCorpusSize: integer('youtube_corpus_size'),
  brainCorpusStatus: text('brain_corpus_status'),   // 'available'|'unreachable'|'not_configured'
});
