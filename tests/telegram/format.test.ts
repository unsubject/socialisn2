// Pure tests for src/telegram/format.ts — no DB, no HTTP.

import { describe, expect, it } from 'vitest';

import {
  candidateKeyboard,
  chunkForTelegram,
  escapeMarkdownV2,
  escapeMarkdownV2Url,
  formatCandidateDetail,
  formatCandidateLine,
  formatDigest,
  formatExclusivePush,
  formatTodayList,
  formatTrendingSection,
  type RenderCandidate,
} from '../../src/telegram/format.js';
import type { TrendingBoard, TrendingEntry } from '../../src/scoring/trending.js';

function mkEntry(overrides: Partial<TrendingEntry> = {}): TrendingEntry {
  return {
    term: 'supply-chain-realignment',
    cluster_count: 3,
    score: 9,
    mean_heat: 3,
    domains: ['geopolitics'],
    top_headline: 'Hormuz disruption',
    ...overrides,
  };
}

function mkBoard(overrides: Partial<TrendingBoard> = {}): TrendingBoard {
  return {
    cluster_count: 9,
    themes: [mkEntry()],
    keywords: [mkEntry({ term: 'strait-of-hormuz', cluster_count: 2, mean_heat: 3 })],
    ...overrides,
  };
}

function mkCandidate(overrides: Partial<RenderCandidate> = {}): RenderCandidate {
  return {
    id: '01234567-89ab-cdef-0123-456789abcdef',
    headline: 'Fed holds rates',
    primaryDomain: 'economy',
    domains: ['economy'],
    temperature: 'warm',
    trajectory: 'rising',
    isExclusive: false,
    archiveOverlap: 0.1,
    keywords: ['fed', 'rates'],
    tags: ['monetary'],
    ...overrides,
  };
}

describe('escapeMarkdownV2', () => {
  it('escapes the full MarkdownV2 reserved set', () => {
    const reserved = '_*[]()~`>#+-=|{}.!\\';
    const result = escapeMarkdownV2(reserved);
    // Each reserved char must be backslash-prefixed.
    for (const ch of reserved) {
      expect(result).toContain(`\\${ch}`);
    }
  });

  it('does NOT escape ordinary text', () => {
    expect(escapeMarkdownV2('Hello world')).toBe('Hello world');
  });

  it('handles empty string', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });
});

describe('escapeMarkdownV2Url', () => {
  it('escapes only ) and backslash, leaving other reserved chars intact', () => {
    // A URL with dots, dashes, query (=, &) — none of these are special
    // inside a MarkdownV2 link (url) and must pass through untouched.
    expect(escapeMarkdownV2Url('https://a.b-c.com/x_y.html?q=1&z=2')).toBe(
      'https://a.b-c.com/x_y.html?q=1&z=2',
    );
  });

  it('escapes a closing paren so it cannot end the link early', () => {
    expect(escapeMarkdownV2Url('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar\\)',
    );
  });
});

describe('formatCandidateLine', () => {
  it('escapes the headline + id in the line', () => {
    const line = formatCandidateLine(
      mkCandidate({ headline: 'Title (with parens.) - dash' }),
    );
    expect(line).toContain('Title \\(with parens\\.\\) \\- dash');
    // /cand <id> appears, escaped
    expect(line).toContain('/cand 01234567\\-89ab\\-cdef\\-0123\\-456789abcdef');
  });

  it('includes exclusive marker only when isExclusive=true', () => {
    expect(formatCandidateLine(mkCandidate({ isExclusive: false }))).not.toContain('⚡');
    expect(formatCandidateLine(mkCandidate({ isExclusive: true }))).toContain('⚡');
  });

  it('renders unknown temperature/trajectory as the dot fallback', () => {
    const line = formatCandidateLine(
      mkCandidate({ temperature: 'unknown', trajectory: 'mystery' }),
    );
    expect(line.startsWith('··')).toBe(true);
  });
});

describe('formatCandidateDetail', () => {
  it('renders headline + context + keywords + sources', () => {
    const out = formatCandidateDetail(
      mkCandidate({
        contextSummary: 'Some context.',
        curationRationale: 'Strong angle',
        sources: [{ name: 'Reuters', url: 'https://example.com' }],
      }),
    );
    expect(out).toContain('Fed holds rates');
    expect(out).toContain('Some context\\.');
    expect(out).toContain('Strong angle');
    expect(out).toContain('Reuters');
  });

  it('omits sources section when sources is empty/undefined', () => {
    const out = formatCandidateDetail(mkCandidate({ sources: [] }));
    expect(out).not.toContain('*Sources:*');
  });

  it('does not corrupt source URLs with MarkdownV2 escape backslashes', () => {
    // The (url) of a MarkdownV2 link must NOT be run through the full
    // escaper — backslashes before `.` etc. are retained literally and
    // change the destination. A real URL with a TLD dot is the common case.
    const out = formatCandidateDetail(
      mkCandidate({
        sources: [{ name: 'NYT', url: 'https://www.nytimes.com/2026/06/05/a.html' }],
      }),
    );
    expect(out).toContain('](https://www.nytimes.com/2026/06/05/a.html)');
    expect(out).not.toContain('www\\.nytimes');
  });

  it('shows EXCLUSIVE marker only when flagged', () => {
    expect(formatCandidateDetail(mkCandidate({ isExclusive: true }))).toContain(
      'EXCLUSIVE',
    );
    expect(formatCandidateDetail(mkCandidate({ isExclusive: false }))).not.toContain(
      'EXCLUSIVE',
    );
  });
});

describe('formatTodayList', () => {
  it('returns empty-state when no candidates', () => {
    expect(formatTodayList([])).toContain('No active candidates');
  });

  it('groups by primaryDomain with per-domain counts (MarkdownV2-escaped parens)', () => {
    const out = formatTodayList([
      mkCandidate({ id: 'a'.repeat(8) + '-1234-5678-9012-345678901234', primaryDomain: 'economy' }),
      mkCandidate({ id: 'b'.repeat(8) + '-1234-5678-9012-345678901234', primaryDomain: 'economy' }),
      mkCandidate({ id: 'c'.repeat(8) + '-1234-5678-9012-345678901234', primaryDomain: 'scitech' }),
    ]);
    // MarkdownV2 reserves `(` and `)`. Section headers must emit
    // `\\(2\\)` — without the escape, Telegram 400s the entire
    // reply and the user sees nothing. Assert the escape AND that
    // no bare paren follows the bold domain.
    expect(out).toContain('*economy* \\(2\\)');
    expect(out).toContain('*scitech* \\(1\\)');
    expect(out).not.toMatch(/\*economy\*\s+\(\d/);
    expect(out).not.toMatch(/\*scitech\*\s+\(\d/);
  });
});

describe('formatDigest', () => {
  it('renders per-domain counts + exclusive count + /today suffix', () => {
    const out = formatDigest({
      runKind: 'morning',
      candidates: [
        { primaryDomain: 'economy', isExclusive: false },
        { primaryDomain: 'economy', isExclusive: false },
        { primaryDomain: 'economy', isExclusive: false },
        { primaryDomain: 'economy', isExclusive: false },
        { primaryDomain: 'geopolitics', isExclusive: true },
        { primaryDomain: 'geopolitics', isExclusive: false },
      ],
    });
    expect(out).toContain('Morning run complete');
    expect(out).toContain('4 new in `economy`');
    expect(out).toContain('2 new in `geopolitics`');
    expect(out).toContain('1 exclusive flagged');
    expect(out).toContain('/today');
  });

  it('handles empty candidate list', () => {
    const out = formatDigest({ runKind: 'afternoon', candidates: [] });
    expect(out).toContain('Afternoon run complete');
    expect(out).toContain('No new candidates');
  });

  it('pluralises exclusives correctly', () => {
    const oneExcl = formatDigest({
      runKind: 'manual',
      candidates: [{ primaryDomain: 'economy', isExclusive: true }],
    });
    expect(oneExcl).toContain('1 exclusive');
    expect(oneExcl).not.toContain('1 exclusives');

    const twoExcl = formatDigest({
      runKind: 'manual',
      candidates: [
        { primaryDomain: 'economy', isExclusive: true },
        { primaryDomain: 'economy', isExclusive: true },
      ],
    });
    expect(twoExcl).toContain('2 exclusives');
  });

  it('appends the trending board when provided (morning)', () => {
    const out = formatDigest({
      runKind: 'morning',
      candidates: [{ primaryDomain: 'geopolitics', isExclusive: false }],
      trending: mkBoard(),
    });
    expect(out).toContain('Morning run complete');
    expect(out).toContain('📈 *Trending now*');
    expect(out).toContain('`supply-chain-realignment`');
  });

  it('omits the board when trending is absent (afternoon/manual)', () => {
    const out = formatDigest({
      runKind: 'afternoon',
      candidates: [{ primaryDomain: 'economy', isExclusive: false }],
    });
    expect(out).not.toContain('Trending now');
  });
});

describe('formatTrendingSection', () => {
  it('renders kebab terms in code spans without literal escape backslashes', () => {
    // The MarkdownV2 trap: escapeMarkdownV2 would turn `strait-of-hormuz`
    // into `strait\-of\-hormuz`, and inside a code span those backslashes
    // render literally. Code spans must carry the raw term.
    const out = formatTrendingSection(mkBoard());
    expect(out).toContain('`strait-of-hormuz`');
    expect(out).not.toContain('\\-');
  });

  it('strips backtick/backslash that would break or leak out of the span', () => {
    // The whole safety argument rests on this strip — a term with a
    // stray backtick must not break the code span.
    const out = formatTrendingSection(
      mkBoard({ themes: [mkEntry({ term: 'a`b\\c' })], keywords: [] }),
    );
    expect(out).toContain('`abc`');
    expect(out).not.toContain('a`b');
  });

  it('maps mean_heat to a heat icon and pluralises cluster count', () => {
    const hot = formatTrendingSection(
      mkBoard({ themes: [mkEntry({ mean_heat: 3, cluster_count: 3 })], keywords: [] }),
    );
    expect(hot).toContain('🔥 `supply-chain-realignment` · 3 clusters');

    const warmSingle = formatTrendingSection(
      mkBoard({
        themes: [mkEntry({ term: 'monetary-policy', mean_heat: 1, cluster_count: 1 })],
        keywords: [],
      }),
    );
    expect(warmSingle).toContain('☀ `monetary-policy` · 1 cluster');
    expect(warmSingle).not.toContain('1 clusters');

    // Index 2 (over_saturated → 💥) is the confusable slot — TEMPERATURE_ICON
    // lists hot before over_saturated, but the ordinal puts over_saturated
    // at 2. An off-by-one would hide exactly here.
    const saturated = formatTrendingSection(
      mkBoard({ themes: [mkEntry({ term: 'ai-safety', mean_heat: 2 })], keywords: [] }),
    );
    expect(saturated).toContain('💥 `ai-safety`');
  });

  it('returns empty string for an empty board', () => {
    expect(formatTrendingSection({ cluster_count: 0, themes: [], keywords: [] })).toBe('');
  });

  it('caps themes and keywords to keep the message tight', () => {
    const themes = Array.from({ length: 10 }, (_, i) =>
      mkEntry({ term: `theme-${i}`, cluster_count: 10 - i }),
    );
    const keywords = Array.from({ length: 15 }, (_, i) =>
      mkEntry({ term: `kw-${i}`, cluster_count: 15 - i }),
    );
    const out = formatTrendingSection({ cluster_count: 25, themes, keywords });
    expect(out).toContain('`theme-0`');
    expect(out).not.toContain('`theme-6`'); // capped at 6 themes
    expect(out).toContain('`kw-0`');
    expect(out).not.toContain('`kw-10`'); // capped at 10 keywords
  });
});

describe('formatExclusivePush', () => {
  it('leads with ⚡ marker and includes /cand link', () => {
    const out = formatExclusivePush(mkCandidate({ headline: 'Scoop' }));
    expect(out.startsWith('⚡')).toBe(true);
    expect(out).toContain('Scoop');
    expect(out).toContain('/cand ');
  });
});

describe('chunkForTelegram', () => {
  // Regression: a real 2026-05-29 /today response was ~4600 chars
  // (30 candidates × ~150-char rows + MarkdownV2 escape doubling on
  // every `.` `-` `(`) and 400'd Telegram with "message is too long".
  // The 4096 hard cap means chunks must land STRICTLY below it; we
  // chunk at 3800 to leave headroom for Telegram's invisible escape
  // accounting (the API sometimes counts escaped chars differently
  // than the strlen we see).
  it('returns the input unchanged when below the limit', () => {
    expect(chunkForTelegram('hello')).toEqual(['hello']);
  });

  it('splits a long formatTodayList output across multiple chunks, each <= 3800', () => {
    const candidates: RenderCandidate[] = [];
    for (let i = 0; i < 30; i += 1) {
      candidates.push(
        mkCandidate({
          id: `${i.toString().padStart(8, '0')}-1234-5678-9012-345678901234`,
          headline: 'A reasonably long headline about regulatory shifts in financial markets and AI policy implications',
          primaryDomain: i % 4 === 0 ? 'economy' : i % 4 === 1 ? 'scitech' : i % 4 === 2 ? 'geopolitics' : 'national',
        }),
      );
    }
    const body = formatTodayList(candidates);
    expect(body.length).toBeGreaterThan(3800);

    const chunks = chunkForTelegram(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3800);
    }
    // Round-trip: rejoining preserves the content (modulo the `\n\n`
    // boundaries the chunker splits on). Every candidate id must
    // appear exactly once across all chunks.
    const rejoined = chunks.join('\n\n');
    for (const c of candidates) {
      const escapedId = c.id.replace(/-/g, '\\-');
      expect(rejoined).toContain(escapedId);
    }
  });

  it('prefers paragraph (\\n\\n) boundaries over line (\\n) boundaries', () => {
    // Two paragraphs, each comfortably small, sum > limit.
    const para = 'x'.repeat(2500);
    const body = `${para}\n\n${para}`;
    const chunks = chunkForTelegram(body, 3000);
    expect(chunks).toEqual([para, para]);
  });

  it('falls through to line splitting when a single paragraph exceeds the limit', () => {
    const longPara = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}\n${'c'.repeat(1500)}`;
    const chunks = chunkForTelegram(longPara, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('hard-slices as a last resort when a single line exceeds the limit', () => {
    const huge = 'z'.repeat(2500);
    const chunks = chunkForTelegram(huge, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join('')).toBe(huge);
  });
});

describe('candidateKeyboard', () => {
  it('produces three buttons with decide:<action>:<id> callback data', () => {
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const kb = candidateKeyboard(id);
    // grammy InlineKeyboard.inline_keyboard is a 2D array of buttons.
    const buttons = kb.inline_keyboard.flat();
    expect(buttons).toHaveLength(3);
    const datas = buttons.map((b) => 'callback_data' in b ? b.callback_data : '');
    expect(datas).toEqual([
      `decide:pick:${id}`,
      `decide:pass:${id}`,
      `decide:defer:${id}`,
    ]);
  });
});
