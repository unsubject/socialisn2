// DB-free unit tests for the Daily Pulse selection core (redesign
// P0.3, docs/redesign/2026-07-05 §5.1). The DB write path + feed
// rendering are covered in tests/orchestrator/run.test.ts and
// tests/rss/generate.test.ts.

import { describe, expect, it } from 'vitest';

import {
  PULSE_TOP_N,
  pulseCandidateDescription,
  selectPulseCandidates,
  wavesDescription,
  type PulseCandidate,
} from '../../src/rss/pulse.js';
import type { TrendingBoard } from '../../src/scoring/trending.js';

function cand(overrides: Partial<PulseCandidate> = {}): PulseCandidate {
  return {
    candidateId: 'c-' + Math.random().toString(36).slice(2),
    headline: 'Headline',
    curationRationale: 'Because it matters.',
    primaryDomain: 'economy',
    curationScore: 70,
    temperature: 'warm',
    trajectory: 'rising',
    isExclusive: false,
    ...overrides,
  };
}

describe('selectPulseCandidates', () => {
  it('morning: caps at PULSE_TOP_N, ranked by curation_score desc', () => {
    const pool = [61, 88, 75, 92, 70, 64, 83].map((s) => cand({ curationScore: s }));
    const picked = selectPulseCandidates(pool, 'morning');
    expect(picked).toHaveLength(PULSE_TOP_N);
    expect(picked.map((c) => c.curationScore)).toEqual([92, 88, 83, 75, 70]);
  });

  it('afternoon: contributes nothing on a quiet run (Q10)', () => {
    const pool = [cand(), cand({ curationScore: 90 })];
    expect(selectPulseCandidates(pool, 'afternoon')).toEqual([]);
    expect(selectPulseCandidates(pool, 'manual')).toEqual([]);
  });

  it('afternoon: an exclusive opens the gate for the whole top-N', () => {
    const pool = [
      cand({ curationScore: 90 }),
      cand({ curationScore: 80, isExclusive: true }),
    ];
    const picked = selectPulseCandidates(pool, 'afternoon');
    expect(picked.map((c) => c.curationScore)).toEqual([90, 80]);
  });

  it('afternoon: a hot rising/new story opens the gate', () => {
    const hot = cand({ temperature: 'hot', trajectory: 'rising' });
    expect(selectPulseCandidates([hot], 'afternoon')).toHaveLength(1);
    const hotNew = cand({ temperature: 'hot', trajectory: 'new' });
    expect(selectPulseCandidates([hotNew], 'afternoon')).toHaveLength(1);
    // hot but declining does NOT
    const declining = cand({ temperature: 'hot', trajectory: 'declining' });
    expect(selectPulseCandidates([declining], 'afternoon')).toEqual([]);
  });

  it('morning with an empty pool returns empty', () => {
    expect(selectPulseCandidates([], 'morning')).toEqual([]);
  });
});

describe('descriptions', () => {
  it('candidate description carries the angle line + meta', () => {
    const d = pulseCandidateDescription(
      cand({ curationScore: 84.4, isExclusive: true, trajectory: 'rising' }),
    );
    expect(d).toContain('↳ Because it matters.');
    expect(d).toContain('economy · score 84 · rising · exclusive');
  });

  it('candidate description degrades to meta-only when rationale is empty', () => {
    const d = pulseCandidateDescription(cand({ curationRationale: '  ' }));
    expect(d).toBe('economy · score 70 · rising');
  });

  it('waves description renders themes then keywords', () => {
    const board: TrendingBoard = {
      cluster_count: 4,
      themes: [
        {
          term: 'ai-labour',
          cluster_count: 3,
          score: 9,
          mean_heat: 2.5,
          domains: ['scitech', 'economy'],
          top_headline: 'h',
        },
      ],
      keywords: [
        { term: 'tariffs', cluster_count: 2, score: 4, mean_heat: 1, domains: ['economy'], top_headline: 'h' },
      ],
    };
    const d = wavesDescription(board);
    expect(d).toContain('ai-labour · 3 clusters · scitech');
    expect(d).toContain('Keywords: tariffs');
  });
});
