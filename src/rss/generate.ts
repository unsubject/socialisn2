// RSS 2.0 generator for Socialisn2's static feeds (SPEC §11.2 +
// redesign P0.3, docs/redesign/2026-07-05 §5.1).
//
// Writes 8 files to `outputDir`:
//
//   all.xml          — master feed, every `new` non-expired candidate
//   <domain>.xml × 5 — one per SPEC §3 domain, filtered on primary_domain
//   pulse.xml        — the Daily Pulse: append-only, attention-budgeted
//                      (≤ PULSE_TOP_N entries per run from pulse_entries)
//   brief.xml        — the Weekly Ideation Brief: one entry per week,
//                      full pitch HTML in content:encoded (P1)
//
// Per-domain feeds use `primary_domain` (strict), NOT the multi-label
// `domains[]` array. The multi-label set is for search / filter UI
// (Phase 4 PR 2-3); subscribers to /economy.xml expect items that ARE
// economy, not items that are *also* economy. Each candidate appears in
// exactly one domain feed + the master.
//
// Items are filtered by `status='new' AND expires_at > NOW()` — the
// `expires_at` lazy filter is the contract, no sweeper cron is needed
// (per ADR-009 spirit: prefer schema/query enforcement over scheduled
// cleanup). Ordering: `created_at DESC`, capped at FEED_ITEM_LIMIT so a
// runaway scoring run can't blow up feed file sizes.
//
// Atomic file writes: write to `<name>.tmp` then `fs.rename` to the
// final path. POSIX guarantees rename is atomic on the same filesystem,
// so a concurrent nginx/Caddy reader either sees the prior version (its
// open fd stays valid) or the new one — never a half-written byte.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { DOMAIN_CONFIGS } from '../../config/domains.js';
import type { Db } from '../db/client.js';
import { escapeXml } from '../lib/escape.js';
import { PULSE_TOP_N } from './pulse.js';
import { renderBriefBodyHtml, type BriefPitch } from '../scoring/brief.js';

/**
 * Cap on items per feed. RSS readers tolerate larger feeds, but capping
 * keeps the static file size bounded and keeps the feed scannable in
 * the typical reader UI. Caller can override per-feed in tests.
 */
const FEED_ITEM_LIMIT = 50;

/**
 * Custom namespace URI used for `<socialisn2:temperature>` etc. Stable
 * URN rather than a URL so deploys to different hosts don't break
 * subscriber-side schema cache assumptions. The trailing date is a
 * version marker — bump if the namespace fields ever change shape.
 */
const SOCIALISN2_NS = 'urn:socialisn2:rss:2026-05';

type CandidateRow = {
  id: string;
  headline: string;
  context_summary: string;
  primary_domain: string;
  keywords: string[];
  tags: string[];
  temperature: string;
  trajectory: string;
  is_exclusive: boolean;
  archive_overlap: number;
  created_at: string;
};

type PulseRow = {
  id: string;
  kind: string;
  candidate_id: string | null;
  title: string;
  description: string;
  created_at: string;
};

type BriefRow = {
  id: string;
  week_of: string;
  pitches: BriefPitch[];
  created_at: string;
  updated_at: string | null;
};

export interface GenerateOptions {
  /** Override item cap. Default FEED_ITEM_LIMIT. */
  limit?: number;
}

/**
 * Build, write, and atomically rename all 6 feed files. Returns the
 * absolute paths of the written files in deterministic order
 * (`all`, then domains in SPEC §3 table order).
 */
export async function generateAllFeeds(
  db: Db,
  outputDir: string,
  publicHost: string,
  opts: GenerateOptions = {},
): Promise<string[]> {
  const limit = opts.limit ?? FEED_ITEM_LIMIT;
  await mkdir(outputDir, { recursive: true });

  // Audit G-P1-1: partial-failure-tolerant. Pre-audit, a throw from
  // any single fetchFeedItems / renderFeed / write call rejected the
  // whole function — the feeds written so far were fresh, the
  // remaining ones kept yesterday's bytes on disk, and the
  // orchestrator's RSS regenerate hook saw a single failure rather
  // than "5/6 succeeded". Now each feed is written independently;
  // failures are collected and re-thrown as a joined error at the
  // end (after every feed has been attempted), so a transient
  // failure on one feed doesn't gate the other five.
  //
  // Order is also flipped: per-domain feeds are written FIRST, master
  // 'all' is written LAST. That way a partial failure leaves an
  // older-than-fresh master rather than the inverse (which would
  // confuse a subscriber that sees a master pointing at items absent
  // from per-domain feeds).
  // Two separate concerns:
  //   - WRITE order is per-domain first, master last (rationale above).
  //   - RETURN order is master first, per-domain after — the documented
  //     contract (`[all.xml, economy.xml, ...]`) that callers + the
  //     existing tests pin. Codex review on PR #114 caught the regression
  //     where I'd let return order follow write order; fixing here by
  //     keying paths into a dict and rebuilding the returned array in the
  //     documented order regardless of write timing.
  const writtenByFeed = new Map<string, string>();
  const failures: Array<{ feed: string; error: Error }> = [];

  const writeOne = async (
    slug: string,
    domain: string | null,
  ): Promise<void> => {
    try {
      const items = await fetchFeedItems(db, domain, limit);
      const filePath = join(outputDir, `${slug}.xml`);
      await atomicWriteXml(filePath, renderFeed(slug, items, publicHost));
      writtenByFeed.set(slug, filePath);
    } catch (err) {
      failures.push({
        feed: slug,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  };

  // Per-domain feeds FIRST. Order from DOMAIN_CONFIGS keys (matches
  // SPEC §3 table order — economy, economics, scitech, geopolitics,
  // national).
  for (const domain of Object.keys(DOMAIN_CONFIGS) as Array<keyof typeof DOMAIN_CONFIGS>) {
    await writeOne(domain, domain);
  }
  // Daily Pulse (P0.3) — a different query shape (pulse_entries, not
  // the live candidate pool), so it bypasses writeOne's fetch but keeps
  // the same partial-failure accounting.
  try {
    const pulseRows = await fetchPulseItems(db, limit);
    const pulsePath = join(outputDir, 'pulse.xml');
    await atomicWriteXml(pulsePath, renderPulseFeed(pulseRows, publicHost));
    writtenByFeed.set('pulse', pulsePath);
  } catch (err) {
    failures.push({
      feed: 'pulse',
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
  // Weekly Ideation Brief (P1) — one entry per week from `briefs`.
  try {
    const briefRows = await fetchBriefItems(db, BRIEF_FEED_LIMIT);
    const briefPath = join(outputDir, 'brief.xml');
    await atomicWriteXml(briefPath, renderBriefFeed(briefRows, publicHost));
    writtenByFeed.set('brief', briefPath);
  } catch (err) {
    failures.push({
      feed: 'brief',
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
  // Master 'all' feed last, per the write-order rationale above.
  await writeOne('all', null);

  if (failures.length > 0) {
    const summary = failures
      .map((f) => `${f.feed}: ${f.error.message.slice(0, 200)}`)
      .join('; ');
    throw new Error(
      `generateAllFeeds: ${failures.length}/${
        failures.length + writtenByFeed.size
      } feeds failed: ${summary}`,
    );
  }

  // Documented return order: master first, then domains in SPEC §3
  // table order, then pulse, then brief. Tests pin this; external
  // callers may also.
  const orderedSlugs = [
    'all',
    ...(Object.keys(DOMAIN_CONFIGS) as string[]),
    'pulse',
    'brief',
  ];
  return orderedSlugs.map((s) => writtenByFeed.get(s)!).filter(Boolean);
}

/**
 * Exported for the orchestrator hook to use the same one-domain query
 * shape (useful if a future "only regenerate this one feed" optimisation
 * lands; ignored today). NOT for ad-hoc external consumption — the
 * candidate fetch query couples to SPEC §11.2 specifically.
 */
export async function fetchFeedItems(
  db: Db,
  primaryDomain: string | null,
  limit: number,
): Promise<CandidateRow[]> {
  // `expires_at > NOW()` is the lazy "is this candidate still relevant"
  // gate per SPEC §11.1 (status transitions). No sweeper cron exists —
  // the filter is the contract.
  // Redesign P0.2: best-first, not newest-first. curation_score was
  // computed and stored on every candidate since Phase 3 but never used
  // for ordering — the day's best item could fall out of the 50-item
  // window under newer mediocre ones. Recency is the tiebreak.
  if (primaryDomain === null) {
    return db.execute<CandidateRow>(sql`
      SELECT id, headline, context_summary, primary_domain,
             keywords, tags, temperature, trajectory,
             is_exclusive, archive_overlap, created_at
      FROM candidates
      WHERE status = 'new'
        AND expires_at > NOW()
      ORDER BY curation_score DESC, created_at DESC
      LIMIT ${limit}
    `);
  }
  return db.execute<CandidateRow>(sql`
    SELECT id, headline, context_summary, primary_domain,
           keywords, tags, temperature, trajectory,
           is_exclusive, archive_overlap, created_at
    FROM candidates
    WHERE status = 'new'
      AND expires_at > NOW()
      AND primary_domain = ${primaryDomain}
    ORDER BY curation_score DESC, created_at DESC
    LIMIT ${limit}
  `);
}

/**
 * Newest window of Daily Pulse entries. Append-only snapshots
 * (migration 019) — no expiry filter: a pulse entry is a moment-in-time
 * editorial selection, and readers page through history naturally.
 */
export async function fetchPulseItems(db: Db, limit: number): Promise<PulseRow[]> {
  return db.execute<PulseRow>(sql`
    SELECT id, kind, candidate_id, title, description, created_at
    FROM pulse_entries
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
}

/** ~3 months of Sunday briefs per feed window. */
const BRIEF_FEED_LIMIT = 12;

export async function fetchBriefItems(db: Db, limit: number): Promise<BriefRow[]> {
  return db.execute<BriefRow>(sql`
    SELECT id, week_of, pitches, created_at, updated_at
    FROM briefs
    ORDER BY week_of DESC
    LIMIT ${limit}
  `);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderBriefFeed(items: BriefRow[], publicHost: string): string {
  const baseUrl = `https://${publicHost}`;
  const feedLink = `${baseUrl}/feeds/brief.xml`;
  const itemsXml = items
    .map((b) => {
      // week_of comes back as a date string (YYYY-MM-DD); normalise in
      // case the driver returns a full timestamp.
      const weekOf = String(b.week_of).slice(0, 10);
      const hooks = b.pitches.map((p) => p.hook).join(' · ');
      const bodyHtml = renderBriefBodyHtml(b.pitches);
      const pubDate = new Date(b.updated_at ?? b.created_at).toUTCString();
      return `    <item>
      <title>Weekly Ideation Brief — ${escapeXml(weekOf)} (${b.pitches.length} pitches)</title>
      <description>${escapeXml(hooks)}</description>
      <content:encoded>${escapeXml(bodyHtml)}</content:encoded>
      <link>${escapeXml(`${baseUrl}/brief/${weekOf}`)}</link>
      <guid isPermaLink="false">${escapeXml(b.id)}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Socialisn2 — Weekly Ideation Brief</title>
    <link>${escapeXml(feedLink)}</link>
    <atom:link href="${escapeXml(feedLink)}" rel="self" type="application/rss+xml"/>
    <description>Episode pitches from the week's signal: hook, thesis, steelman, why-now, evidence.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}

function renderPulseFeed(items: PulseRow[], publicHost: string): string {
  const baseUrl = `https://${publicHost}`;
  const feedLink = `${baseUrl}/feeds/pulse.xml`;
  const itemsXml = items
    .map((it) => {
      // Candidate entries link to the rendered detail page; the waves
      // entry has no detail page — link it to the site root.
      const link =
        it.kind === 'candidate' && it.candidate_id
          ? `${baseUrl}/c/${it.candidate_id}`
          : `${baseUrl}/`;
      return `    <item>
      <title>${escapeXml(it.title)}</title>
      <description>${escapeXml(it.description)}</description>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(it.id)}</guid>
      <pubDate>${new Date(it.created_at).toUTCString()}</pubDate>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Socialisn2 — Daily Pulse</title>
    <link>${escapeXml(feedLink)}</link>
    <atom:link href="${escapeXml(feedLink)}" rel="self" type="application/rss+xml"/>
    <description>The attention-budgeted shortlist: at most ${PULSE_TOP_N} per run, ranked, with an angle line each.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}

function renderFeed(
  feedSlug: string,
  items: CandidateRow[],
  publicHost: string,
): string {
  const baseUrl = `https://${publicHost}`;
  const feedTitle =
    feedSlug === 'all'
      ? 'Socialisn2 — All Candidates'
      : `Socialisn2 — ${feedSlug}`;
  const feedLink = `${baseUrl}/feeds/${feedSlug}.xml`;
  const feedDescription =
    feedSlug === 'all'
      ? 'Editorial-intelligence candidates across all domains.'
      : `Editorial-intelligence candidates in ${feedSlug}.`;

  // Always emit a valid RSS document — an empty feed has zero <item>
  // entries but a full channel header. Don't 404 the file or write
  // zero bytes; consumers polling for updates need a valid response.
  const itemsXml = items.map((it) => renderItem(it, baseUrl)).join('\n');
  // Audit G-P1-2: RSS 2.0 best practice requires <atom:link
  // rel="self"/> inside <channel> so polling clients can discover
  // the canonical feed URL. The W3C feed validator warns without
  // it; some readers also fall back to <link> as identity, which
  // collides with the human-facing link. Declare the atom namespace
  // on the root and emit the self-link.
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:socialisn2="${SOCIALISN2_NS}" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${escapeXml(feedLink)}</link>
    <atom:link href="${escapeXml(feedLink)}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(feedDescription)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}

function renderItem(item: CandidateRow, baseUrl: string): string {
  const link = `${baseUrl}/c/${item.id}`;
  // Categories: union of keywords + tags. SPEC §11.2 says both go in.
  // De-dupe in case a model emits the same string in both.
  const categories = Array.from(new Set([...item.keywords, ...item.tags]));
  const categoryXml = categories
    .map((c) => `      <category>${escapeXml(c)}</category>`)
    .join('\n');
  // pubDate per RFC 822, which the spec requires (RSS 2.0).
  // `db.execute<T>` returns timestamptz as ISO string — wrap with Date.
  const pubDate = new Date(item.created_at).toUTCString();
  return `    <item>
      <title>${escapeXml(item.headline)}</title>
      <description>${escapeXml(item.context_summary)}</description>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(item.id)}</guid>
      <pubDate>${pubDate}</pubDate>
${categoryXml}
      <socialisn2:temperature>${escapeXml(item.temperature)}</socialisn2:temperature>
      <socialisn2:trajectory>${escapeXml(item.trajectory)}</socialisn2:trajectory>
      <socialisn2:exclusive>${item.is_exclusive ? 'true' : 'false'}</socialisn2:exclusive>
      <socialisn2:archive_overlap>${item.archive_overlap.toFixed(4)}</socialisn2:archive_overlap>
    </item>`;
}

// ---------------------------------------------------------------------------
// atomic write
// ---------------------------------------------------------------------------

async function atomicWriteXml(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  // POSIX rename is atomic on the same filesystem. nginx/Caddy with the
  // file already open keeps the prior fd valid; a fresh open sees the
  // new contents. Either is a complete, parseable RSS document.
  await rename(tmp, targetPath);
}
