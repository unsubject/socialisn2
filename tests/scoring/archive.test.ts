// Unit tests for src/scoring/archive.ts. The MCP integration surface is
// already covered in tests/lib/two_brain_client.test.ts; here we
// exercise the pure summarisation + decision logic and the injected
// searcher path (no live MCP, no fetch stubs).

import { describe, expect, it } from 'vitest';

import {
  archiveOverlapDecision,
  computeArchiveOverlap,
  DROP_THRESHOLD,
  FLAG_THRESHOLD,
  summariseMatches,
  type ArchiveOverlapResult,
} from '../../src/scoring/archive.js';
import { EMBEDDING_DIM } from '../../src/db/schema.js';
import type { ArchiveMatch } from '../../src/lib/two_brain_client.js';

function mkMatch(overrides: Partial<ArchiveMatch>): ArchiveMatch {
  return {
    id: 'e1',
    title: 'A prior essay',
    url: 'https://example.com/e1',
    published_at: '2026-04-01T00:00:00Z',
    similarity: 0.5,
    type: 'essay',
    ...overrides,
  };
}

function unitEmbedding(): number[] {
  return new Array(EMBEDDING_DIM).fill(0.1);
}

describe('summariseMatches', () => {
  it('returns overlap=0 and empty links when matches is empty', () => {
    expect(summariseMatches([])).toEqual({ overlap: 0, links: [] });
  });

  it('returns the max similarity as overlap', () => {
    const result = summariseMatches([
      mkMatch({ id: 'a', similarity: 0.3 }),
      mkMatch({ id: 'b', similarity: 0.92 }),
      mkMatch({ id: 'c', similarity: 0.6 }),
    ]);
    expect(result.overlap).toBe(0.92);
  });

  it('returns top-3 links sorted desc by similarity', () => {
    const result = summariseMatches([
      mkMatch({ id: 'low', similarity: 0.1 }),
      mkMatch({ id: 'med', similarity: 0.6 }),
      mkMatch({ id: 'high', similarity: 0.95 }),
      mkMatch({ id: 'mid', similarity: 0.5 }),
      mkMatch({ id: 'mid2', similarity: 0.55 }),
    ]);
    expect(result.links.map((l) => l.id)).toEqual(['high', 'med', 'mid2']);
    // Verify the link shape carries the SPEC-mandated fields.
    expect(result.links[0]).toMatchObject({
      id: 'high',
      title: expect.any(String),
      url: expect.any(String),
      published_at: expect.any(String),
      similarity: 0.95,
      type: 'essay',
    });
  });

  it('preserves a single match in the links array', () => {
    const result = summariseMatches([mkMatch({ id: 'only', similarity: 0.7 })]);
    expect(result.overlap).toBe(0.7);
    expect(result.links).toHaveLength(1);
  });

  it("coerces a null match url to '' (essays without a public URL)", () => {
    // ArchiveMatch.url is nullable on the wire; ArchiveOverlapLink.url must
    // stay a string so a null never reaches Telegram digest formatting.
    const result = summariseMatches([
      mkMatch({ id: 'noUrl', similarity: 0.8, url: null }),
    ]);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.url).toBe('');
    // The coercion must not affect the rest of the link.
    expect(result.links[0]).toMatchObject({ id: 'noUrl', similarity: 0.8 });
  });
});

describe('archiveOverlapDecision', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('does NOT drop and does NOT flag when there are no matches', () => {
    const r: ArchiveOverlapResult = { overlap: 0, links: [] };
    expect(archiveOverlapDecision(r, now)).toEqual({
      drop: false,
      flagRelatedToRecentWork: false,
    });
  });

  it('drops when overlap > 0.85 AND match is within 90 days', () => {
    const recentIso = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const r: ArchiveOverlapResult = {
      overlap: 0.9,
      links: [{ ...mkMatch({ similarity: 0.9, published_at: recentIso }) }],
    };
    const d = archiveOverlapDecision(r, now);
    expect(d.drop).toBe(true);
    expect(d.flagRelatedToRecentWork).toBe(false);
  });

  it('does NOT drop when overlap > 0.85 but match is OLDER than 90 days', () => {
    const staleIso = new Date(now.getTime() - 120 * 86_400_000).toISOString();
    const r: ArchiveOverlapResult = {
      overlap: 0.9,
      links: [{ ...mkMatch({ similarity: 0.9, published_at: staleIso }) }],
    };
    const d = archiveOverlapDecision(r, now);
    expect(d.drop).toBe(false);
    // SPEC §9.3 only flags inside (0.70, 0.85], so overlap=0.9 with old
    // match falls through both gates (not dropped, not flagged).
    expect(d.flagRelatedToRecentWork).toBe(false);
  });

  it('flags (not drop) when overlap is in (0.70, 0.85]', () => {
    const recentIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const r: ArchiveOverlapResult = {
      overlap: 0.8,
      links: [{ ...mkMatch({ similarity: 0.8, published_at: recentIso }) }],
    };
    const d = archiveOverlapDecision(r, now);
    expect(d.drop).toBe(false);
    expect(d.flagRelatedToRecentWork).toBe(true);
  });

  it('flags at the exact upper bound (overlap === 0.85)', () => {
    const recentIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const r: ArchiveOverlapResult = {
      overlap: DROP_THRESHOLD, // 0.85 exactly
      links: [
        { ...mkMatch({ similarity: DROP_THRESHOLD, published_at: recentIso }) },
      ],
    };
    const d = archiveOverlapDecision(r, now);
    expect(d.drop).toBe(false);
    expect(d.flagRelatedToRecentWork).toBe(true);
  });

  it('does NOT flag at the exact lower bound (overlap === 0.70)', () => {
    // SPEC says "0.70 < overlap ≤ 0.85" — strict greater-than on the
    // lower bound, so exactly 0.70 should NOT flag.
    const recentIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const r: ArchiveOverlapResult = {
      overlap: FLAG_THRESHOLD,
      links: [
        { ...mkMatch({ similarity: FLAG_THRESHOLD, published_at: recentIso }) },
      ],
    };
    const d = archiveOverlapDecision(r, now);
    expect(d.drop).toBe(false);
    expect(d.flagRelatedToRecentWork).toBe(false);
  });

  it('does NOT flag when overlap is below 0.70', () => {
    const recentIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const r: ArchiveOverlapResult = {
      overlap: 0.5,
      links: [{ ...mkMatch({ similarity: 0.5, published_at: recentIso }) }],
    };
    const d = archiveOverlapDecision(r, now);
    expect(d.drop).toBe(false);
    expect(d.flagRelatedToRecentWork).toBe(false);
  });
});

describe('computeArchiveOverlap', () => {
  it('throws on wrong-sized centroid', async () => {
    await expect(
      computeArchiveOverlap([1, 2, 3], {
        searcher: async () => [],
      }),
    ).rejects.toThrow(/1536-dim/);
  });

  it('uses the injected searcher and returns {overlap, links}', async () => {
    const matches: ArchiveMatch[] = [
      mkMatch({ id: 'e1', similarity: 0.91 }),
      mkMatch({ id: 'e2', similarity: 0.60 }),
    ];
    const result = await computeArchiveOverlap(unitEmbedding(), {
      searcher: async () => matches,
    });
    expect(result.overlap).toBe(0.91);
    expect(result.links).toHaveLength(2);
  });

  it('returns overlap=0 when the searcher degrades to [] (SPEC §10.2 fallback)', async () => {
    const result = await computeArchiveOverlap(unitEmbedding(), {
      searcher: async () => [],
    });
    expect(result).toEqual({ overlap: 0, links: [] });
  });

  it('passes top_k through to the searcher (default 5)', async () => {
    let capturedTopK = -1;
    await computeArchiveOverlap(unitEmbedding(), {
      searcher: async (_v, topK) => {
        capturedTopK = topK;
        return [];
      },
    });
    expect(capturedTopK).toBe(5);
  });

  it('passes a caller-supplied top_k override through', async () => {
    let capturedTopK = -1;
    await computeArchiveOverlap(unitEmbedding(), {
      topK: 10,
      searcher: async (_v, topK) => {
        capturedTopK = topK;
        return [];
      },
    });
    expect(capturedTopK).toBe(10);
  });
});
