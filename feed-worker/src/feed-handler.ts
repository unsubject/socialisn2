// Phase 1 PR 4 production feed handler. Renders the email-worker's D1
// inbox into an Atom feed per slug at
// `https://inbox.socialisn.com/feeds/<slug>.xml`.
//
// Each entry's <link> prefers the first link classified as 'article'
// during email ingestion (see email-worker/src/parse.ts). Falling back
// to any link is intentional — bridge rows written before migration
// 0005 carry the default link_kind='other', and we still want them to
// render with their existing first-extracted URL. Final fallback is
// the synthetic per-message URL for plain-text emails with no URLs.
//
// The article-preferred selection is what makes cross-source url_hash
// dedup actually work: a primary RSS feed and an inbox-bridge entry
// for the same article now share the canonical URL, instead of the
// bridge entry exposing the masthead / view-in-browser link.

import type { Env } from './index';

const SLUG_PATTERN = /^\/feeds\/([a-z0-9-]+)\.xml$/;

interface InboxRow {
  message_id: string;
  received_at: number;
  subject: string | null;
  body_text: string | null;
  chosen_link: string | null;
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

  // COALESCE picks the first 'article' link, falling back to any link
  // (so legacy rows written before migration 0005 still render). Both
  // subqueries are served by idx_inbox_links_message_kind without
  // touching the base table.
  const rows = await env.INBOX_DB.prepare(
    `SELECT
       i.message_id,
       i.received_at,
       i.subject,
       i.body_text,
       COALESCE(
         (SELECT link_url FROM inbox_links
          WHERE slug = i.slug AND message_id = i.message_id AND link_kind = 'article'
          ORDER BY link_pos ASC LIMIT 1),
         (SELECT link_url FROM inbox_links
          WHERE slug = i.slug AND message_id = i.message_id
          ORDER BY link_pos ASC LIMIT 1)
       ) AS chosen_link
     FROM inbox AS i
     WHERE i.slug = ?
     ORDER BY i.received_at DESC
     LIMIT 50`,
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

function buildSyntheticItemLink(slug: string, messageId: string): string {
  // Fallback per-message link when no inbox_links URL was extracted.
  // Stable identifier for the ingestion-worker's url_hash; rss-parser
  // drops Atom entries with no <link> so this must always be non-empty.
  return `https://inbox.socialisn.com/items/${encodeURIComponent(
    slug,
  )}/${encodeURIComponent(messageId)}`;
}

function renderEntry(slug: string, r: InboxRow): string {
  const linkHref = r.chosen_link ?? buildSyntheticItemLink(slug, r.message_id);
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
    <link rel="alternate" href="${escapeXml(linkHref)}"/>
    <updated>${new Date(r.received_at).toISOString()}</updated>${contentBlock}
  </entry>`;
}

function snippet(text: string, max = 480): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + '…';
}

function escapeXml(s: string): string {
  // Audit G-P1-3: strip C0 control characters BEFORE entitising.
  // XML 1.0 (which Atom/RSS use) explicitly forbids U+0000-U+001F
  // except for TAB (0x09), LF (0x0A), CR (0x0D). A NUL or 0x01 from a
  // malformed `=?utf-8?b?...?=` MIME header decode would otherwise
  // flow through the email-worker → D1 → feed-handler unchanged and
  // emit invalid XML — every Atom consumer 500s on parse. The
  // central src/lib/escape.ts does this in the app process; this
  // worker has a divergent local helper that didn't (audit finding).
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return stripped
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
