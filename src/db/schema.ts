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
  kind: text('kind').notNull(), // CHECK: 'rss'|'youtube_channel'|'gdelt'|'arxiv'|'email_bridge'
  url: text('url').notNull(),
  name: text('name').notNull(),
  language: text('language'),
  domains: text('domains').array().notNull(),
  authorityScore: integer('authority_score').notNull().default(50),
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
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex('raw_items_source_external_unique').on(
      t.sourceId,
      t.externalId,
    ),
    urlHashIdx: index('idx_raw_items_url_hash').on(t.urlHash),
    titleHashIdx: index('idx_raw_items_title_hash').on(t.titleHash),
    publishedAtIdx: index('idx_raw_items_published_at').on(t.publishedAt.desc()),
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
  },
  (t) => ({
    statusIdx: index('idx_candidates_status').on(t.status),
    primaryDomainStatusIdx: index('idx_candidates_primary_domain_status').on(
      t.primaryDomain,
      t.status,
    ),
    createdAtIdx: index('idx_candidates_created_at').on(t.createdAt.desc()),
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
  kind: text('kind').notNull(),    // CHECK: 'morning'|'afternoon'|'manual'
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
  },
  (t) => ({
    runIdIdx: index('idx_cost_ledger_run_id').on(t.runId),
    occurredAtIdx: index('idx_cost_ledger_occurred_at').on(t.occurredAt.desc()),
  }),
);

// Per SPEC §13 — one row per cold-start backfill run, with full provenance.
export const backfillRun = pgTable('backfill_run', {
  id: uuid('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  status: text('status').notNull(), // CHECK: 'running'|'completed'|'failed'
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  historicalClusters: integer('historical_clusters'),
  positiveLabels: integer('positive_labels'),
  negativeLabels: integer('negative_labels'),
  authorityAdjustments: jsonb('authority_adjustments'),
  totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 4 }),
  error: text('error'),
  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
});
