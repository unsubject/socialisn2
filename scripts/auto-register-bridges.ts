// Auto-register sender_map rows from accumulated unmatched rows in D1,
// driven by the patterns in config/email-bridge-patterns.json.
//
// Runs unattended on cron (.github/workflows/auto-register-bridges.yml).
// Re-runs are no-ops via ON CONFLICT DO NOTHING. New publishers get
// auto-routed on the next tick after a config update or the first
// inbound email matching an existing pattern.
//
// Why not just do this from email-worker itself? Two reasons. (a) The
// patterns config lives in the repo, so it gets PR-reviewed. Embedding
// it in the Worker env would either need a redeploy per change or a
// secondary D1 table. (b) The Worker should stay fast — its hot path
// is a single sender_map lookup. The auto-register loop is operations
// scaffolding around it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

interface PatternBlock {
  slug: string;
  match_field: 'list_id' | 'from_addr' | 'from_domain';
  values: string[];
}

interface PatternsFile {
  patterns: PatternBlock[];
}

interface UnmatchedRow {
  id: number;
  list_id: string | null;
  from_addr: string | null;
  from_domain: string | null;
}

interface SenderMapRow {
  match_field: string;
  match_value: string;
  slug: string;
}

interface D1QueryResponse<T> {
  result: Array<{ results: T[]; success?: boolean }>;
  success: boolean;
  errors?: Array<{ message: string }>;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'config', 'email-bridge-patterns.json');
const WRANGLER_TOML = resolve(REPO_ROOT, 'email-worker', 'wrangler.toml');

function loadPatterns(): PatternBlock[] {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as PatternsFile;
  return parsed.patterns;
}

function loadDatabaseId(): string {
  const toml = readFileSync(WRANGLER_TOML, 'utf-8');
  const match = /^database_id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match || !match[1] || match[1].startsWith('REPLACE_WITH_')) {
    throw new Error(
      `Cannot read a real database_id from ${WRANGLER_TOML} (got ${match?.[1] ?? '∅'})`,
    );
  }
  return match[1];
}

async function d1Query<T>(
  cfg: { token: string; accountId: string; dbId: string },
  sql: string,
  params: Array<string | number | null> = [],
): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.dbId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 ${res.status}: ${text}`);
  }
  const body = (await res.json()) as D1QueryResponse<T>;
  if (!body.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(body.errors)}`);
  }
  return body.result[0]?.results ?? [];
}

function findMatchingSlug(
  row: UnmatchedRow,
  patterns: PatternBlock[],
): { slug: string; match_field: string; match_value: string } | null {
  for (const block of patterns) {
    const candidate = (() => {
      switch (block.match_field) {
        case 'list_id':
          return row.list_id?.toLowerCase() ?? null;
        case 'from_addr':
          return row.from_addr?.toLowerCase() ?? null;
        case 'from_domain':
          return row.from_domain;
      }
    })();
    if (!candidate) continue;
    for (const value of block.values) {
      if (candidate === value.toLowerCase()) {
        return { slug: block.slug, match_field: block.match_field, match_value: value };
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const cfg = {
    token: required('CLOUDFLARE_API_TOKEN'),
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    dbId: loadDatabaseId(),
  };
  const patterns = loadPatterns();
  console.log(`[auto-register] loaded ${patterns.length} pattern blocks`);

  // Pull distinct (list_id, from_addr, from_domain) triples from unmatched —
  // dedup at the source so we don't INSERT N copies of the same mapping.
  const rows = await d1Query<UnmatchedRow>(
    cfg,
    `SELECT MIN(id) AS id,
            list_id,
            from_addr,
            CASE
              WHEN from_addr IS NULL OR instr(from_addr, '@') = 0 THEN NULL
              ELSE lower(substr(from_addr, instr(from_addr, '@')+1))
            END AS from_domain
       FROM unmatched
      GROUP BY list_id, from_addr`,
  );
  console.log(`[auto-register] unmatched distinct sender groups: ${rows.length}`);

  // Existing mappings — used to report "already registered" cleanly.
  const existing = await d1Query<SenderMapRow>(
    cfg,
    `SELECT match_field, match_value, slug FROM sender_map`,
  );
  const existingKey = new Set(existing.map((r) => `${r.match_field}|${r.match_value}`));

  const toInsert = new Map<string, { match_field: string; match_value: string; slug: string }>();
  const unmatchedReport: Array<{ list_id: string | null; from_addr: string | null }> = [];

  for (const row of rows) {
    const hit = findMatchingSlug(row, patterns);
    if (!hit) {
      unmatchedReport.push({ list_id: row.list_id, from_addr: row.from_addr });
      continue;
    }
    const key = `${hit.match_field}|${hit.match_value}`;
    if (existingKey.has(key) || toInsert.has(key)) continue;
    toInsert.set(key, hit);
  }

  console.log(
    `[auto-register] new mappings to register: ${toInsert.size} (skipping ${unmatchedReport.length} unknown senders, ${existing.length} already in sender_map)`,
  );

  for (const entry of toInsert.values()) {
    console.log(
      `[auto-register] registering ${entry.match_field}=${entry.match_value} → ${entry.slug}`,
    );
    await d1Query(
      cfg,
      `INSERT INTO sender_map (match_field, match_value, slug, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [entry.match_field, entry.match_value, entry.slug, Date.now()],
    );
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const { appendFileSync } = await import('node:fs');
    const lines: string[] = [];
    lines.push('## auto-register-bridges');
    lines.push('');
    lines.push(
      `Distinct sender groups in unmatched: **${rows.length}**. Already-registered: **${existing.length}**. Newly registered: **${toInsert.size}**.`,
    );
    if (toInsert.size > 0) {
      lines.push('');
      lines.push('### Newly registered');
      lines.push('');
      lines.push('| match_field | match_value | slug |');
      lines.push('|---|---|---|');
      for (const e of toInsert.values()) {
        lines.push(`| ${e.match_field} | ${e.match_value} | ${e.slug} |`);
      }
    }
    if (unmatchedReport.length > 0) {
      lines.push('');
      lines.push('### Unknown senders (no pattern match — leave in unmatched or extend config)');
      lines.push('');
      lines.push('| list_id | from_addr |');
      lines.push('|---|---|');
      for (const u of unmatchedReport.slice(0, 50)) {
        lines.push(`| ${u.list_id ?? '∅'} | ${u.from_addr ?? '∅'} |`);
      }
    }
    lines.push('');
    appendFileSync(summary, lines.join('\n'));
  }
}

main().catch((err: unknown) => {
  console.error('[auto-register] fatal:', err);
  process.exit(1);
});
