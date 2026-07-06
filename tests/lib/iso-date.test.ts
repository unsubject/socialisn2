// Unit tests for src/lib/iso-date.ts (codex review on PR #157): the
// helper gates PG ::date casts on /brief/:weekOf, get_brief, and
// runWeeklyBrief — shape-valid-but-impossible dates must be rejected
// here, not by a PG out-of-range error.

import { describe, expect, it } from 'vitest';

import { isValidIsoDate } from '../../src/lib/iso-date.js';

describe('isValidIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isValidIsoDate('2026-07-05')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true); // leap day
    expect(isValidIsoDate('1999-12-31')).toBe(true);
  });

  it('rejects shaped-but-impossible dates', () => {
    expect(isValidIsoDate('2026-13-99')).toBe(false);
    expect(isValidIsoDate('2026-00-10')).toBe(false);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2025-02-29')).toBe(false); // not a leap year
  });

  it('rejects wrong shapes outright', () => {
    expect(isValidIsoDate('next sunday')).toBe(false);
    expect(isValidIsoDate('2026-7-5')).toBe(false);
    expect(isValidIsoDate('2026-07-05T00:00:00Z')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});
