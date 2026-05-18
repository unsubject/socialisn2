// MCP source-management tools — expand the competitor watch list
// (one row at a time) and add an independent commentator source.
//
// Both are insert-only — we do NOT validate the feed URL at add time.
// The ingestion path runs on its own cron and will record
// `last_status='err:...'` on the first failed fetch, which the
// operator can spot via /status or by querying the sources / competitors
// tables. Pre-validating here would couple the MCP request to a flaky
// external HTTP call; the SPEC §6.6 model is "configure, let the
// ingestion layer do the truth check."

import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../../db/client.js';
import { AddInfluencerArgs, ExpandCompetitorArgs } from '../schemas.js';

// SPEC §6.6 defaults for new independent commentator sources.
const INFLUENCER_DEFAULT_AUTHORITY = 60;
const INFLUENCER_DEFAULT_FETCH_INTERVAL_MIN = 60;

/**
 * Accept a few common YouTube channel-URL shapes and extract the
 * channel id (UCxxxxxxxxxxxxxxxxxxxxxx form). The id is what
 * ingestion-side youtube.ts uses to build the Atom feed URL:
 * `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`.
 *
 * Doesn't support /@handle or /c/customname forms — resolving those
 * to a channel id needs the YouTube Data API (paid quota) or a
 * scraping pass. Operator should paste the canonical /channel/UC...
 * form for now; the error message tells them so.
 */
function parseYouTubeChannelId(url: string): string {
  const m = url.match(/\/channel\/(UC[\w-]{20,})/);
  if (!m || !m[1]) {
    throw new Error(
      `expand_competitor_list: cannot extract channel id from ${url}. ` +
        `Use the canonical https://youtube.com/channel/UC<...> URL form.`,
    );
  }
  return m[1];
}

export async function expandCompetitorList(
  db: Db,
  rawArgs: unknown,
): Promise<{ competitor_id: string }> {
  const args = ExpandCompetitorArgs.parse(rawArgs);
  const externalId = parseYouTubeChannelId(args.channel_url);
  const id = uuidv7();

  // ON CONFLICT skips when the (platform, external_id) pair already
  // exists — repeated calls with the same URL become idempotent
  // upserts rather than UNIQUE-constraint errors. We RETURNING id to
  // tell the caller which row they ended up with (the one we just
  // inserted OR the pre-existing one).
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO competitors (id, platform, external_id, url, name, priority_tier, language)
    VALUES (
      ${id}, 'youtube', ${externalId}, ${args.channel_url},
      ${`yt:${externalId}`}, ${args.priority_tier}, 'zh-HK'
    )
    ON CONFLICT (platform, external_id) DO UPDATE
      SET url = EXCLUDED.url,
          priority_tier = EXCLUDED.priority_tier
    RETURNING id
  `);
  const competitorId = rows[0]?.id;
  if (!competitorId) {
    throw new Error('expand_competitor_list: INSERT returned no row');
  }
  return { competitor_id: competitorId };
}

export async function addInfluencer(
  db: Db,
  rawArgs: unknown,
): Promise<{ source_id: string }> {
  const args = AddInfluencerArgs.parse(rawArgs);

  // handle_or_url permits either bare URL (most common) or a
  // shorthand like `substack:simon`. v1 only handles the URL form.
  // Reject anything that doesn't parse as URL so we don't insert a
  // row ingestion can't fetch.
  let parsed: URL;
  try {
    parsed = new URL(args.handle_or_url);
  } catch {
    throw new Error(
      `add_influencer: handle_or_url must be a full URL (got "${args.handle_or_url}"). Shorthand forms not supported in v1.`,
    );
  }
  // Derive a human name from the URL host — overrideable later via SQL
  // if Simon wants a friendlier label.
  const name = parsed.hostname.replace(/^www\./, '');
  const domains = args.domain ? [args.domain] : ['economy'];
  const id = uuidv7();

  // No ON CONFLICT clause — sources has no natural unique key beyond
  // `id`, and the earlier attempt at `ON CONFLICT (source_id,
  // external_id)` referenced a constraint that only exists on
  // raw_items (PG raises "no unique or exclusion constraint matching
  // the ON CONFLICT specification" on every call). Duplicate URLs CAN
  // land; operator dedupes via SQL if it happens.
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO sources (
      id, kind, url, name, language, domains,
      authority_score, fetch_interval_min, enabled
    ) VALUES (
      ${id}, 'rss', ${parsed.toString()}, ${name}, 'en',
      ${sql`ARRAY[${sql.join(
        domains.map((d) => sql`${d}`),
        sql`, `,
      )}]::text[]`},
      ${INFLUENCER_DEFAULT_AUTHORITY},
      ${INFLUENCER_DEFAULT_FETCH_INTERVAL_MIN},
      true
    )
    RETURNING id
  `);
  const sourceId = rows[0]?.id ?? id;
  return { source_id: sourceId };
}
