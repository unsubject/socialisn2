// Cross-domain collision detection (redesign P2,
// docs/redesign/2026-07-05-ideation-redesign.md §5.3).
//
// The operator's stated edge is bisociation — structural analogies
// across domains. P1's brief prompt merely INVITES collisions from
// whatever the model notices in its own context; P2 computes the
// candidates mechanically: pair the week's cluster centroids across
// different primary domains and keep pairs whose cosine similarity
// falls in the "rhyme band" — close enough to rhyme, far enough apart
// to be non-obvious. The brief model then judges each pair (is there a
// genuinely shared mechanism?) inside the same weekly call — no extra
// LLM spend.
//
// Band values are v1 guesses, deliberately named constants: the run
// logs the matched distribution so two weeks of real Sundays can tune
// them (same stance as the trending weights in PR #130). Above the
// band is near-duplication (the same story reported in two domains);
// below it is unrelatedness.

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

/** Rhyme band, inclusive, in cosine SIMILARITY (1 - pgvector <=> ). */
export const COLLISION_BAND_MIN_SIM = 0.45;
export const COLLISION_BAND_MAX_SIM = 0.8;
/** Cap on pairs fed to the brief prompt — the model judges these, and
 *  20 pairs ≈ 1k prompt tokens. */
export const COLLISION_MAX_PAIRS = 20;

export interface CollisionPair {
  aCandidateId: string;
  aHeadline: string;
  aDomain: string;
  bCandidateId: string;
  bHeadline: string;
  bDomain: string;
  /** Cosine similarity of the two cluster centroids. */
  similarity: number;
}

type PairRow = {
  a_id: string;
  a_headline: string;
  a_domain: string;
  b_id: string;
  b_headline: string;
  b_domain: string;
  similarity: number;
};

export interface CollisionOpts {
  minSim?: number;
  maxSim?: number;
  maxPairs?: number;
  windowDays?: number;
}

/**
 * Find cross-domain rhyme-band pairs among the week ending at `weekOf`
 * (same (weekOf-6d, weekOf+1d) window as gatherBriefInput). One
 * candidate per cluster (best curation score) so a story that carries
 * several rows across statuses can't pair with itself.
 *
 * Cost shape: a typical week holds well under a few hundred distinct
 * clusters → tens of thousands of centroid distance ops at most, done
 * inside PG next to the data. No index needed at this cardinality.
 */
export async function findCollisionPairs(
  db: Db,
  weekOf: string,
  opts: CollisionOpts = {},
): Promise<CollisionPair[]> {
  const minSim = opts.minSim ?? COLLISION_BAND_MIN_SIM;
  const maxSim = opts.maxSim ?? COLLISION_BAND_MAX_SIM;
  const maxPairs = opts.maxPairs ?? COLLISION_MAX_PAIRS;
  const windowDays = opts.windowDays ?? 7;

  const windowEnd = sql`(${weekOf}::date + 1)`;
  const windowStart = sql`(${weekOf}::date - ${windowDays - 1}::int)`;

  const rows = await db.execute<PairRow>(sql`
    WITH week_candidates AS (
      SELECT DISTINCT ON (c.cluster_id)
             c.id, c.headline, c.primary_domain, c.cluster_id
      FROM candidates c
      WHERE ((c.created_at >= ${windowStart} AND c.created_at < ${windowEnd})
             OR (c.updated_at >= ${windowStart} AND c.updated_at < ${windowEnd}))
      ORDER BY c.cluster_id, c.curation_score DESC, c.created_at DESC
    )
    SELECT a.id       AS a_id,
           a.headline AS a_headline,
           a.primary_domain AS a_domain,
           b.id       AS b_id,
           b.headline AS b_headline,
           b.primary_domain AS b_domain,
           (1 - (ca.centroid <=> cb.centroid))::float AS similarity
    FROM week_candidates a
    JOIN week_candidates b
      ON a.cluster_id < b.cluster_id
     AND a.primary_domain <> b.primary_domain
    JOIN clusters ca ON ca.id = a.cluster_id
    JOIN clusters cb ON cb.id = b.cluster_id
    WHERE (1 - (ca.centroid <=> cb.centroid)) BETWEEN ${minSim} AND ${maxSim}
    ORDER BY similarity DESC
    LIMIT ${maxPairs}
  `);

  return rows.map((r) => ({
    aCandidateId: r.a_id,
    aHeadline: r.a_headline,
    aDomain: r.a_domain,
    bCandidateId: r.b_id,
    bHeadline: r.b_headline,
    bDomain: r.b_domain,
    similarity: r.similarity,
  }));
}
