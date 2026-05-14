// Unit tests for sender-map.ts. Mocks the D1Database surface to verify
// matching priority and case-folded lookups.

import { describe, expect, it, vi } from 'vitest';

import { domainOf, findSlugByHeaders } from '../src/sender-map';

interface QueryCall {
  sql: string;
  binds: unknown[];
}

interface MockD1Row {
  match_field: string;
  match_value: string; // already lowercased — matches the new write path
  slug: string;
}

function mockDb(rows: MockD1Row[]): {
  db: D1Database;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const db = {
    prepare(sql: string) {
      const stmt: D1PreparedStatement = {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          const [field, value] = binds as [string, string];
          return {
            ...stmt,
            first: vi.fn(async <T>() => {
              const match = rows.find(
                (r) => r.match_field === field && r.match_value.toLowerCase() === value,
              );
              return (match ? { slug: match.slug } : null) as T | null;
            }),
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('findSlugByHeaders — priority order', () => {
  it('matches list_id first when all three headers are present', async () => {
    const { db, calls } = mockDb([
      { match_field: 'list_id', match_value: 'news.example.com', slug: 'by-list' },
      { match_field: 'from_addr', match_value: 'news@example.com', slug: 'by-addr' },
      { match_field: 'from_domain', match_value: 'example.com', slug: 'by-domain' },
    ]);

    const slug = await findSlugByHeaders(db, {
      listId: 'news.example.com',
      fromAddr: 'news@example.com',
      fromDomain: 'example.com',
    });
    expect(slug).toBe('by-list');
    // Only the first (list_id) query should have been issued.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binds[0]).toBe('list_id');
  });

  it('falls back to from_addr when list_id has no match', async () => {
    const { db, calls } = mockDb([
      { match_field: 'from_addr', match_value: 'news@example.com', slug: 'by-addr' },
    ]);

    const slug = await findSlugByHeaders(db, {
      listId: 'news.example.com',
      fromAddr: 'news@example.com',
      fromDomain: 'example.com',
    });
    expect(slug).toBe('by-addr');
    expect(calls.map((c) => c.binds[0])).toEqual(['list_id', 'from_addr']);
  });

  it('falls back to from_domain last', async () => {
    const { db, calls } = mockDb([
      { match_field: 'from_domain', match_value: 'example.com', slug: 'by-domain' },
    ]);

    const slug = await findSlugByHeaders(db, {
      listId: null,
      fromAddr: null,
      fromDomain: 'example.com',
    });
    expect(slug).toBe('by-domain');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binds[0]).toBe('from_domain');
  });

  it('returns null when no row matches any header', async () => {
    const { db } = mockDb([
      { match_field: 'from_domain', match_value: 'other.com', slug: 'other' },
    ]);

    const slug = await findSlugByHeaders(db, {
      listId: 'a',
      fromAddr: 'b@c.com',
      fromDomain: 'c.com',
    });
    expect(slug).toBeNull();
  });
});

describe('findSlugByHeaders — case insensitivity', () => {
  it('matches when the inbound list_id is uppercase but the stored value is lowercase', async () => {
    const { db, calls } = mockDb([
      { match_field: 'list_id', match_value: 'news.example.com', slug: 'ok' },
    ]);

    const slug = await findSlugByHeaders(db, {
      listId: 'News.Example.COM',
      fromAddr: null,
      fromDomain: null,
    });
    expect(slug).toBe('ok');
    // The bound value passed to D1 should be lowercased — the SQL also
    // wraps match_value in LOWER() so mixed-case stored rows still match.
    expect(calls[0]!.binds[1]).toBe('news.example.com');
  });

  it('matches when the stored value is mixed-case (pre-migration data)', async () => {
    // Simulate a row that pre-dates the lowercase migration.
    const { db } = mockDb([
      { match_field: 'from_addr', match_value: 'News@Anthropic.com', slug: 'anthropic' },
    ]);

    const slug = await findSlugByHeaders(db, {
      listId: null,
      fromAddr: 'news@anthropic.com',
      fromDomain: null,
    });
    expect(slug).toBe('anthropic');
  });

  it('uses LOWER(match_value) = ? in the SQL', async () => {
    const { db, calls } = mockDb([]);
    await findSlugByHeaders(db, {
      listId: 'x',
      fromAddr: null,
      fromDomain: null,
    });
    expect(calls[0]!.sql).toContain('LOWER(match_value)');
  });
});

describe('domainOf', () => {
  it('returns the lowercased domain portion of an address', () => {
    expect(domainOf('User@Example.COM')).toBe('example.com');
  });

  it('returns null for null / missing-@', () => {
    expect(domainOf(null)).toBeNull();
    expect(domainOf('no-at-here')).toBeNull();
  });
});
