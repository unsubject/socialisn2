// Stage 5 of the scoring pipeline (SPEC §9.3) — archive overlap.
//
// For each Stage 4 cluster, query 2nd-brain's archive_search via MCP and
// compute the cluster's overlap with prior essays + YouTube episodes:
//
//   archive_overlap       = max cosine similarity across top-K matches
//   archive_overlap_links = top 3 matches (id, title, url, published_at,
//                                          similarity, type)
//
// SPEC §9.3 decision thresholds are exposed as pure helpers so the
// Phase 3 PR 4 orchestrator can apply them without re-encoding the spec:
//
//   overlap > 0.85 AND match within 90 days  → drop cluster
//   0.70 < overlap ≤ 0.85                    → keep, flag related_to_recent_work
//
// Graceful by construction: when archiveSearch degrades to [] (network
// failure, missing tool on server, missing env), overlap is 0 and the
// cluster proceeds without flags — SPEC §10.2 "better possibly-redundant
// than dropped".

import {
  archiveSearch as defaultArchiveSearch,
  type ArchiveMatch,
  type TwoBrainCallOptions,
} from '../lib/two_brain_client.js';
import { EMBEDDING_DIM } from '../db/schema.js';

const DEFAULT_TOP_K = 5;
const LINKS_KEPT = 3;
/** SPEC §9.3: drop a cluster whose overlap exceeds this AND match is recent. */
export const DROP_THRESHOLD = 0.85;
/** SPEC §9.3: flag (don't drop) when overlap is in (FLAG_THRESHOLD, DROP_THRESHOLD]. */
export const FLAG_THRESHOLD = 0.70;
/** SPEC §9.3: "recent" window for the drop rule. */
export const RECENT_WINDOW_DAYS = 90;

export interface ArchiveOverlapLink {
  id: string;
  title: string;
  url: string;
  published_at: string;
  similarity: number;
  type: 'essay' | 'episode';
}

export interface ArchiveOverlapResult {
  /** Max similarity across all matches; 0 when no matches. */
  overlap: number;
  /** Top LINKS_KEPT matches, sorted desc by similarity. */
  links: ArchiveOverlapLink[];
}

export interface ArchiveOverlapDecision {
  /** Cluster is dropped from the candidate pool (SPEC §9.3 > 0.85 + recent). */
  drop: boolean;
  /** Cluster proceeds with metadata flag (SPEC §9.3 0.70 < overlap ≤ 0.85). */
  flagRelatedToRecentWork: boolean;
}

export interface ComputeArchiveOverlapOptions extends TwoBrainCallOptions {
  /** Defaults to 5 per SPEC §9.3 `archive_search(embedding, top_k=5)`. */
  topK?: number;
  /**
   * Inject an alternative search function — primarily for tests so we
   * don't have to stub fetch + env via the two_brain_client integration
   * surface. Defaults to the real archiveSearch.
   */
  searcher?: typeof defaultArchiveSearch;
}

/**
 * Compute archive overlap for a cluster centroid. Always returns a result
 * — never throws on MCP failure; the underlying client degrades to []. A
 * wrong-sized centroid is a programmer error and surfaces loudly so it's
 * not buried under a permanent overlap=0.
 */
export async function computeArchiveOverlap(
  centroid: number[],
  opts: ComputeArchiveOverlapOptions = {},
): Promise<ArchiveOverlapResult> {
  if (centroid.length !== EMBEDDING_DIM) {
    throw new Error(
      `computeArchiveOverlap: centroid must be ${EMBEDDING_DIM}-dim (got ${centroid.length})`,
    );
  }
  const search = opts.searcher ?? defaultArchiveSearch;
  const matches = await search(centroid, opts.topK ?? DEFAULT_TOP_K, opts);
  return summariseMatches(matches);
}

/**
 * Pure transformation of raw matches → overlap + top-3 links. Exported
 * for unit testing without a live MCP and for use by callers that
 * already hold the matches array (e.g. a smoke fixture).
 */
export function summariseMatches(matches: ArchiveMatch[]): ArchiveOverlapResult {
  if (matches.length === 0) {
    return { overlap: 0, links: [] };
  }
  const sorted = [...matches].sort((a, b) => b.similarity - a.similarity);
  const overlap = sorted[0]?.similarity ?? 0;
  const links = sorted.slice(0, LINKS_KEPT).map((m) => ({
    id: m.id,
    title: m.title,
    url: m.url,
    published_at: m.published_at,
    similarity: m.similarity,
    type: m.type,
  }));
  return { overlap, links };
}

/**
 * Apply SPEC §9.3 thresholds. Pure function; the orchestrator calls
 * this with the cluster's archive overlap and uses `drop` to filter
 * the Stage 5 set, then persists `flagRelatedToRecentWork` into the
 * candidate's metadata.
 *
 * The recency check uses the TOP match (highest similarity). SPEC reads
 * the drop rule as "this overlap is high AND the closest prior is
 * recent" — not "any of the top 3" — so this matches.
 */
export function archiveOverlapDecision(
  result: ArchiveOverlapResult,
  now: Date = new Date(),
): ArchiveOverlapDecision {
  const topMatch = result.links[0];
  if (!topMatch) {
    return { drop: false, flagRelatedToRecentWork: false };
  }
  const isRecent = isWithinDays(topMatch.published_at, now, RECENT_WINDOW_DAYS);
  const drop = result.overlap > DROP_THRESHOLD && isRecent;
  // Flag only inside the explicit SPEC band. A cluster with overlap > 0.85
  // but an OLD match falls through both gates (not dropped, not flagged)
  // — a literal reading of SPEC §9.3, which we preserve here.
  const flagRelatedToRecentWork =
    !drop && result.overlap > FLAG_THRESHOLD && result.overlap <= DROP_THRESHOLD;
  return { drop, flagRelatedToRecentWork };
}

function isWithinDays(iso: string, now: Date, days: number): boolean {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  const ageMs = now.getTime() - parsed.getTime();
  return ageMs <= days * 86_400_000;
}
