// Async classifier for inbound-newsletter publishers. Periodically scans
// D1's `unmatched` table and writes both:
//   - sender_map: maps the raw header value to the slug (email-worker
//     hot path uses this on the next inbound)
//   - discovered_publishers: descriptive metadata (name, primary_domain,
//     authority, language, reasoning) — useful for ops and for the
//     future D1 → Postgres `sources` sync
//
// Two-tier resolution:
//   1. Seeded match. The 30 email_bridge rows in
//      migrations/004_seed_email_bridges.sql (post-006 / 008) have
//      canonical slugs that the ingestion-worker polls. If the sender's
//      from_domain matches a seeded publisher's domains_hint, route to
//      the SEEDED slug — no LLM call. Anything else would create a
//      sender_map entry pointing at a slug nothing polls.
//   2. Novel publisher. The LLM gets the full seeded-slug list and is
//      instructed to return the seeded slug if it identifies one of
//      those publishers; otherwise invents a new slug. Web-search is
//      available to it (Anthropic web_search tool, max 3 uses).
//
// Runs unattended on cron (.github/workflows/auto-classify-bridges.yml).
// Idempotent: ON CONFLICT DO NOTHING on both INSERTs.
//
// Resilience: invalid LLM JSON, model errors, malformed slugs etc.
// leave the row in unmatched — next tick retries. No crash, no
// partial writes. Operator can force a slug via register-sender-map.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

interface UnmatchedSender {
  list_id: string | null;
  from_addr: string | null;
  from_domain: string | null;
  subject_sample: string | null;
  raw_headers: string | null;
}

// Email-service-provider domains. When from_domain is one of these, the
// sender is delivering on behalf of the actual publisher — identity lives
// in list_id / List-Post / Reply-To / Sender / subject instead. The LLM
// gets explicit guidance to handle these via web_search.
const TRANSPORT_PROVIDER_DOMAINS = [
  'mcsv.net', 'mcdlv.net', 'list-manage.com', 'campaign-archive.com', 'mailchimp.com',
  'amazonses.com',
  'sendgrid.net', 'sendgrid.com',
  'mailgun.net', 'mailgun.org',
  'sendinblue.com', 'brevo.com',
  'postmarkapp.com', 'mtasv.net',
  'sparkpostmail.com',
  'mandrillapp.com',
  'convertkit.com', 'kit.com',
  'beehiiv.com', 'mail.beehiiv.com',
] as const;

export function isTransportProviderDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return TRANSPORT_PROVIDER_DOMAINS.some(
    (tp) => d === tp || d.endsWith(`.${tp}`),
  );
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

export interface SeededBridge {
  slug: string;
  name: string;
  primary_domain: string;
  authority: number;
  domains_hint: string[];
}

interface SeededBridgesFile {
  bridges: SeededBridge[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WRANGLER_TOML = resolve(REPO_ROOT, 'email-worker', 'wrangler.toml');
const SEEDED_BRIDGES_PATH = resolve(REPO_ROOT, 'config', 'seeded-email-bridges.json');

export function loadSeededBridges(): SeededBridge[] {
  const raw = readFileSync(SEEDED_BRIDGES_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as SeededBridgesFile;
  return parsed.bridges;
}

/**
 * Deterministic first-pass match: if the sender's from_domain matches
 * (exactly or as a subdomain) any seeded publisher's domains_hint,
 * return that seed. Cheaper than an LLM call and unambiguous.
 */
export function matchSeededBridge(
  fromDomain: string | null,
  seeds: SeededBridge[],
): SeededBridge | null {
  if (!fromDomain) return null;
  const d = fromDomain.toLowerCase();
  for (const seed of seeds) {
    for (const hint of seed.domains_hint) {
      const h = hint.toLowerCase();
      if (d === h || d.endsWith(`.${h}`)) return seed;
    }
  }
  return null;
}

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

/**
 * Parse an HTTP Retry-After header into milliseconds. Accepts numeric
 * seconds ("30") and HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 * Returns null on malformed input. A past date returns 0. Exported
 * for testing.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Numeric seconds form.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Math.floor(seconds * 1000);
  }
  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

/**
 * fetch with retry on transient HTTP 429 (Cloudflare API error 971 +
 * Anthropic per-key rate limit), any 5xx (Anthropic 529 overloaded,
 * CF 502/503), and network-level rejections (DNS / ECONNRESET / TLS /
 * AbortError / undici socket timeouts). Exponential backoff
 * 2s / 4s / 8s plus 0-500ms jitter; total wait ~14s before the final
 * attempt. The final response is returned as-is so callers retain
 * their own status-code handling. If the final attempt itself rejects
 * (network error), the rejection is re-thrown.
 *
 * If the server sends a Retry-After header, the wait is
 * max(Retry-After, computed backoff) — we never retry sooner than
 * the server asked, but we do honor our own minimum to avoid a hot
 * loop on a buggy `Retry-After: 0`.
 *
 * 14s is a deliberate ceiling: the cron tick is 30 min, so a workflow
 * that can't recover within 14s should fail cleanly and let the next
 * tick retry from scratch rather than block the runner. Retry-After
 * can push individual waits beyond that.
 *
 * `sleep`, `jitter`, and `fetchImpl` are injectable for unit tests.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    sleep?: (ms: number) => Promise<void>;
    jitter?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const label = opts.label ?? 'fetch';
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * 500));
  const fetchImpl = opts.fetchImpl ?? fetch;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      // Network-level rejection — the same "transient infra blip"
      // class as a 429. Retry until the budget is exhausted, then
      // surface the error to the caller.
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter();
      console.warn(
        `[${label}] fetch threw on attempt ${attempt}/${maxAttempts}: ${err instanceof Error ? err.message : String(err)} — retrying in ${delay}ms`,
      );
      await sleep(delay);
      continue;
    }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === maxAttempts) return res;
    const backoff = baseDelayMs * 2 ** (attempt - 1) + jitter();
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const delay = retryAfter !== null ? Math.max(retryAfter, backoff) : backoff;
    console.warn(
      `[${label}] HTTP ${res.status} on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms`,
    );
    await sleep(delay);
  }
  // Unreachable — the loop always returns or throws on the final attempt.
  throw new Error('fetchWithRetry: exhausted attempts without returning');
}

async function d1Query<T>(
  cfg: CfCfg,
  sql: string,
  params: Array<string | number | null> = [],
): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.dbId}/query`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
    { label: 'd1' },
  );
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

export function buildSystemPrompt(seeds: SeededBridge[]): string {
  const seededList = seeds
    .map((s) => `- slug "${s.slug}" → ${s.name}`)
    .join('\n');
  return `You are a publisher-classification assistant for an editorial-intelligence system. Given the sender headers of an inbound newsletter email, identify the publisher and classify it into a fixed taxonomy.

Use the web_search tool to look up the publisher if you don't recognise the sender. After you have enough information, respond with a single JSON object — no prose before or after, no code fences.

CRITICAL — slug constraint. The following publishers are already seeded in the database with these EXACT slugs:

${seededList}

If the publisher you identify is one of these, you MUST return the exact seeded slug above. The downstream ingestion polls /feeds/<seeded-slug>.xml; returning a different slug ("financial-times" instead of "ft", "wall-street-journal" instead of "wsj") would make the email-worker write under a slug nothing polls.

Only invent a new slug when the publisher is genuinely novel (not on the list above).

CRITICAL — transport providers. Many newsletters are sent via Mailchimp, Amazon SES, SendGrid, Beehiiv, ConvertKit, Mailgun, Sendinblue/Brevo, Postmark, Substack, etc. When from_domain is one of those (mcsv.net / list-manage.com / amazonses.com / sendgrid.net / beehiiv.com / ...), the From: header is the DELIVERY infrastructure, NOT the publisher. The actual publisher identity lives in:

  - list_id (often encodes the publisher: <publisher.us10.list-manage.com>)
  - List-Post / List-Owner / List-Help URLs (publisher's website)
  - Reply-To (often the publisher's own contact)
  - Sender header (sometimes distinct from From)
  - The subject line (often "Publisher Name: ...")
  - Feedback-ID (sometimes encodes the campaign / publisher)

If you see a transport-provider domain, DO NOT classify it as "mailchimp" or "amazon-ses". Instead, examine list_id and the other context headers, then use web_search to identify the real publisher behind the campaign.

Taxonomy:
- primary_domain: one of "scitech" | "economy" | "geopolitics" | "national" | "economics" (academic / international macroeconomics).
- domains: array of 1-3 of the above values; primary_domain MUST be first.
- authority: integer 0-100. Reference points:
    50 = trade press / generic blog
    70 = mainstream news, industry-credible blog (Reuters, Wired, MIT Tech Review)
    80 = specialised expert, peer-reviewed academic (Nature, NBER)
    90 = top-tier authoritative (FT, Bloomberg, AEA P&P)
- language: ISO 639-1 ("en", "zh", etc.).
- slug: lowercase, hyphen-separated, matches /^[a-z0-9-]+$/. Short publisher identifier ("nature-news" not "nature-news-feed-xml").
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
}

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
  seeds: SeededBridge[],
): Promise<Classification | null> {
  const transportNote = isTransportProviderDomain(sender.from_domain)
    ? '\n\nNote: from_domain looks like an email-service-provider — see the CRITICAL transport-providers section in the system prompt. Identify the actual publisher from the context headers below.\n'
    : '';
  const headerLines: string[] = [];
  if (sender.raw_headers) {
    try {
      const obj = JSON.parse(sender.raw_headers) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        headerLines.push(`- ${k}: ${v}`);
      }
    } catch {
      // ignore malformed raw_headers (shouldn't happen — the worker
      // always writes valid JSON.stringify output)
    }
  }
  const userMsg = `Classify this inbound newsletter sender:

- from_addr: ${sender.from_addr ?? '(none)'}
- list_id: ${sender.list_id ?? '(none)'}
- from_domain: ${sender.from_domain ?? '(none)'}
- subject sample: ${sender.subject_sample ?? '(none)'}
${headerLines.length > 0 ? '\nAdditional context headers (often the strongest identity signal when from_domain is a transport provider):\n' + headerLines.join('\n') + '\n' : ''}${transportNote}
Use web_search if needed. Output JSON only.`;

  const res = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(seeds),
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: userMsg }],
      }),
    },
    { label: 'anthropic' },
  );
  if (!res.ok) {
    console.warn(`[classify] anthropic ${res.status}: ${await res.text()}`);
    return null;
  }
  const body = (await res.json()) as AnthropicResponse;
  return extractClassification(body);
}

/**
 * Build a Classification directly from a seeded bridge entry. Used when
 * deterministic domain match succeeded — no LLM call needed.
 */
export function classificationFromSeed(seed: SeededBridge): Classification {
  return {
    slug: seed.slug,
    name: seed.name,
    primary_domain: seed.primary_domain,
    domains: [seed.primary_domain],
    authority: seed.authority,
    language: 'en',
    reasoning: `Matched seeded email_bridge via domains_hint.`,
  };
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
  const seeds = loadSeededBridges();
  console.log(`[classify] loaded ${seeds.length} seeded bridges`);

  // Distinct senders in unmatched. Subject + raw_headers picked from the
  // earliest matching row (MIN(received_at)) so we get a representative
  // sample — multiple rows from the same publisher share an identity.
  const senders = await d1Query<UnmatchedSender>(
    cfg,
    `SELECT list_id,
            from_addr,
            CASE WHEN from_addr IS NULL OR instr(from_addr, '@') = 0 THEN NULL
                 ELSE lower(substr(from_addr, instr(from_addr, '@')+1))
            END AS from_domain,
            MIN(subject) AS subject_sample,
            MIN(raw_headers) AS raw_headers
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

    // Tier 1: deterministic seed match. Saves an LLM call AND guarantees
    // we route under the canonical slug rather than letting the LLM
    // invent a divergent one. Skip for transport-provider domains —
    // they'd never match a seed's domains_hint anyway, and we want the
    // LLM to look at list_id / extra headers, not from_domain alone.
    const seedMatch =
      sender.from_domain && !isTransportProviderDomain(sender.from_domain)
        ? matchSeededBridge(sender.from_domain, seeds)
        : null;
    let cls: Classification | null = null;
    if (seedMatch) {
      cls = classificationFromSeed(seedMatch);
      console.log(
        `[classify] seed-matched ${sender.from_domain} → ${seedMatch.slug} (no LLM)`,
      );
    } else {
      console.log(
        `[classify] asking LLM about ${key.match_field}=${key.match_value} (from ${sender.from_addr ?? '∅'})`,
      );
      try {
        cls = await classifyWithLlm(anthropicKey, sender, seeds);
      } catch (err: unknown) {
        console.warn(
          `[classify] LLM call failed for ${key.match_value}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!cls) {
      skipped.push({ sender, reason: 'LLM returned no valid classification' });
      continue;
    }

    // Both INSERTs are ON CONFLICT DO NOTHING and the source row stays
    // in `unmatched` until the email-worker successfully routes the
    // next inbound, so failing here just defers this sender to the
    // next cron tick. Catch + continue so a single D1 hiccup doesn't
    // abandon the rest of the batch.
    try {
      // Write discovered_publishers — first classification of this slug
      // wins; later re-classifications stay no-op.
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
    } catch (err: unknown) {
      console.warn(
        `[classify] D1 write failed for ${key.match_value}: ${err instanceof Error ? err.message : String(err)} — skipping, next tick retries`,
      );
      skipped.push({ sender, reason: 'D1 write failed' });
      continue;
    }

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
  // Always lowercase the match_value so the sender_map index is built
  // case-folded, matching the lookup path in email-worker/src/sender-map.ts.
  // Mailing-list software inconsistently capitalises List-Id and From
  // addresses; if we stored "News@Anthropic.com" but the next email
  // arrives as "news@anthropic.com" the lookup would silently miss.
  if (sender.list_id)
    return { match_field: 'list_id', match_value: sender.list_id.toLowerCase() };
  if (sender.from_addr)
    return { match_field: 'from_addr', match_value: sender.from_addr.toLowerCase() };
  if (sender.from_domain)
    return { match_field: 'from_domain', match_value: sender.from_domain.toLowerCase() };
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
