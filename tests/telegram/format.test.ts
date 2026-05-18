// Pure tests for src/telegram/format.ts — no DB, no HTTP.

import { describe, expect, it } from 'vitest';

import {
  candidateKeyboard,
  escapeMarkdownV2,
  formatCandidateDetail,
  formatCandidateLine,
  formatDigest,
  formatExclusivePush,
  formatTodayList,
  type RenderCandidate,
} from '../../src/telegram/format.js';

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
});

describe('formatExclusivePush', () => {
  it('leads with ⚡ marker and includes /cand link', () => {
    const out = formatExclusivePush(mkCandidate({ headline: 'Scoop' }));
    expect(out.startsWith('⚡')).toBe(true);
    expect(out).toContain('Scoop');
    expect(out).toContain('/cand ');
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
