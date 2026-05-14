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
      { url: 'https://example.com/one', pos: 0 },
      { url: 'https://example.com/two', pos: 1 },
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
      { url: 'https://example.com/keep', pos: 0 },
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
      { url: 'https://example.com/article', pos: 0 },
    ]);
  });

  it('dedups identical URLs', () => {
    const html = `
      <a href="https://example.com/x">a</a>
      <a href="https://example.com/x">b</a>
      <a href="https://example.com/y">c</a>
    `;
    expect(extractLinks({ html })).toEqual([
      { url: 'https://example.com/x', pos: 0 },
      { url: 'https://example.com/y', pos: 1 },
    ]);
  });

  it('falls back to bare-URL regex on plain text', () => {
    const text = `Check out https://example.com/news and https://example.com/post for more.`;
    expect(extractLinks({ html: null, text })).toEqual([
      { url: 'https://example.com/news', pos: 0 },
      { url: 'https://example.com/post', pos: 1 },
    ]);
  });

  it('prefers HTML when both are provided', () => {
    const html = `<a href="https://example.com/html-link">x</a>`;
    const text = `https://example.com/text-link`;
    expect(extractLinks({ html, text })).toEqual([
      { url: 'https://example.com/html-link', pos: 0 },
    ]);
  });

  it('ignores case-variant unsubscribe URLs', () => {
    const html = `<a href="https://example.com/Unsubscribe?x=y">u</a>`;
    expect(extractLinks({ html })).toEqual([]);
  });
});
