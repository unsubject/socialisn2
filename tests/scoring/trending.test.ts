// Pure unit tests for the trending aggregation core. No DB — these
// exercise computeTrendingFromRows directly, which is where the
// feature's premise lives: news-grade themes/keywords must outrank the
// evergreen arXiv/academic flood.

import { describe, expect, it } from 'vitest';

import {
  computeTrendingFromRows,
  type TrendingRow,
} from '../../src/scoring/trending.js';

let clusterSeq = 0;
function row(opts: Partial<TrendingRow> = {}): TrendingRow {
  clusterSeq += 1;
  return {
    clusterId: opts.clusterId ?? `cluster-${clusterSeq}`,
    headline: opts.headline ?? `Headline ${clusterSeq}`,
    primaryDomain: opts.primaryDomain ?? 'scitech',
    temperature: opts.temperature ?? 'warm',
    trajectory: opts.trajectory ?? 'rising',
    keywords: opts.keywords ?? [],
    tags: opts.tags ?? [],
  };
}

// A realistic-ish mix: 3 hot news clusters + 6 warm scitech/arXiv
// "flood" clusters (mostly LLM papers, tagged `ai-safety` or untagged).
function newsClusters(): TrendingRow[] {
  return [
    row({
      headline: 'US proposes tariffs on 60 countries over forced labor',
      primaryDomain: 'geopolitics',
      temperature: 'hot',
      trajectory: 'rising',
      tags: ['supply-chain-realignment'],
      keywords: ['tariffs', 'forced-labor', 'trade-policy'],
    }),
    row({
      headline: 'Iran conflict disrupts Strait of Hormuz, triggering energy shocks',
      primaryDomain: 'geopolitics',
      temperature: 'hot',
      trajectory: 'rising',
      tags: ['supply-chain-realignment', 'post-america'],
      keywords: ['strait-of-hormuz', 'energy-security', 'oil-markets'],
    }),
    row({
      headline: 'Israel and Lebanon agree to ceasefire amid US mediation',
      primaryDomain: 'geopolitics',
      temperature: 'hot',
      trajectory: 'peaking',
      tags: ['post-america'],
      keywords: ['ceasefire', 'energy-security'],
    }),
  ];
}

function floodClusters(): TrendingRow[] {
  const out: TrendingRow[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      row({
        headline: `New frameworks enhance LLM reasoning ${i}`,
        primaryDomain: 'scitech',
        temperature: 'warm',
        trajectory: 'rising',
        tags: ['ai-safety'],
        keywords: ['large-language-models', 'reinforcement-learning'],
      }),
    );
  }
  for (let i = 0; i < 3; i++) {
    out.push(
      row({
        headline: `New optimization algorithm analysis ${i}`,
        primaryDomain: 'scitech',
        temperature: 'warm',
        trajectory: 'declining',
        tags: ['ai-safety'],
        keywords: ['large-language-models', 'optimization-algorithms'],
      }),
    );
  }
  return out;
}

describe('computeTrendingFromRows', () => {
  // The two "ranks above" assertions below are coupled to the
  // HEAT_WEIGHT / TRAJ_WEIGHT constants in src/scoring/trending.ts —
  // tuning those weights may require re-checking these orderings. That
  // coupling is intentional: the weights are the ranking contract.

  it('returns an empty board for no rows', () => {
    const board = computeTrendingFromRows([]);
    expect(board).toEqual({ cluster_count: 0, themes: [], keywords: [] });
  });

  it('ranks news-grade themes above the warm arXiv flood', () => {
    const board = computeTrendingFromRows([...newsClusters(), ...floodClusters()]);

    expect(board.cluster_count).toBe(9);

    // The hot news themes must come out on top — not `ai-safety`, which
    // tags 6 warm flood clusters and would win a naive frequency count.
    const themeOrder = board.themes.map((t) => t.term);
    expect(themeOrder[0]).toBe('supply-chain-realignment');
    const aiSafetyRank = themeOrder.indexOf('ai-safety');
    expect(themeOrder.indexOf('supply-chain-realignment')).toBeLessThan(aiSafetyRank);
    expect(themeOrder.indexOf('post-america')).toBeLessThan(aiSafetyRank);
  });

  it('ranks a news keyword above the high-volume flood keyword', () => {
    const board = computeTrendingFromRows([...newsClusters(), ...floodClusters()]);

    // `energy-security` spans 2 hot clusters; `large-language-models`
    // spans 6 warm ones. Heat weighting puts the news keyword first
    // despite the lower raw count.
    const kwOrder = board.keywords.map((k) => k.term);
    expect(kwOrder[0]).toBe('energy-security');
    expect(kwOrder.indexOf('energy-security')).toBeLessThan(
      kwOrder.indexOf('large-language-models'),
    );
  });

  it('dedups re-minted candidate rows sharing a cluster_id', () => {
    const base = row({
      clusterId: 'persist-1',
      headline: 'Persisting story',
      temperature: 'hot',
      tags: ['supply-chain-realignment'],
      keywords: ['tariffs'],
    });
    // Same cluster, minted again on a later run (latest first).
    const reMinted = { ...base, headline: 'Persisting story (afternoon)' };
    const board = computeTrendingFromRows([reMinted, base, ...floodClusters()]);

    expect(board.cluster_count).toBe(7); // 1 persist + 6 flood, not 8
    const theme = board.themes.find((t) => t.term === 'supply-chain-realignment');
    expect(theme?.cluster_count).toBe(1);
    // Latest-first wins: the re-minted (afternoon) row is first in the
    // input, so its headline is the one that survives dedup. A "keep
    // oldest" regression would flip this (both rows share equal weight).
    expect(theme?.top_headline).toBe('Persisting story (afternoon)');
  });

  it('collapses one story split across two cluster_ids by headline', () => {
    const a = row({
      clusterId: 'fork-a',
      headline: 'Bond markets signal end of low-cost era',
      temperature: 'hot',
      tags: ['monetary-policy'],
    });
    const b = row({
      clusterId: 'fork-b',
      headline: 'Bond Markets Signal End of Low-Cost Era', // case-only drift
      temperature: 'hot',
      tags: ['monetary-policy'],
    });
    const board = computeTrendingFromRows([a, b]);
    expect(board.cluster_count).toBe(1);
  });

  it('applies min_clusters to keywords but keeps single-cluster themes', () => {
    // `lone-theme` tags exactly ONE cluster; `ceasefire` is in 1 cluster,
    // `energy-security` in 2.
    const rows = [
      ...newsClusters(),
      row({ headline: 'A lone single-cluster story', primaryDomain: 'national', tags: ['lone-theme'] }),
    ];
    const strict = computeTrendingFromRows(rows, { minClusters: 2 });
    expect(strict.keywords.map((k) => k.term)).not.toContain('ceasefire');
    expect(strict.keywords.map((k) => k.term)).toContain('energy-security');

    const loose = computeTrendingFromRows(rows, { minClusters: 1 });
    expect(loose.keywords.map((k) => k.term)).toContain('ceasefire');

    // `lone-theme` tags exactly ONE cluster but must still surface as a
    // theme even at minClusters:2 — themes always qualify at ≥1. (Uses a
    // genuinely single-cluster tag: `post-america` has count 2 and would
    // pass even if themes wrongly honoured minClusters.)
    expect(strict.themes.find((t) => t.term === 'lone-theme')?.cluster_count).toBe(1);
    expect(strict.themes.map((t) => t.term)).toContain('lone-theme');
  });

  it('orders domains by drive, not alphabetically (real lead domain first)', () => {
    // One theme spanning `national` (1 hot/rising cluster, weight 4.5) and
    // `economy` (2 warm/rising clusters, weight 3.0 total). Alphabetically
    // `economy` sorts first, but `national` drives the theme — it must lead.
    const rows: TrendingRow[] = [
      row({
        clusterId: 'c-nat',
        headline: 'National story',
        primaryDomain: 'national',
        temperature: 'hot',
        trajectory: 'rising',
        tags: ['cross-theme'],
      }),
      row({
        clusterId: 'c-econ-1',
        headline: 'Economy story one',
        primaryDomain: 'economy',
        temperature: 'warm',
        trajectory: 'rising',
        tags: ['cross-theme'],
      }),
      row({
        clusterId: 'c-econ-2',
        headline: 'Economy story two',
        primaryDomain: 'economy',
        temperature: 'warm',
        trajectory: 'rising',
        tags: ['cross-theme'],
      }),
    ];
    const board = computeTrendingFromRows(rows);
    const theme = board.themes.find((t) => t.term === 'cross-theme');
    expect(theme?.domains).toEqual(['national', 'economy']);
  });

  it('filters by domain', () => {
    const board = computeTrendingFromRows([...newsClusters(), ...floodClusters()], {
      domain: 'scitech',
    });
    // Only flood clusters are scitech — no geopolitics news themes.
    expect(board.cluster_count).toBe(6);
    expect(board.themes.map((t) => t.term)).toContain('ai-safety');
    expect(board.themes.map((t) => t.term)).not.toContain('supply-chain-realignment');
  });

  it('reports mean_heat and a hottest-cluster exemplar headline', () => {
    const board = computeTrendingFromRows(newsClusters());
    const supplyChain = board.themes.find((t) => t.term === 'supply-chain-realignment');
    expect(supplyChain?.mean_heat).toBe(3); // both clusters hot
    expect(supplyChain?.top_headline).toMatch(/tariffs|Hormuz/);
  });
});
