// Per-domain configuration per SPEC §8.
//
// Each domain carries:
//   recencyHalfLifeHours    — feeds the exp(-ln(2) * age / half_life)
//                             decay function used by candidates.expires_at
//                             computation (Phase 3 PR 4) and the RSS
//                             relevance ordering (Phase 4 PR 1).
//   defaultAuthorityWeight  — multiplier on source.authority_score when
//                             populating items.authority_weighted, AND the
//                             value handed to heuristic.ts as
//                             HeuristicSignals.domainWeight.
//   clusterSimilarityFloor  — cosine-SIMILARITY floor for SPEC §7.4
//                             cluster matching (an item only joins an
//                             existing cluster when similarity to the
//                             centroid is at or above this).
//
// **Unit warning.** SPEC §8 speaks in cosine SIMILARITY (0.70-0.72 etc).
// pgvector and src/scoring/cluster.ts speak in cosine DISTANCE
// (= 1 - similarity), and assignCluster joins when distance < threshold.
// Passing a similarity value where a distance is expected (or vice versa)
// inverts the join boundary and either over-merges or rejects everything.
// The helpers below are named for the unit they return: use
// `clusterSimilarityThreshold(d)` when you need the SPEC value and
// `clusterJoinDistance(d)` when you're wiring into cluster.ts.
//
// Values mirror the table in SPEC §8 verbatim. Edits here are real
// editorial choices — audit against the SPEC table before changing.

import type { Domain } from '../src/scoring/normalize.js';

export interface DomainConfig {
  domain: Domain;
  recencyHalfLifeHours: number;
  defaultAuthorityWeight: number;
  /** Cosine SIMILARITY floor for cluster join — SPEC §8 unit. */
  clusterSimilarityFloor: number;
}

/**
 * Canonical per-domain table. Keyed by Domain for compile-time
 * exhaustiveness — adding a domain to normalize.ts's VALID_DOMAINS
 * union will surface a missing key here as a typecheck failure.
 */
export const DOMAIN_CONFIGS: Record<Domain, DomainConfig> = {
  economy: {
    domain: 'economy',
    recencyHalfLifeHours: 48,
    defaultAuthorityWeight: 1.0,
    clusterSimilarityFloor: 0.70,
  },
  economics: {
    domain: 'economics',
    recencyHalfLifeHours: 14 * 24, // 14 days — working papers stay relevant
    defaultAuthorityWeight: 1.2,   // academic-source boost per SPEC §8
    clusterSimilarityFloor: 0.72,
  },
  scitech: {
    domain: 'scitech',
    recencyHalfLifeHours: 7 * 24,
    defaultAuthorityWeight: 1.0,
    clusterSimilarityFloor: 0.70,
  },
  geopolitics: {
    domain: 'geopolitics',
    recencyHalfLifeHours: 5 * 24,
    defaultAuthorityWeight: 1.1,
    clusterSimilarityFloor: 0.68,
  },
  national: {
    domain: 'national',
    recencyHalfLifeHours: 3 * 24,
    defaultAuthorityWeight: 1.0,
    clusterSimilarityFloor: 0.70,
  },
};

/**
 * Exponential decay: exp(-ln(2) * age / half_life). Returns 1 at age=0,
 * 0.5 at age=half_life, 0.25 at age=2*half_life, asymptotically toward 0.
 * Negative ages clamp to 1 (a "future" published_at is treated as fresh).
 */
export function recencyDecay(ageHours: number, halfLifeHours: number): number {
  if (ageHours <= 0) return 1;
  if (halfLifeHours <= 0) {
    throw new Error(`recencyDecay: halfLifeHours must be positive (got ${halfLifeHours})`);
  }
  return Math.exp((-Math.LN2 * ageHours) / halfLifeHours);
}

/** Per-domain decay convenience wrapper. */
export function decayForDomain(domain: Domain, ageHours: number): number {
  return recencyDecay(ageHours, DOMAIN_CONFIGS[domain].recencyHalfLifeHours);
}

/** Per-domain authority weight — fed to heuristic.ts as domainWeight. */
export function domainWeight(domain: Domain): number {
  return DOMAIN_CONFIGS[domain].defaultAuthorityWeight;
}

/**
 * Per-domain cosine SIMILARITY floor for cluster join per SPEC §8. Use
 * this when you need the SPEC value as a similarity (e.g. for logging /
 * reporting). If you're wiring into src/scoring/cluster.ts's threshold
 * option, use `clusterJoinDistance` instead — cluster.ts expects a
 * distance, and passing a similarity here would invert the join
 * boundary and over-merge.
 */
export function clusterSimilarityThreshold(domain: Domain): number {
  return DOMAIN_CONFIGS[domain].clusterSimilarityFloor;
}

/**
 * Per-domain cosine DISTANCE threshold for cluster join. This is
 * `1 - clusterSimilarityThreshold(domain)` and is the value to pass
 * into `assignCluster(..., { threshold })`, which joins when
 * `distance < threshold`. Wired this way the SPEC §8 similarity floors
 * map straight to the join behaviour described there (an item with
 * similarity ≥ floor joins; below floor does not).
 *
 * Example: economy similarity 0.70 → distance 0.30. assignCluster's
 * existing default is 0.30, matching economy verbatim.
 */
export function clusterJoinDistance(domain: Domain): number {
  return 1 - DOMAIN_CONFIGS[domain].clusterSimilarityFloor;
}
