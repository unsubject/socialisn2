// Pure-function tests for parse.ts. Runs under plain Node + vitest;
// no Workers runtime / Miniflare required.

import { describe, expect, it } from 'vitest';

import { extractLinks, stripBoilerplate } from '../src/parse';

describe('stripBoilerplate', () => {
  it('returns empty string for empty input', () => {
    expect(stripBoilerplate('')).toBe('');
  });

  it('returns trimmed input when no marker is present', () => {
    expect(stripBoilerplate('Hello world\n\n')).toBe('Hello world');
  });

  it('cuts at the first Unsubscribe line', () => {
    const text = `The news today
Lorem ipsum dolor sit amet.

Unsubscribe | Manage preferences
Footer line`;
    expect(stripBoilerplate(text)).toBe('The news today\nLorem ipsum dolor sit amet.');
  });

  it('cuts at "view this email in your browser"', () => {
    const text = `Headline
View this email in your browser
…`;
    expect(stripBoilerplate(text)).toBe('Headline');
  });

  it('cuts at copyright/© footer', () => {
    const text = `Story
More story

© 2026 Publisher Inc.`;
    expect(stripBoilerplate(text)).toBe('Story\nMore story');
  });

  it('takes the EARLIEST marker when multiple appear', () => {
    const text = `Story

Unsubscribe link

View this email in your browser

© 2026`;
    expect(stripBoilerplate(text)).toBe('Story');
  });

  it('does not false-cut on inline mid-sentence "unsubscribe"', () => {
    const text = `Lorem ipsum, where you may unsubscribe from any time, dolor sit amet.

More content.`;
    expect(stripBoilerplate(text)).toBe(text.trimEnd());
  });
});

describe('extractLinks', () => {
  it('returns empty array on empty input', () => {
    expect(extractLinks({ html: null, text: null })).toEqual([]);
    expect(extractLinks({ html: '', text: '' })).toEqual([]);
  });

  it('parses <a href> from HTML in document order', () => {
    const html = `
      <p>See <a href="https://example.com/one">one</a> and
      <a href='https://example.com/two'>two</a></p>
    `;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/one', pos: 0, kind: 'article' },
      { url: 'https://example.com/two', pos: 1, kind: 'article' },
    ]);
  });

  it('drops mailto / anchor / javascript / tel', () => {
    const html = `
      <a href="mailto:hi@ex.com">mail</a>
      <a href="#section">anchor</a>
      <a href="javascript:void(0)">js</a>
      <a href="tel:+1234">tel</a>
      <a href="https://example.com/keep">keep</a>
    `;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/keep', pos: 0, kind: 'article' },
    ]);
  });

  it('drops unsubscribe / opt-out / preferences URLs', () => {
    const html = `
      <a href="https://list-manage.com/unsubscribe?id=abc">unsub</a>
      <a href="https://example.com/email-preferences">prefs</a>
      <a href="https://example.com/opt-out">opt</a>
      <a href="https://example.com/article">keep</a>
    `;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/article', pos: 0, kind: 'article' },
    ]);
  });

  it('dedups identical URLs', () => {
    const html = `
      <a href="https://example.com/x">a</a>
      <a href="https://example.com/x">b</a>
      <a href="https://example.com/y">c</a>
    `;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/x', pos: 0, kind: 'article' },
      { url: 'https://example.com/y', pos: 1, kind: 'article' },
    ]);
  });

  it('falls back to bare-URL regex on plain text', () => {
    const text = `Check out https://example.com/news and https://example.com/post for more.`;
    expect(extractLinks({ html: null, text })).toEqual([
      { url: 'https://example.com/news', pos: 0, kind: 'article' },
      { url: 'https://example.com/post', pos: 1, kind: 'article' },
    ]);
  });

  it('prefers HTML when both are provided', () => {
    const html = `<a href="https://example.com/html-link">x</a>`;
    const text = `https://example.com/text-link`;
    expect(extractLinks({ html, text })).toEqual([
      { url: 'https://example.com/html-link', pos: 0, kind: 'article' },
    ]);
  });

  it('ignores case-variant unsubscribe URLs', () => {
    const html = `<a href="https://example.com/Unsubscribe?x=y">u</a>`;
    expect(extractLinks({ html })).toEqual([]);
  });

  it('handles CRLF line endings in plain text', () => {
    const text = `Check out https://example.com/news\r\nand https://example.com/post for more.`;
    expect(extractLinks({ html: null, text })).toEqual([
      { url: 'https://example.com/news', pos: 0, kind: 'article' },
      { url: 'https://example.com/post', pos: 1, kind: 'article' },
    ]);
  });

  it('parses <a> tags split across lines', () => {
    const html = `<a\n  class="x"\n  href="https://example.com/multiline"\n  target="_blank">click</a>`;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/multiline', pos: 0, kind: 'article' },
    ]);
  });

  it('captures hrefs with HTML entities (does not decode)', () => {
    // The URL retains &amp; — downstream consumers normalise on retrieval.
    // We just verify the extractor does not crash and emits something stable.
    const html = `<a href="https://example.com/?a=1&amp;b=2">x</a>`;
    const links = extractLinks({ html });
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toContain('example.com');
  });
});

describe('extractLinks — classification', () => {
  it('classifies a homepage-only link as masthead', () => {
    const html = `<a href="https://example.com/">logo</a>`;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/', pos: 0, kind: 'masthead' },
    ]);
  });

  it('classifies "view in browser" / "web version" as masthead', () => {
    const html = `
      <a href="https://list.example.com/view-in-browser/abc123">view</a>
      <a href="https://list.example.com/p/web-version/xyz">web</a>
    `;
    const links = extractLinks({ html });
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.kind === 'masthead')).toBe(true);
  });

  it('classifies share-on-social URLs as social', () => {
    const html = `
      <a href="https://twitter.com/intent/tweet?url=https://ex.com/a">tw</a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url=https://ex.com/a">li</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://ex.com/a">fb</a>
      <a href="https://t.me/share/url?url=https://ex.com/a">tg</a>
    `;
    const links = extractLinks({ html });
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.kind === 'social')).toBe(true);
  });

  it('classifies a deep publisher URL as article', () => {
    const html = `<a href="https://www.publisher.com/2026/05/why-x-matters">article</a>`;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://www.publisher.com/2026/05/why-x-matters', pos: 0, kind: 'article' },
    ]);
  });

  it('classifies tracking-pixel URLs as tracking', () => {
    const html = `<a href="https://list.example.com/track/open.gif?u=abc">x</a>`;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://list.example.com/track/open.gif?u=abc', pos: 0, kind: 'tracking' },
    ]);
  });

  it('preserves document order and pos when kinds are mixed', () => {
    const html = `
      <a href="https://example.com/">logo</a>
      <a href="https://example.com/2026/05/article-slug">read</a>
      <a href="https://twitter.com/intent/tweet?url=https://example.com/2026/05/article-slug">share</a>
    `;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/', pos: 0, kind: 'masthead' },
      { url: 'https://example.com/2026/05/article-slug', pos: 1, kind: 'article' },
      { url: 'https://twitter.com/intent/tweet?url=https://example.com/2026/05/article-slug', pos: 2, kind: 'social' },
    ]);
  });

  it('treats unparseable URLs as other', () => {
    // Bare-URL regex captures schemes only, so this exercises the
    // classifier's URL-constructor try/catch fallback. We feed a
    // protocol-only string via plain text to bypass the href regex.
    const text = `https://`;
    const links = extractLinks({ html: null, text });
    // Bare-URL regex may match 0 or 1 depending on the trailing char;
    // when it does match, the URL is unparseable and classed 'other'.
    for (const l of links) {
      expect(l.kind).toBe('other');
    }
  });

  it('classifies a UTM-tracked homepage URL as masthead', () => {
    const html = `<a href="https://publisher.com/?utm_source=newsletter&utm_medium=email">logo</a>`;
    expect(extractLinks({ html })).toEqual([
      {
        url: 'https://publisher.com/?utm_source=newsletter&utm_medium=email',
        pos: 0,
        kind: 'masthead',
      },
    ]);
  });

  it('classifies a Mailchimp/HubSpot/Marketo-tracked homepage URL as masthead', () => {
    const html = `
      <a href="https://publisher.com/?mc_cid=abc&mc_eid=def">mc</a>
      <a href="https://another.com/?_hsmi=123&_hsenc=p2A">hs</a>
      <a href="https://third.com/?mkt_tok=eyJpIjo">mkt</a>
      <a href="https://fourth.com/?fbclid=IwAR0">fb</a>
    `;
    const links = extractLinks({ html });
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.kind === 'masthead')).toBe(true);
  });

  it('keeps tracked deep-path URLs as article (path is non-root)', () => {
    const html = `<a href="https://publisher.com/2026/05/article-x?utm_source=newsletter">read</a>`;
    expect(extractLinks({ html })).toEqual([
      {
        url: 'https://publisher.com/2026/05/article-x?utm_source=newsletter',
        pos: 0,
        kind: 'article',
      },
    ]);
  });

  it('does NOT classify homepage URLs as masthead when a non-tracking param is present', () => {
    // `q` is content-meaningful (a search query) — the link likely has
    // intent beyond a logo masthead. Stay conservative and classify
    // as article so the feed can pick it if no deeper article URL exists.
    const html = `<a href="https://publisher.com/?q=hong+kong&utm_source=newsletter">search</a>`;
    expect(extractLinks({ html })).toEqual([
      {
        url: 'https://publisher.com/?q=hong+kong&utm_source=newsletter',
        pos: 0,
        kind: 'article',
      },
    ]);
  });
});

describe('stripBoilerplate — CRLF', () => {
  it('cuts on CRLF-terminated unsubscribe line', () => {
    const text = `Story body\r\nMore body\r\n\r\nUnsubscribe | Manage preferences\r\nFooter`;
    expect(stripBoilerplate(text)).toBe('Story body\r\nMore body');
  });
});

describe('stripBoilerplate — first-line guard', () => {
  // Regression for the 2026-05-16 audit deferred-list item (3),
  // originally flagged in PR #33 review. A newsletter whose absolute
  // first line is a marker (e.g. "View this email in your browser")
  // previously had its entire body cut to empty. The MIN_LEAD_NONEMPTY_LINES
  // guard skips a marker that appears with 0 non-empty lines before it,
  // treating it as preamble rather than the intended footer.

  it('does NOT cut when "view this email" is the absolute first line', () => {
    const text = `View this email in your browser

Story headline
Body paragraph one.
Body paragraph two.`;
    // 0 non-empty lines before the marker -> skipped. Full body preserved.
    expect(stripBoilerplate(text)).toBe(text.trimEnd());
  });

  it('does NOT cut when unsubscribe is the absolute first line', () => {
    const text = `Unsubscribe

Body of the message goes here.
More content.`;
    expect(stripBoilerplate(text)).toBe(text.trimEnd());
  });

  it('does NOT cut when © copyright is the absolute first line', () => {
    const text = `© 2026 Publisher Inc.

Real story headline
Real story body.`;
    expect(stripBoilerplate(text)).toBe(text.trimEnd());
  });

  it('does cut when a marker reappears later as a real footer', () => {
    // The preamble "view this email" on line 1 is skipped by the
    // guard, but the SECOND occurrence near the bottom is honored —
    // pin this behavior so a future refactor doesn't drop multi-match
    // walking.
    const text = `View this email in your browser

Story headline
Body line one.
Body line two.

View this email in your browser online
Footer line.`;
    const out = stripBoilerplate(text);
    expect(out).toContain('Story headline');
    expect(out).toContain('Body line two.');
    expect(out).not.toContain('Footer line.');
  });

  it('still cuts when a marker is on line 2 after a real headline (existing behavior preserved)', () => {
    // The original test at line 26-31 of this file pinned this shape.
    // Threshold=1 keeps the cut here: 1 non-empty line ("Headline") >= 1.
    const text = `Headline
View this email in your browser
…`;
    expect(stripBoilerplate(text)).toBe('Headline');
  });
});
