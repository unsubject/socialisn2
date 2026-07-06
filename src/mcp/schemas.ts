// zod input schemas + tools/list definitions for the 12 SPEC §11.4
// tools + get_brief (redesign P1).
//
// One source of truth — both:
//   1. The `tools/list` response (advertised JSON Schema for each tool)
//   2. The runtime arg validation inside each tool handler
// reference the same zod schema. Tool handlers in src/mcp/tools/*.ts
// import the per-tool zod schema, call `.parse(args)`, and proceed
// with the validated object.
//
// The SDK doesn't auto-generate JSON Schema from zod — we declare the
// JSON Schema inline alongside the zod schema. Keeping them paired in
// this one file makes drift loud rather than silent.

import { z } from 'zod';

import { isValidIsoDate } from '../lib/iso-date.js';

// ---------------------------------------------------------------------------
// zod schemas — runtime validation in tool handlers
// ---------------------------------------------------------------------------

export const ListCandidatesArgs = z.object({
  domain: z
    .enum(['economy', 'economics', 'scitech', 'geopolitics', 'national'])
    .optional(),
  temperature: z
    .enum(['cold', 'warm', 'hot', 'over_saturated'])
    .optional(),
  trajectory: z
    .enum(['new', 'rising', 'peaking', 'declining'])
    .optional(),
  status: z
    .enum(['new', 'picked', 'passed', 'deferred', 'expired'])
    .default('new'),
  limit: z.number().int().positive().max(100).default(30),
});

export const GetCandidateArgs = z.object({
  id: z.string().uuid(),
});

export const SearchCandidatesArgs = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(50).default(20),
});

export const TrendingKeywordsArgs = z.object({
  domain: z
    .enum(['economy', 'economics', 'scitech', 'geopolitics', 'national'])
    .optional(),
  limit: z.number().int().positive().max(50).default(15),
  min_clusters: z.number().int().positive().max(20).default(2),
});

export const DecisionArgs = z.object({
  id: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export const DeferArgs = z.object({
  id: z.string().uuid(),
});

export const ExpandCompetitorArgs = z.object({
  channel_url: z.string().url(),
  priority_tier: z.union([z.literal(1), z.literal(2)]).default(2),
});

export const AddInfluencerArgs = z.object({
  handle_or_url: z.string().min(1).max(500),
  domain: z
    .enum(['economy', 'economics', 'scitech', 'geopolitics', 'national'])
    .optional(),
});

export const CompareAgainstArchiveArgs = z.object({
  candidate_id: z.string().uuid(),
});

export const RunNowArgs = z.object({}).default({});

export const SystemStatusArgs = z.object({}).default({});

export const GetBriefArgs = z.object({
  /** YYYY-MM-DD of the brief's week; omit for the latest brief.
   *  isValidIsoDate (not just the shape regex) gates the handler's
   *  ::date cast — '2026-13-99' would otherwise raise a PG
   *  out-of-range error (same class as the /brief route fix, codex
   *  review on #157). */
  week_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidIsoDate, { message: 'not a real calendar date' })
    .optional(),
});

// ---------------------------------------------------------------------------
// Tool definitions — fed to the SDK's tools/list response
// ---------------------------------------------------------------------------

/**
 * JSON Schema (draft 2020-12) form of the tool inputs, plus
 * description text shown in `tools/list`. Kept hand-written rather
 * than auto-generated from zod so reviewers can see the exact wire
 * shape MCP clients will discover.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'list_candidates',
    description:
      'List candidates filtered by optional domain/temperature/trajectory and status (default new). Returns the Candidate[] shape per SPEC §11.4.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['economy', 'economics', 'scitech', 'geopolitics', 'national'],
        },
        temperature: {
          type: 'string',
          enum: ['cold', 'warm', 'hot', 'over_saturated'],
        },
        trajectory: {
          type: 'string',
          enum: ['new', 'rising', 'peaking', 'declining'],
        },
        status: {
          type: 'string',
          enum: ['new', 'picked', 'passed', 'deferred', 'expired'],
          default: 'new',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_candidate',
    description: 'Full CandidateDetail for one candidate id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'pick',
    description:
      'Mark a candidate as picked. Writes feedback + records the decision to 2nd-brain via record_pick.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        reason: { type: 'string', maxLength: 500 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'pass',
    description: 'Mark a candidate as passed. Writes feedback + record_pick.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        reason: { type: 'string', maxLength: 500 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'defer',
    description: 'Defer a candidate to the next run.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_candidates',
    description:
      'Semantic search across active (status=new, non-expired) candidates. Embeds the query and ranks by cosine similarity to candidate context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'trending_keywords',
    description:
      'Ranked board of trending themes + keywords across the in-window candidate pool, by heat-weighted distinct-cluster count (hot/rising weighted over warm/declining; deduped by cluster). `themes` are curated editorial tags (the de-noised primary axis); `keywords` are secondary detail. NOTE: editorial descriptors for topic timeliness — NOT platform search-volume / SEO terms.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['economy', 'economics', 'scitech', 'geopolitics', 'national'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
        min_clusters: { type: 'integer', minimum: 1, maximum: 20, default: 2 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'expand_competitor_list',
    description:
      'Add a single competitor channel (YouTube only in v1) to the watch list. Returns the new competitor id.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_url: { type: 'string', format: 'uri' },
        priority_tier: { type: 'integer', enum: [1, 2], default: 2 },
      },
      required: ['channel_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_influencer',
    description:
      'Add an independent commentator source by Substack/RSS handle or URL. Defaults: kind=rss, authority=60, fetch_interval_min=60.',
    inputSchema: {
      type: 'object',
      properties: {
        handle_or_url: { type: 'string', minLength: 1, maxLength: 500 },
        domain: {
          type: 'string',
          enum: ['economy', 'economics', 'scitech', 'geopolitics', 'national'],
        },
      },
      required: ['handle_or_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_against_archive',
    description:
      'Re-compute archive_overlap for a candidate against 2nd-brain — useful if the candidate was scored before a new essay landed.',
    inputSchema: {
      type: 'object',
      properties: { candidate_id: { type: 'string', format: 'uuid' } },
      required: ['candidate_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_now',
    description:
      'Trigger an ad-hoc scoring run (kind=manual). Returns the run_id immediately; the run executes asynchronously in the background.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'system_status',
    description:
      'Snapshot: last_run summary + today cost in USD + pending raw_items + active candidate pool size.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_brief',
    description:
      "Fetch a Weekly Ideation Brief (redesign P1): 3-5 episode pitches (hook / thesis / steelman / why-now / fit / evidence) generated from the week's candidate pool + decisions. Omit week_of for the latest brief.",
    inputSchema: {
      type: 'object',
      properties: {
        week_of: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'YYYY-MM-DD of the brief week (Sunday). Omit for latest.',
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];
