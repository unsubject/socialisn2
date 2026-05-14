// Phase 0 stub. Phase 1 PR 4 swaps the email-handler over to a real
// postal-mime parse and link extraction; this file's render expands to
// emit body_text in <content type="html"> at that point. For now it
// renders the columns the email-handler stub actually writes (subject +
// body_text + body_html when present) into a valid Atom entry.
//
// Each entry carries a synthetic <link href="…/items/<slug>/<msgid>"> —
// stable per inbound email (Message-Id is RFC 5322 globally unique-ish),
// suitable as the url_hash key downstream and as the externalId fallback
// for rss-parser, which drops Atom entries with no <link>.

import type { Env } from './index';

const SLUG_PATTERN = /^\/feeds\/([a-z0-9-]+)\.xml$/;

interface InboxRow {
  message_id: string;
  received_at: number;
  subject: string | null;
  body_text: string | null;
}

export async function handleFetch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const match = SLUG_PATTERN.exec(url.pathname);
  if (!match) {
    return new Response('Not Found', { status: 404 });
  }
  const slug = match[1] ?? 'unknown';

  const rows = await env.INBOX_DB.prepare(
    'SELECT message_id, received_at, subject, body_text FROM inbox WHERE slug = ? ORDER BY received_at DESC LIMIT 50',
  )
    .bind(slug)
    .all<InboxRow>();

  const entries = (rows.results ?? [])
    .map((r) => renderEntry(slug, r))
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${slug}</title>
  <id>https://inbox.socialisn.com/feeds/${slug}.xml</id>
  <updated>${new Date().toISOString()}</updated>
${entries}
</feed>
`;

  return new Response(body, {
    headers: {
      'content-type': 'application/atom+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

function buildItemLink(slug: string, messageId: string): string {
  // Synthetic per-message link. Stable identifier for the
  // ingestion-worker's url_hash; not currently served by feed-worker
  // (could grow into a /items/<slug>/<msgid> read-only HTML view later).
  return `https://inbox.socialisn.com/items/${encodeURIComponent(
    slug,
  )}/${encodeURIComponent(messageId)}`;
}

function renderEntry(slug: string, r: InboxRow): string {
  // Atom <content type="text"> rather than <summary>: rss-parser only
  // populates item.content from <content> elements by default. Using
  // <content> means the ingestion-worker sees the snippet without needing
  // a custom-field mapping on the parser side.
  const contentBlock = r.body_text
    ? `\n    <content type="text">${escapeXml(snippet(r.body_text))}</content>`
    : '';
  return `  <entry>
    <id>urn:socialisn2-inbox:${escapeXml(slug)}:${escapeXml(r.message_id)}</id>
    <title>${escapeXml(r.subject ?? '(no subject)')}</title>
    <link rel="alternate" href="${escapeXml(buildItemLink(slug, r.message_id))}"/>
    <updated>${new Date(r.received_at).toISOString()}</updated>${contentBlock}
  </entry>`;
}

function snippet(text: string, max = 480): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + '…';
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
