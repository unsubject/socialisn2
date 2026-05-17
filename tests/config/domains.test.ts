// Sanity tests for config/domains.ts. The file is mostly data; these
// guard against regressions on the SPEC §8 table and the decay math.

import { describe, expect, it } from 'vitest';

import {
  DOMAIN_CONFIGS,
  clusterThreshold,
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

  it('matches the SPEC §8 table verbatim', () => {
    expect(DOMAIN_CONFIGS.economy).toMatchObject({
      recencyHalfLifeHours: 48,
      defaultAuthorityWeight: 1.0,
      clusterThreshold: 0.70,
    });
    expect(DOMAIN_CONFIGS.economics).toMatchObject({
      recencyHalfLifeHours: 14 * 24,
      defaultAuthorityWeight: 1.2,
      clusterThreshold: 0.72,
    });
    expect(DOMAIN_CONFIGS.scitech).toMatchObject({
      recencyHalfLifeHours: 7 * 24,
      defaultAuthorityWeight: 1.0,
      clusterThreshold: 0.70,
    });
    expect(DOMAIN_CONFIGS.geopolitics).toMatchObject({
      recencyHalfLifeHours: 5 * 24,
      defaultAuthorityWeight: 1.1,
      clusterThreshold: 0.68,
    });
    expect(DOMAIN_CONFIGS.national).toMatchObject({
      recencyHalfLifeHours: 3 * 24,
      defaultAuthorityWeight: 1.0,
      clusterThreshold: 0.70,
    });
  });

  it('every recency half-life is positive', () => {
    for (const cfg of Object.values(DOMAIN_CONFIGS)) {
      expect(cfg.recencyHalfLifeHours).toBeGreaterThan(0);
    }
  });

  it('every cluster threshold is in (0, 1)', () => {
    for (const cfg of Object.values(DOMAIN_CONFIGS)) {
      expect(cfg.clusterThreshold).toBeGreaterThan(0);
      expect(cfg.clusterThreshold).toBeLessThan(1);
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

describe('decayForDomain / domainWeight / clusterThreshold accessors', () => {
  it('decayForDomain plumbs through to recencyDecay with the right half-life', () => {
    expect(decayForDomain('economy', 48)).toBeCloseTo(0.5, 9);
    expect(decayForDomain('economics', 14 * 24)).toBeCloseTo(0.5, 9);
  });
  it('domainWeight returns the configured authority weight', () => {
    expect(domainWeight('economics')).toBe(1.2);
    expect(domainWeight('geopolitics')).toBe(1.1);
    expect(domainWeight('economy')).toBe(1.0);
  });
  it('clusterThreshold returns the per-domain cosine floor', () => {
    expect(clusterThreshold('economy')).toBe(0.70);
    expect(clusterThreshold('geopolitics')).toBe(0.68);
  });
});
