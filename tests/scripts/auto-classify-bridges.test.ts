// Pure-function tests for the classifier's parsing + validation.
// The Anthropic call itself is mocked at the network level if needed
// for an integration test; this file just exercises the response-
// parsing logic so a bad LLM response doesn't write a garbage row.

import { describe, expect, it } from 'vitest';

import {
  extractClassification,
  parseClassificationJson,
  senderKey,
  validateClassification,
} from '../../scripts/auto-classify-bridges.js';

describe('validateClassification', () => {
  const valid = {
    slug: 'nature-news',
    name: 'Nature News',
    primary_domain: 'scitech',
    domains: ['scitech'],
    authority: 85,
    language: 'en',
    reasoning: 'Tier-1 peer-reviewed science publisher.',
  };

  it('accepts a well-formed object', () => {
    expect(validateClassification(valid)).toEqual(valid);
  });

  it('rejects a slug with uppercase / spaces', () => {
    expect(validateClassification({ ...valid, slug: 'Nature News' })).toBeNull();
  });

  it('lowercases an uppercase slug if otherwise valid', () => {
    const got = validateClassification({ ...valid, slug: 'Nature-News' });
    expect(got?.slug).toBe('nature-news');
  });

  it('rejects unknown primary_domain', () => {
    expect(validateClassification({ ...valid, primary_domain: 'sports' })).toBeNull();
  });

  it('rejects when domains[0] != primary_domain', () => {
    expect(
      validateClassification({ ...valid, domains: ['economy'], primary_domain: 'scitech' }),
    ).toBeNull();
  });

  it('clamps authority to 0-100', () => {
    expect(validateClassification({ ...valid, authority: 999 })?.authority).toBe(100);
    expect(validateClassification({ ...valid, authority: -10 })?.authority).toBe(0);
  });

  it('rejects non-numeric authority', () => {
    expect(validateClassification({ ...valid, authority: 'high' })).toBeNull();
  });

  it('defaults language to "en" when blank', () => {
    expect(validateClassification({ ...valid, language: '' })?.language).toBe('en');
  });

  it('rejects missing name', () => {
    expect(validateClassification({ ...valid, name: '' })).toBeNull();
  });
});

describe('parseClassificationJson', () => {
  it('extracts JSON from a bare object', () => {
    const text = `{
      "slug": "x",
      "name": "X",
      "primary_domain": "economy",
      "domains": ["economy"],
      "authority": 75,
      "language": "en",
      "reasoning": "test"
    }`;
    expect(parseClassificationJson(text)?.slug).toBe('x');
  });

  it('extracts JSON with surrounding prose', () => {
    const text = `Sure! Here is the classification:

{"slug": "y", "name": "Y", "primary_domain": "scitech", "domains": ["scitech"], "authority": 70, "language": "en", "reasoning": "ok"}

Let me know if you need more.`;
    expect(parseClassificationJson(text)?.slug).toBe('y');
  });

  it('returns null for non-JSON gibberish', () => {
    expect(parseClassificationJson('I have no information about this publisher.')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseClassificationJson('{ "slug": "x"  // missing brace')).toBeNull();
  });
});

describe('extractClassification', () => {
  it('finds the last text block and parses its JSON', () => {
    const response = {
      stop_reason: 'end_turn',
      content: [
        { type: 'tool_use', name: 'web_search' },
        {
          type: 'text',
          text: '{"slug":"a","name":"A","primary_domain":"economy","domains":["economy"],"authority":80,"language":"en","reasoning":""}',
        },
      ],
    };
    expect(extractClassification(response)?.slug).toBe('a');
  });

  it('returns null when there is no text block', () => {
    expect(
      extractClassification({ stop_reason: 'end_turn', content: [{ type: 'tool_use' }] }),
    ).toBeNull();
  });
});

describe('senderKey', () => {
  it('prefers list_id when present', () => {
    expect(
      senderKey({
        list_id: '<x.list>',
        from_addr: 'a@b.com',
        from_domain: 'b.com',
        subject_sample: null,
      }),
    ).toEqual({ match_field: 'list_id', match_value: '<x.list>' });
  });

  it('falls back to from_addr', () => {
    expect(
      senderKey({
        list_id: null,
        from_addr: 'a@b.com',
        from_domain: 'b.com',
        subject_sample: null,
      }),
    ).toEqual({ match_field: 'from_addr', match_value: 'a@b.com' });
  });

  it('falls back to from_domain', () => {
    expect(
      senderKey({
        list_id: null,
        from_addr: null,
        from_domain: 'b.com',
        subject_sample: null,
      }),
    ).toEqual({ match_field: 'from_domain', match_value: 'b.com' });
  });

  it('returns null when nothing is usable', () => {
    expect(
      senderKey({ list_id: null, from_addr: null, from_domain: null, subject_sample: null }),
    ).toBeNull();
  });
});
