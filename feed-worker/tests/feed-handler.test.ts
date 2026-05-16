// Tests for the production Atom feed handler. Uses a hand-rolled D1
// mock so we can run under plain Node + vitest without Miniflare.
//
// We don't simulate the full Workers runtime — the handler only touches
// `env.INBOX_DB.prepare(sql).bind(...).all<T>()` and standard `Request`/
// `Response`, both of which are available in modern Node.

import { describe, expect, it } from 'vitest';

import { handleFetch } from '../src/feed-handler';
import type { Env } from '../src/index';

interface MockRow {
  message_id: string;
  received_at: number;
  subject: string | null;
  body_text: string | null;
  first_link: string | null;
}

function makeEnv(rows: MockRow[]): Env {
  // Minimal D1 mock — only the prepare/bind/all path is exercised by the
  // handler. We don't try to interpret the SQL; every prepare returns the
  // rows the test set up.
  const db = {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            all<T>(): Promise<{ results: T[]; success: boolean; meta: object }> {
              return Promise.resolve({
                results: rows as unknown as T[],
                success: true,
                meta: {},
              });
            },
          };
        },
      };
    },
  };
  return { INBOX_DB: db as unknown as D1Database };
}

const mockCtx = {} as ExecutionContext;

describe('handleFetch', () => {
  it('returns 404 for paths that do not match /feeds/<slug>.xml', async () => {
    const env = makeEnv([]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/'),
      env,
      mockCtx,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for /feeds/<slug>.html (only .xml is served)', async () => {
    const env = makeEnv([]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/feeds/anthropic.html'),
      env,
      mockCtx,
    );
    expect(res.status).toBe(404);
  });

  it('returns a valid Atom feed with the slug in the title + id', async () => {
    const env = makeEnv([]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/feeds/anthropic.xml'),
      env,
      mockCtx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/atom\+xml/);
    const body = await res.text();
    expect(body).toContain('<title>anthropic</title>');
    expect(body).toContain(
      '<id>https://inbox.socialisn.com/feeds/anthropic.xml</id>',
    );
  });

  it("emits the row's first_link as <link href> when present", async () => {
    const env = makeEnv([
      {
        message_id: '<m1@example.com>',
        received_at: Date.parse('2026-05-15T10:00:00Z'),
        subject: 'Anthropic news',
        body_text: 'hello',
        first_link: 'https://www.anthropic.com/news/article-x',
      },
    ]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/feeds/anthropic.xml'),
      env,
      mockCtx,
    );
    const body = await res.text();
    expect(body).toContain(
      'href="https://www.anthropic.com/news/article-x"',
    );
    // The synthetic fallback URL must NOT appear when a real link is present.
    expect(body).not.toContain('inbox.socialisn.com/items/anthropic/');
  });

  it('falls back to the synthetic /items/<slug>/<msgid> link when first_link is null', async () => {
    const env = makeEnv([
      {
        message_id: '<m1@example.com>',
        received_at: Date.parse('2026-05-15T10:00:00Z'),
        subject: 'plain text email',
        body_text: 'no links in this one',
        first_link: null,
      },
    ]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/feeds/anthropic.xml'),
      env,
      mockCtx,
    );
    const body = await res.text();
    expect(body).toContain(
      'href="https://inbox.socialisn.com/items/anthropic/',
    );
  });

  it('escapes XML special characters in subject and message_id', async () => {
    const env = makeEnv([
      {
        message_id: '<m&1@example.com>',
        received_at: Date.parse('2026-05-15T10:00:00Z'),
        subject: 'Q&A: Anthropic <2026>',
        body_text: null,
        first_link: 'https://example.com/?a=1&b=2',
      },
    ]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/feeds/anthropic.xml'),
      env,
      mockCtx,
    );
    const body = await res.text();
    expect(body).toContain('Q&amp;A: Anthropic &lt;2026&gt;');
    expect(body).toContain('m&amp;1@example.com');
    expect(body).toContain('a=1&amp;b=2');
  });

  it('emits an empty feed (still valid Atom) when no rows exist', async () => {
    const env = makeEnv([]);
    const res = await handleFetch(
      new Request('https://inbox.socialisn.com/feeds/empty-slug.xml'),
      env,
      mockCtx,
    );
    const body = await res.text();
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(body).not.toContain('<entry>');
  });
});
