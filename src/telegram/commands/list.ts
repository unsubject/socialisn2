// /today and /domain command handlers.
//
// Both list active 'new' candidates. /today shows all domains grouped;
// /domain <code> filters to one. Both share the same DB query shape
// and renderer (formatTodayList) so the formatting stays consistent
// across surfaces.

import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import type { BotContext } from '../bot.js';
import { chunkForTelegram, formatTodayList, type RenderCandidate } from '../format.js';

/** Cap on candidates surfaced per command. Telegram's single-message
 *  limit is 4096 chars and our per-candidate row is ~150 chars; 30
 *  gives ~4500 chars worst-case which `chunkForTelegram` splits into
 *  two sendMessages. Most days the list is well under. */
const LIST_LIMIT = 30;

const VALID_DOMAINS = new Set([
  'economy',
  'economics',
  'scitech',
  'geopolitics',
  'national',
]);

type CandidateRow = {
  id: string;
  headline: string;
  primary_domain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  is_exclusive: boolean;
  archive_overlap: number;
  keywords: string[];
  tags: string[];
};

export async function handleToday(db: Db, ctx: BotContext): Promise<void> {
  const rows = await loadActiveCandidates(db, null);
  await sendInChunks(ctx, formatTodayList(rows.map(toRenderCandidate)));
}

export async function handleDomain(db: Db, ctx: BotContext): Promise<void> {
  // grammy passes the args after the command in ctx.match for command
  // handlers (https://grammy.dev/guide/commands). Trim + lowercase so
  // `/domain ECONOMY` works the same as `/domain economy`.
  const arg = (typeof ctx.match === 'string' ? ctx.match : '').trim().toLowerCase();
  if (!arg) {
    await ctx.reply(
      '_Usage:_ `/domain economy` · `economics` · `scitech` · `geopolitics` · `national`',
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }
  if (!VALID_DOMAINS.has(arg)) {
    await ctx.reply(
      `_Unknown domain_ \`${escapeForReply(arg)}\`_\\. Try_ /help`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }
  const rows = await loadActiveCandidates(db, arg);
  await sendInChunks(ctx, formatTodayList(rows.map(toRenderCandidate)));
}

/** Reply with one message per chunk. Sequential so Telegram's per-chat
 *  ordering matches the rendered order — bursting in parallel could
 *  interleave with other handlers' messages. */
async function sendInChunks(ctx: BotContext, body: string): Promise<void> {
  for (const chunk of chunkForTelegram(body)) {
    await ctx.reply(chunk, { parse_mode: 'MarkdownV2' });
  }
}

async function loadActiveCandidates(
  db: Db,
  primaryDomain: string | null,
): Promise<CandidateRow[]> {
  if (primaryDomain === null) {
    return db.execute<CandidateRow>(sql`
      SELECT id, headline, primary_domain, domains,
             temperature, trajectory, is_exclusive,
             archive_overlap, keywords, tags
      FROM candidates
      WHERE status = 'new'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT ${LIST_LIMIT}
    `);
  }
  return db.execute<CandidateRow>(sql`
    SELECT id, headline, primary_domain, domains,
           temperature, trajectory, is_exclusive,
           archive_overlap, keywords, tags
    FROM candidates
    WHERE status = 'new'
      AND expires_at > NOW()
      AND primary_domain = ${primaryDomain}
    ORDER BY created_at DESC
    LIMIT ${LIST_LIMIT}
  `);
}

function toRenderCandidate(row: CandidateRow): RenderCandidate {
  return {
    id: row.id,
    headline: row.headline,
    primaryDomain: row.primary_domain,
    domains: row.domains,
    temperature: row.temperature,
    trajectory: row.trajectory,
    isExclusive: row.is_exclusive,
    archiveOverlap: row.archive_overlap,
    keywords: row.keywords,
    tags: row.tags,
  };
}

/** Minimal MarkdownV2 escape for short user-supplied strings in error
 *  messages (`unknown domain "X"`). Mirrors src/telegram/format.ts's
 *  escapeMarkdownV2 — inlined here to avoid a cyclic import. */
function escapeForReply(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
