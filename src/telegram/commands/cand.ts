// /cand <id> command — show one candidate's full detail with the
// Pick/Pass/Defer inline keyboard.

import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import type { BotContext } from '../bot.js';
import { UUID_RE } from '../../lib/uuid.js';
import {
  candidateKeyboard,
  escapeMarkdownV2,
  formatCandidateDetail,
  type RenderCandidate,
} from '../format.js';

type CandidateDetailRow = {
  id: string;
  cluster_id: string;
  headline: string;
  context_summary: string;
  primary_domain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  is_exclusive: boolean;
  archive_overlap: number;
  keywords: string[];
  tags: string[];
  curation_rationale: string | null;
};

type SourceRow = { name: string; url: string };

export async function handleCand(db: Db, ctx: BotContext): Promise<void> {
  const id = (typeof ctx.match === 'string' ? ctx.match : '').trim();
  if (!id) {
    await ctx.reply('_Usage:_ `/cand <id>`', { parse_mode: 'MarkdownV2' });
    return;
  }
  // Strict UUID pre-filter — same shape as src/app.ts:UUID_RE. A
  // UUID-shaped-but-PG-invalid id would otherwise blow up the
  // db.execute call (the bot.catch handler logs but the user sees
  // nothing). Cheap pre-check.
  if (!UUID_RE.test(id)) {
    await ctx.reply(
      `_Not a candidate id:_ \`${escapeMarkdownV2(id)}\``,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  const rows = await db.execute<CandidateDetailRow>(sql`
    SELECT id, cluster_id, headline, context_summary,
           primary_domain, domains,
           temperature, trajectory, is_exclusive,
           archive_overlap, keywords, tags,
           curation_rationale
    FROM candidates
    WHERE id = ${id}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) {
    await ctx.reply(`_No candidate_ \`${escapeMarkdownV2(id)}\``, {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  const sources = await db.execute<SourceRow>(sql`
    SELECT s.name, ri.url
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    JOIN sources s    ON s.id  = ri.source_id
    WHERE i.cluster_id = ${row.cluster_id}
    ORDER BY ri.published_at ASC
  `);

  const candidate: RenderCandidate = {
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
    contextSummary: row.context_summary,
    curationRationale: row.curation_rationale,
    sources,
  };

  await ctx.reply(formatCandidateDetail(candidate), {
    parse_mode: 'MarkdownV2',
    reply_markup: candidateKeyboard(row.id),
    link_preview_options: { is_disabled: true },
  });
}
