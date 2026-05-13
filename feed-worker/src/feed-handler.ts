// Phase 0 stub. Real Atom rendering (RFC 4287) + joined links query land in
// Phase 1 PR 4. The current stub queries `inbox` for the slug and returns a
// minimal but valid Atom document.

import type { Env } from './index';

const SLUG_PATTERN = /^\/feeds\/([a-z0-9-]+)\.xml$/;

interface InboxRow {
  message_id: string;
  received_at: number;
  subject: string | null;
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
    'SELECT message_id, received_at, subject FROM inbox WHERE slug = ? ORDER BY received_at DESC LIMIT 50',
  )
    .bind(slug)
    .all<InboxRow>();

  const entries = (rows.results ?? [])
    .map(
      (r) => `  <entry>
    <id>urn:socialisn2-inbox:${slug}:${escapeXml(r.message_id)}</id>
    <title>${escapeXml(r.subject ?? '(no subject)')}</title>
    <updated>${new Date(r.received_at).toISOString()}</updated>
  </entry>`,
    )
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

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
