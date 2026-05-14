// Unit tests for the pricing table + computeCostUsd. Pure math — no DB.

import { describe, expect, it } from 'vitest';

import { PRICING, computeCostUsd, pricingFor } from '../../src/cost/pricing.js';

describe('pricingFor', () => {
  it('returns entry for known model', () => {
    const p = pricingFor('text-embedding-3-small');
    expect(p.inputUsdPerToken).toBeGreaterThan(0);
    expect(p.outputUsdPerToken).toBe(0);
  });

  it('throws on unknown model', () => {
    expect(() => pricingFor('not-a-real-model')).toThrow(/No pricing entry/);
  });
});

describe('computeCostUsd', () => {
  it('text-embedding-3-small: 1M input tokens = $0.02', () => {
    expect(computeCostUsd('text-embedding-3-small', 1_000_000, 0)).toBeCloseTo(0.02, 9);
  });

  it('claude-sonnet-4.5: 1k in + 500 out ≈ $0.0105', () => {
    const usd = computeCostUsd('claude-sonnet-4.5', 1000, 500);
    // 1000 * 3/1M  + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
    expect(usd).toBeCloseTo(0.0105, 9);
  });

  it('gemini-2.5-flash-lite: 10k in + 1k out = $0.0014', () => {
    const usd = computeCostUsd('gemini-2.5-flash-lite', 10_000, 1000);
    expect(usd).toBeCloseTo(0.0014, 9);
  });

  it('zero tokens = zero cost', () => {
    expect(computeCostUsd('claude-sonnet-4.5', 0, 0)).toBe(0);
  });
});

describe('PRICING table integrity', () => {
  it('every entry has finite non-negative rates', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      expect(Number.isFinite(p.inputUsdPerToken), `${model} input`).toBe(true);
      expect(p.inputUsdPerToken, `${model} input`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.outputUsdPerToken), `${model} output`).toBe(true);
      expect(p.outputUsdPerToken, `${model} output`).toBeGreaterThanOrEqual(0);
    }
  });
});
