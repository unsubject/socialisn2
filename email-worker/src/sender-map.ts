// Sender → slug lookup against the D1 `sender_map` table. Per ADR-003 the
// priority order is List-Id → full From: address → From: domain. Returns
// `null` if no row matches — the caller writes the message to `unmatched`.

export interface SenderHeaders {
  listId: string | null;
  fromAddr: string | null;
  fromDomain: string | null;
}

export async function findSlugByHeaders(
  db: D1Database,
  headers: SenderHeaders,
): Promise<string | null> {
  const candidates: Array<[string, string | null]> = [
    ['list_id', headers.listId],
    ['from_addr', headers.fromAddr],
    ['from_domain', headers.fromDomain],
  ];
  for (const [field, value] of candidates) {
    if (!value) continue;
    const row = await db
      .prepare('SELECT slug FROM sender_map WHERE match_field = ? AND match_value = ?')
      .bind(field, value)
      .first<{ slug: string }>();
    if (row) return row.slug;
  }
  return null;
}

export function domainOf(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  return addr.slice(at + 1).toLowerCase();
}
