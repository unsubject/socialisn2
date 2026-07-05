// DB-free unit tests for the Weekly Ideation Brief core (redesign P1):
// parse/validate of the model response and the markdown/HTML renderers.
// The DB + orchestrator path is covered in tests/orchestrator/brief.test.ts.

import { describe, expect, it } from 'vitest';

import {
  parseAndValidate,
  renderBriefBodyHtml,
  renderBriefMarkdown,
  type BriefInput,
  type BriefPitch,
} from '../../src/scoring/brief.js';

function makeInput(): BriefInput {
  return {
    weekOf: '2026-07-05',
    candidates: [
      {
        id: 'cand-1',
        headline: 'Fed holds rates',
        contextSummary: 'ctx',
        primaryDomain: 'economy',
        domains: ['economy'],
        temperature: 'hot',
        trajectory: 'rising',
        curationScore: 85,
        curationRationale: 'r',
        keywords: ['fed'],
        tags: ['monetary-policy'],
        isExclusive: false,
        runsSeen: 2,
        status: 'new',
        sourceUrls: [
          { title: 'FT: Fed decision', url: 'https://ft.example.com/fed' },
          { title: 'Reuters wrap', url: 'https://reuters.example.com/wrap' },
        ],
        archiveLinks: [],
      },
    ],
    decisions: [{ action: 'pass', headline: 'Old story', reason: 'covered before' }],
    trendingThemes: [{ term: 'ai-labour', clusterCount: 3, leadDomain: 'scitech' }],
  };
}

function validPitchJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pitches: [
      {
        hook: 'The Fed is not fighting inflation, it is fighting the bond market.',
        thesis: 'T',
        steelman: 'S',
        break: 'B',
        why_now: 'W',
        fit: 'F',
        evidence: [{ title: 'FT: Fed decision', url: 'https://ft.example.com/fed' }],
        candidate_ids: ['cand-1'],
        ...overrides,
      },
    ],
  });
}

describe('parseAndValidate', () => {
  it('accepts a valid response and maps snake_case → camelCase', () => {
    const pitches = parseAndValidate(validPitchJson(), makeInput());
    expect(pitches).toHaveLength(1);
    expect(pitches[0]!.whyNow).toBe('W');
    expect(pitches[0]!.candidateIds).toEqual(['cand-1']);
    expect(pitches[0]!.collision).toBeUndefined();
  });

  it('tolerates trailing commas (Gemini fallback path)', () => {
    const withCommas = validPitchJson().replace(
      '"candidate_ids":["cand-1"]',
      '"candidate_ids":["cand-1",],',
    );
    const pitches = parseAndValidate(withCommas, makeInput());
    expect(pitches).toHaveLength(1);
  });

  it('rejects a pitch with a missing field', () => {
    const bad = validPitchJson({ hook: '' });
    expect(() => parseAndValidate(bad, makeInput())).toThrow(/missing\/empty "hook"/);
  });

  it('drops hallucinated evidence URLs; rejects a pitch left with none', () => {
    const hallucinated = validPitchJson({
      evidence: [{ title: 'made up', url: 'https://invented.example.com/x' }],
    });
    expect(() => parseAndValidate(hallucinated, makeInput())).toThrow(
      /no valid evidence/,
    );
  });

  it('filters unknown candidate_ids instead of failing', () => {
    const withUnknown = validPitchJson({ candidate_ids: ['cand-1', 'ghost'] });
    const pitches = parseAndValidate(withUnknown, makeInput());
    expect(pitches[0]!.candidateIds).toEqual(['cand-1']);
  });

  it('rejects zero and >6 pitches', () => {
    expect(() => parseAndValidate('{"pitches": []}', makeInput())).toThrow(/1-6/);
    const seven = JSON.stringify({
      pitches: new Array(7).fill(JSON.parse(validPitchJson()).pitches[0]),
    });
    expect(() => parseAndValidate(seven, makeInput())).toThrow(/1-6/);
  });

  it('keeps a non-empty collision string', () => {
    const withCollision = validPitchJson({
      collision: 'TPU cost curves and container shipping rhyme: both are utilization games.',
    });
    const pitches = parseAndValidate(withCollision, makeInput());
    expect(pitches[0]!.collision).toContain('utilization games');
  });
});

describe('renderers', () => {
  const pitch: BriefPitch = {
    hook: 'Hook & <b>bold</b>',
    thesis: 'T',
    steelman: 'S',
    break: 'B',
    whyNow: 'W',
    fit: 'F',
    collision: 'C',
    evidence: [{ title: 'A & B', url: 'https://x.example.com/?a=1&b=2' }],
    candidateIds: ['cand-1'],
  };

  it('markdown carries every section + evidence links', () => {
    const md = renderBriefMarkdown('2026-07-05', [pitch]);
    expect(md).toContain('# Weekly Ideation Brief — 2026-07-05');
    expect(md).toContain('## Pitch 1: Hook & <b>bold</b>');
    expect(md).toContain('**Where it breaks:** B');
    expect(md).toContain('**Collision:** C');
    expect(md).toContain('[A & B](https://x.example.com/?a=1&b=2)');
  });

  it('HTML escapes every model-derived string', () => {
    const html = renderBriefBodyHtml([pitch]);
    expect(html).toContain('Hook &amp; &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('https://x.example.com/?a=1&amp;b=2');
    expect(html).toContain('<dt>Collision</dt><dd>C</dd>');
  });

  it('HTML omits the collision row when absent', () => {
    const html = renderBriefBodyHtml([{ ...pitch, collision: undefined }]);
    expect(html).not.toContain('<dt>Collision</dt>');
  });
});
