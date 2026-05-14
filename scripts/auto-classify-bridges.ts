// Async classifier for inbound-newsletter publishers. Periodically scans
// D1's `unmatched` table, asks an LLM with web-search to identify each
// unique sender, and writes both:
//   - sender_map: maps the raw header value to the slug (email-worker
//     hot path uses this on the next inbound)
//   - discovered_publishers: descriptive metadata (name, primary_domain,
//     authority, language, reasoning) — useful for ops and for the
//     future D1 → Postgres `sources` sync
//
// Runs unattended on cron (.github/workflows/auto-classify-bridges.yml).
// Idempotent: ON CONFLICT DO NOTHING on both INSERTs.
//
// No static pattern config — the LLM is the classification authority.
// If you need to FORCE a specific slug for a publisher (operator
// override / correction), run the register-sender-map workflow with
// the explicit values.
//
// Resilience: invalid LLM JSON, model errors, malformed slugs etc.
// all result in the row STAYING in unmatched — next tick retries. No
// crash, no partial writes.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

interface UnmatchedSender {
  list_id: string | null;
  from_addr: string | null;
  from_domain: string | null;
  subject_sample: string | null;
}

interface Classification {
  slug: string;
  name: string;
  primary_domain: string;
  domains: string[];
  authority: number;
  language: string;
  reasoning: string;
}

interface D1QueryResponse<T> {
  result: Array<{ results: T[] }>;
  success: boolean;
  errors?: Array<{ message: string }>;
}

const VALID_DOMAINS = new Set([
  'scitech',
  'economy',
  'geopolitics',
  'national',
  'economics',
]);

const SLUG_RE = /^[a-z0-9-]+$/;

const ANTHROPIC_MODEL = 'claude-opus-4-7';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WRANGLER_TOML = resolve(REPO_ROOT, 'email-worker', 'wrangler.toml');

function loadDatabaseId(): string {
  const toml = readFileSync(WRANGLER_TOML, 'utf-8');
  const match = /^database_id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match || !match[1] || match[1].startsWith('REPLACE_WITH_')) {
    throw new Error(`Cannot read a real database_id from ${WRANGLER_TOML}`);
  }
  return match[1];
}

interface CfCfg {
  token: string;
  accountId: string;
  dbId: string;
}

async function d1Query<T>(
  cfg: CfCfg,
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

const SYSTEM_PROMPT = `You are a publisher-classification assistant for an editorial-intelligence system. Given the sender headers of an inbound newsletter email, identify the publisher and classify it into a fixed taxonomy.

Use the web_search tool to look up the publisher if you don't recognise the sender. After you have enough information, respond with a single JSON object — no prose before or after, no code fences.

Taxonomy:
- primary_domain: one of "scitech" | "economy" | "geopolitics" | "national" | "economics" (academic / international macroeconomics).
- domains: array of 1-3 of the above values; primary_domain MUST be first.
- authority: integer 0-100. Reference points:
    50 = trade press / generic blog
    70 = mainstream news, industry-credible blog (Reuters, Wired, MIT Tech Review)
    80 = specialised expert, peer-reviewed academic (Nature, NBER)
    90 = top-tier authoritative (FT, Bloomberg, AEA P&P)
- language: ISO 639-1 ("en", "zh", etc.).
- slug: lowercase, hyphen-separated, matches /^[a-z0-9-]+$/. Should be a short publisher identifier, NOT a URL slug ("nature-news" not "nature-news-feed-xml").
- reasoning: 1-2 sentence justification, max ~200 chars.

Output JSON shape:
{
  "slug": "publisher-name",
  "name": "Publisher Name",
  "primary_domain": "scitech",
  "domains": ["scitech"],
  "authority": 75,
  "language": "en",
  "reasoning": "Brief reasoning here."
}`;

interface AnthropicContentBlock {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

async function classifyWithLlm(
  anthropicKey: string,
  sender: UnmatchedSender,
): Promise<Classification | null> {
  const userMsg = `Classify this inbound newsletter sender:

- from_addr: ${sender.from_addr ?? '(none)'}
- list_id: ${sender.list_id ?? '(none)'}
- from_domain: ${sender.from_domain ?? '(none)'}
- subject sample: ${sender.subject_sample ?? '(none)'}

Use web_search if needed. Output JSON only.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    console.warn(`[classify] anthropic ${res.status}: ${await res.text()}`);
    return null;
  }
  const body = (await res.json()) as AnthropicResponse;
  return extractClassification(body);
}

export function extractClassification(body: AnthropicResponse): Classification | null {
  // Find the last text block — Claude may emit tool_use blocks before the
  // final text. We want the JSON object that lives in the final text.
  const textBlocks = body.content.filter((b): b is { type: 'text'; text: string } =>
    b.type === 'text' && typeof b.text === 'string',
  );
  const final = textBlocks[textBlocks.length - 1];
  if (!final) return null;
  return parseClassificationJson(final.text);
}

export function parseClassificationJson(text: string): Classification | null {
  // Tolerate wrapping noise. Find the outermost {...} block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  return validateClassification(parsed);
}

export function validateClassification(raw: unknown): Classification | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === 'string' ? r.slug.toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  const name = typeof r.name === 'string' && r.name.length > 0 ? r.name : null;
  const primary_domain = typeof r.primary_domain === 'string' ? r.primary_domain : '';
  if (!VALID_DOMAINS.has(primary_domain)) return null;
  const domains = Array.isArray(r.domains)
    ? r.domains.filter((d): d is string => typeof d === 'string' && VALID_DOMAINS.has(d))
    : [];
  if (domains.length === 0 || domains[0] !== primary_domain) return null;
  let authority = typeof r.authority === 'number' ? Math.round(r.authority) : NaN;
  if (!Number.isFinite(authority)) return null;
  authority = Math.max(0, Math.min(100, authority));
  const language = typeof r.language === 'string' && r.language.length > 0 ? r.language : 'en';
  const reasoning = typeof r.reasoning === 'string' ? r.reasoning.slice(0, 500) : '';
  if (!name) return null;
  return { slug, name, primary_domain, domains, authority, language, reasoning };
}

async function main(): Promise<void> {
  const cfg: CfCfg = {
    token: required('CLOUDFLARE_API_TOKEN'),
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    dbId: loadDatabaseId(),
  };
  const anthropicKey = required('ANTHROPIC_API_KEY');

  // Distinct senders in unmatched, plus a representative subject sample.
  const senders = await d1Query<UnmatchedSender>(
    cfg,
    `SELECT list_id,
            from_addr,
            CASE WHEN from_addr IS NULL OR instr(from_addr, '@') = 0 THEN NULL
                 ELSE lower(substr(from_addr, instr(from_addr, '@')+1))
            END AS from_domain,
            MIN(subject) AS subject_sample
       FROM unmatched
      GROUP BY list_id, from_addr`,
  );
  console.log(`[classify] distinct senders in unmatched: ${senders.length}`);

  if (senders.length === 0) {
    appendSummary(['## auto-classify-bridges', '', 'No unmatched senders. Nothing to do.']);
    return;
  }

  const existingMappings = await d1Query<{ match_field: string; match_value: string }>(
    cfg,
    `SELECT match_field, match_value FROM sender_map`,
  );
  const existingKeys = new Set(
    existingMappings.map((m) => `${m.match_field}|${m.match_value}`),
  );

  const newlyClassified: Array<{ sender: UnmatchedSender; cls: Classification }> = [];
  const skipped: Array<{ sender: UnmatchedSender; reason: string }> = [];

  for (const sender of senders) {
    // Pick the strongest available header to use as the sender_map key,
    // matching the email-worker's lookup precedence (list_id > from_addr
    // > from_domain).
    const key = senderKey(sender);
    if (!key) {
      skipped.push({ sender, reason: 'no usable header' });
      continue;
    }
    const keyStr = `${key.match_field}|${key.match_value}`;
    if (existingKeys.has(keyStr)) {
      skipped.push({ sender, reason: 'already mapped' });
      continue;
    }

    console.log(
      `[classify] asking LLM about ${key.match_field}=${key.match_value} (from ${sender.from_addr ?? '∅'})`,
    );
    let cls: Classification | null = null;
    try {
      cls = await classifyWithLlm(anthropicKey, sender);
    } catch (err: unknown) {
      console.warn(
        `[classify] LLM call failed for ${key.match_value}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!cls) {
      skipped.push({ sender, reason: 'LLM returned no valid classification' });
      continue;
    }

    // Write discovered_publishers (ON CONFLICT DO NOTHING by slug — the
    // first classification wins; later re-classifications of the same
    // slug stay no-op).
    await d1Query(
      cfg,
      `INSERT INTO discovered_publishers
         (slug, name, primary_domain, domains, authority, language, reasoning, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
      [
        cls.slug,
        cls.name,
        cls.primary_domain,
        JSON.stringify(cls.domains),
        cls.authority,
        cls.language,
        cls.reasoning,
        Date.now(),
      ],
    );

    // Write sender_map (the hot path index for the worker).
    await d1Query(
      cfg,
      `INSERT INTO sender_map (match_field, match_value, slug, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [key.match_field, key.match_value, cls.slug, Date.now()],
    );

    newlyClassified.push({ sender, cls });
    existingKeys.add(keyStr);
  }

  console.log(
    `[classify] newly classified ${newlyClassified.length}, skipped ${skipped.length}`,
  );
  writeSummary(newlyClassified, skipped);
}

interface SenderMapKey {
  match_field: 'list_id' | 'from_addr' | 'from_domain';
  match_value: string;
}

export function senderKey(sender: UnmatchedSender): SenderMapKey | null {
  if (sender.list_id) return { match_field: 'list_id', match_value: sender.list_id };
  if (sender.from_addr) return { match_field: 'from_addr', match_value: sender.from_addr };
  if (sender.from_domain) return { match_field: 'from_domain', match_value: sender.from_domain };
  return null;
}

async function appendSummaryAsync(lines: string[]): Promise<void> {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(summary, lines.join('\n') + '\n');
}

function appendSummary(lines: string[]): void {
  void appendSummaryAsync(lines);
}

function writeSummary(
  classified: Array<{ sender: UnmatchedSender; cls: Classification }>,
  skipped: Array<{ sender: UnmatchedSender; reason: string }>,
): void {
  const lines: string[] = [];
  lines.push('## auto-classify-bridges');
  lines.push('');
  lines.push(`Newly classified: **${classified.length}**. Skipped: **${skipped.length}**.`);
  if (classified.length > 0) {
    lines.push('');
    lines.push('### Newly classified');
    lines.push('');
    lines.push('| slug | name | primary_domain | authority | language | reasoning |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of classified) {
      const r = c.cls;
      lines.push(
        `| ${r.slug} | ${r.name} | ${r.primary_domain} | ${r.authority} | ${r.language} | ${r.reasoning} |`,
      );
    }
  }
  if (skipped.length > 0) {
    lines.push('');
    lines.push('### Skipped');
    lines.push('');
    lines.push('| from_addr | list_id | reason |');
    lines.push('|---|---|---|');
    for (const s of skipped.slice(0, 50)) {
      lines.push(`| ${s.sender.from_addr ?? '∅'} | ${s.sender.list_id ?? '∅'} | ${s.reason} |`);
    }
  }
  appendSummary(lines);
}

// Allow the file to be imported by tests without running main.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('[classify] fatal:', err);
    process.exit(1);
  });
}
