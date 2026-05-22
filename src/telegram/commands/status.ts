// /status and /help handlers.
//
// /status reads the canonical StatusSnapshot via src/lib/status.ts and
// formats it as MarkdownV2 for chat. The same struct is served as JSON
// over GET /status (src/app.ts) — keep the two surfaces field-aligned.

import type { Db } from '../../db/client.js';
import { buildStatus } from '../../lib/status.js';
import type { BotContext } from '../bot.js';
import { escapeMarkdownV2 } from '../format.js';

export async function handleStatus(db: Db, ctx: BotContext): Promise<void> {
  const status = await buildStatus(db);
  const { last_run, cost, queue, runs_today } = status;

  const lastRunLine = last_run
    ? `${escapeMarkdownV2(last_run.kind)} \\(${escapeMarkdownV2(last_run.status)}\\) ` +
      `at ${escapeMarkdownV2(new Date(last_run.started_at).toISOString())}, ` +
      `${last_run.candidates_count ?? 0} candidates, ` +
      `${escapeMarkdownV2(last_run.error ?? 'no error')}`
    : '_No runs yet\\._';

  // pct-of-ceiling is shown to one decimal — three digits feels noisy
  // in a chat surface and the 80% alert (Obs-2) is the precise signal.
  const pctStr = (cost.pctOfCeiling * 100).toFixed(1);
  const costLine =
    `*Cost today:* $${escapeMarkdownV2(cost.spent.toFixed(4))} ` +
    `/ $${escapeMarkdownV2(cost.ceiling.toFixed(2))} ` +
    `\\(${escapeMarkdownV2(pctStr)}%\\)`;

  const queueLine = `*Pending raw\\_items:* ${queue.pending_raw_items}`;

  const runsTodayLine =
    `*Runs today:* ${runs_today.total} ` +
    `\\(${runs_today.failed} failed\\)`;

  await ctx.reply(
    `*Last run*\n${lastRunLine}\n\n${costLine}\n${queueLine}\n${runsTodayLine}`,
    { parse_mode: 'MarkdownV2' },
  );
}

export async function handleHelp(ctx: BotContext): Promise<void> {
  // Apostrophes ('), colons (:), and ordinary letters/digits are NOT
  // MarkdownV2-reserved per spec — no escape needed. The static body
  // here only needs escapes around the `.` periods and `-` em-dashes
  // which ARE reserved.
  const body = [
    '*Socialisn2 bot commands*',
    '',
    "`/today` — list today's candidates",
    '`/domain <code>` — filter to one domain',
    '`/cand <id>` — full candidate detail \\+ Pick/Pass/Defer buttons',
    '`/pick <id> [reason]` — mark picked',
    '`/pass <id> [reason]` — mark passed',
    '`/defer <id>` — defer for tomorrow',
    '`/status` — last run, cost today, queue depth',
    '`/help` — this',
    '',
    '_Deferred to Phase 4 PR 2b / PR 3:_',
    '`/search`, `/add_competitor`, `/add_influencer`',
  ].join('\n');
  await ctx.reply(body, { parse_mode: 'MarkdownV2' });
}
