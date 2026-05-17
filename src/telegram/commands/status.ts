// /status and /help handlers.

import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { dailyTotalUsd } from '../../cost/ledger.js';
import type { BotContext } from '../bot.js';
import { escapeMarkdownV2 } from '../format.js';

type LastRunRow = {
  id: string;
  kind: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  candidates_count: number | null;
  total_cost_usd: string | null;
  error: string | null;
};

export async function handleStatus(db: Db, ctx: BotContext): Promise<void> {
  // Parallel: last run, today's cost, pending-raw-items count. None of
  // them are large — three round trips ~30ms total even on a slow
  // VPS-postgres link.
  const [lastRunRows, spentUsd, pendingRows] = await Promise.all([
    db.execute<LastRunRow>(sql`
      SELECT id, kind, status, started_at, completed_at,
             candidates_count, total_cost_usd, error
      FROM runs
      ORDER BY started_at DESC
      LIMIT 1
    `),
    dailyTotalUsd(db),
    db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM raw_items
      WHERE processed_at IS NULL
        AND processing_attempts < 3
    `),
  ]);

  const lastRun = lastRunRows[0];
  const pending = pendingRows[0]?.n ?? 0;

  const lastRunLine = lastRun
    ? `${escapeMarkdownV2(lastRun.kind)} \\(${escapeMarkdownV2(lastRun.status)}\\) ` +
      `at ${escapeMarkdownV2(new Date(lastRun.started_at).toISOString())}, ` +
      `${lastRun.candidates_count ?? 0} candidates, ` +
      `${escapeMarkdownV2(lastRun.error ?? 'no error')}`
    : '_No runs yet\\._';

  const costLine = `*Cost today:* $${escapeMarkdownV2(spentUsd.toFixed(4))}`;
  const queueLine = `*Pending raw\\_items:* ${pending}`;

  await ctx.reply(
    `*Last run*\n${lastRunLine}\n\n${costLine}\n${queueLine}`,
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
