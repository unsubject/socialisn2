// Phase 1 PR 4 production feed handler. Renders the email-worker's D1
// inbox into an Atom feed per slug at
// `https://inbox.socialisn.com/feeds/<slug>.xml`.
//
// Each entry's <link> uses the first URL extracted into inbox_links
// during email ingestion — typically the canonical article URL — so the
// ingestion-worker's url_hash dedup catches the same story arriving via
// a primary RSS feed. When no link was extracted (rare; usually means a
// plain-text email with no URLs), we fall back to the synthetic per-
// message URL so rss-parser still has a <link> to populate from.

import type { Env } from './index';

const SLUG_PATTERN = /^\/feeds\/([a-z0-9-]+)\.xml$/;

interface InboxRow {
  message_id: string;
  received_at: number;
  subject: string | null;
  body_text: string | null;
  first_link: string | null;
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

  // Pull the lowest-positioned (i.e. first-in-body) extracted link via a
  // correlated subquery so we avoid a second round-trip per entry. D1
  // supports subselects; LEFT-JOIN + ORDER BY/LIMIT IN ... would also
  // work but is harder to read.
  const rows = await env.INBOX_DB.prepare(
    `SELECT
       i.message_id,
       i.received_at,
       i.subject,
       i.body_text,
       (SELECT link_url FROM inbox_links
        WHERE slug = i.slug AND message_id = i.message_id
        ORDER BY link_pos ASC LIMIT 1) AS first_link
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
  // Prefer the real article URL extracted into inbox_links so cross-source
  // url_hash dedup catches the same story arriving via a primary RSS
  // source. Fall back to the synthetic link only when no link was
  // extracted (e.g. a plain-text email with no URLs in the body).
  const linkHref = r.first_link ?? buildSyntheticItemLink(slug, r.message_id);
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
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
