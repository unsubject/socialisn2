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
//   clusterThreshold        — cosine-similarity floor for SPEC §7.4 cluster
//                             matching (an item only joins an existing
//                             cluster when similarity to the centroid is
//                             at or above this).
//
// Values mirror the table in SPEC §8 verbatim. Edits here are real
// editorial choices — audit against the SPEC table before changing.

import type { Domain } from '../src/scoring/normalize.js';

export interface DomainConfig {
  domain: Domain;
  recencyHalfLifeHours: number;
  defaultAuthorityWeight: number;
  clusterThreshold: number;
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
    clusterThreshold: 0.70,
  },
  economics: {
    domain: 'economics',
    recencyHalfLifeHours: 14 * 24, // 14 days — working papers stay relevant
    defaultAuthorityWeight: 1.2,   // academic-source boost per SPEC §8
    clusterThreshold: 0.72,
  },
  scitech: {
    domain: 'scitech',
    recencyHalfLifeHours: 7 * 24,
    defaultAuthorityWeight: 1.0,
    clusterThreshold: 0.70,
  },
  geopolitics: {
    domain: 'geopolitics',
    recencyHalfLifeHours: 5 * 24,
    defaultAuthorityWeight: 1.1,
    clusterThreshold: 0.68,
  },
  national: {
    domain: 'national',
    recencyHalfLifeHours: 3 * 24,
    defaultAuthorityWeight: 1.0,
    clusterThreshold: 0.70,
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

/** Per-domain cluster-join cosine threshold per SPEC §7.4. */
export function clusterThreshold(domain: Domain): number {
  return DOMAIN_CONFIGS[domain].clusterThreshold;
}
