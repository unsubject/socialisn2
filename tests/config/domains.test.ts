// Sanity tests for config/domains.ts. The file is mostly data; these
// guard against regressions on the SPEC §8 table and the decay math.

import { describe, expect, it } from 'vitest';

import {
  DOMAIN_CONFIGS,
  clusterJoinDistance,
  clusterSimilarityThreshold,
  decayForDomain,
  domainWeight,
  recencyDecay,
} from '../../config/domains.js';
import { VALID_DOMAINS } from '../../src/scoring/normalize.js';

describe('DOMAIN_CONFIGS', () => {
  it('covers every Domain in VALID_DOMAINS exactly once', () => {
    const configKeys = Object.keys(DOMAIN_CONFIGS).sort();
    const validKeys = [...VALID_DOMAINS].sort();
    expect(configKeys).toEqual(validKeys);
  });

  it('matches the SPEC §8 table verbatim (similarity floors, not distances)', () => {
    expect(DOMAIN_CONFIGS.economy).toMatchObject({
      recencyHalfLifeHours: 48,
      defaultAuthorityWeight: 1.0,
      clusterSimilarityFloor: 0.70,
    });
    expect(DOMAIN_CONFIGS.economics).toMatchObject({
      recencyHalfLifeHours: 14 * 24,
      defaultAuthorityWeight: 1.2,
      clusterSimilarityFloor: 0.72,
    });
    expect(DOMAIN_CONFIGS.scitech).toMatchObject({
      recencyHalfLifeHours: 7 * 24,
      defaultAuthorityWeight: 1.0,
      clusterSimilarityFloor: 0.70,
    });
    expect(DOMAIN_CONFIGS.geopolitics).toMatchObject({
      recencyHalfLifeHours: 5 * 24,
      defaultAuthorityWeight: 1.1,
      clusterSimilarityFloor: 0.68,
    });
    expect(DOMAIN_CONFIGS.national).toMatchObject({
      recencyHalfLifeHours: 3 * 24,
      defaultAuthorityWeight: 1.0,
      clusterSimilarityFloor: 0.70,
    });
  });

  it('every recency half-life is positive', () => {
    for (const cfg of Object.values(DOMAIN_CONFIGS)) {
      expect(cfg.recencyHalfLifeHours).toBeGreaterThan(0);
    }
  });

  it('every similarity floor is in (0, 1)', () => {
    for (const cfg of Object.values(DOMAIN_CONFIGS)) {
      expect(cfg.clusterSimilarityFloor).toBeGreaterThan(0);
      expect(cfg.clusterSimilarityFloor).toBeLessThan(1);
    }
  });
});

describe('recencyDecay', () => {
  it('returns 1 at age=0', () => {
    expect(recencyDecay(0, 48)).toBe(1);
  });
  it('returns 0.5 at age=half_life', () => {
    expect(recencyDecay(48, 48)).toBeCloseTo(0.5, 9);
  });
  it('returns 0.25 at age=2*half_life', () => {
    expect(recencyDecay(96, 48)).toBeCloseTo(0.25, 9);
  });
  it('returns 1 for negative ages ("future" published_at)', () => {
    expect(recencyDecay(-5, 48)).toBe(1);
  });
  it('throws when half_life is non-positive', () => {
    expect(() => recencyDecay(10, 0)).toThrow(/halfLifeHours/);
    expect(() => recencyDecay(10, -1)).toThrow(/halfLifeHours/);
  });
});

describe('decayForDomain / domainWeight accessors', () => {
  it('decayForDomain plumbs through to recencyDecay with the right half-life', () => {
    expect(decayForDomain('economy', 48)).toBeCloseTo(0.5, 9);
    expect(decayForDomain('economics', 14 * 24)).toBeCloseTo(0.5, 9);
  });
  it('domainWeight returns the configured authority weight', () => {
    expect(domainWeight('economics')).toBe(1.2);
    expect(domainWeight('geopolitics')).toBe(1.1);
    expect(domainWeight('economy')).toBe(1.0);
  });
});

describe('cluster threshold helpers (similarity vs distance)', () => {
  it('clusterSimilarityThreshold returns the SPEC §8 similarity verbatim', () => {
    expect(clusterSimilarityThreshold('economy')).toBe(0.70);
    expect(clusterSimilarityThreshold('economics')).toBe(0.72);
    expect(clusterSimilarityThreshold('geopolitics')).toBe(0.68);
  });

  it('clusterJoinDistance returns 1 - similarity for direct use as cluster.ts threshold', () => {
    expect(clusterJoinDistance('economy')).toBeCloseTo(0.30, 9);
    expect(clusterJoinDistance('economics')).toBeCloseTo(0.28, 9);
    expect(clusterJoinDistance('geopolitics')).toBeCloseTo(0.32, 9);
  });

  it('the two helpers always sum to 1 (units are consistent)', () => {
    for (const d of VALID_DOMAINS) {
      expect(clusterSimilarityThreshold(d) + clusterJoinDistance(d)).toBeCloseTo(1, 9);
    }
  });

  it('economy clusterJoinDistance matches the existing cluster.ts default of 0.30', () => {
    // Regression guard: if someone re-tunes economy's SPEC §8 value,
    // they need to be aware the historical cluster.ts default was
    // chosen to match this domain. Fails loudly so the audit is
    // visible at the PR diff level.
    expect(clusterJoinDistance('economy')).toBeCloseTo(0.30, 9);
  });
});
