// /pick, /pass, /defer command handlers + inline-keyboard callback.
//
// Two entry points share the same business logic in
// src/telegram/decisions.ts:
//
//   - Slash command: `/pick <id> [reason]`, `/pass <id> [reason]`,
//     `/defer <id>` (no reason — defer is reasonless by convention).
//   - Inline button: callback_query data `decide:<action>:<id>` from
//     the keyboard attached by /cand and instant-exclusive pushes.
//
// All decisions write to candidates + feedback + 2nd-brain MCP via
// decide(). Race idempotency is enforced at the DB layer (see
// decisions.ts) — a second tap on the inline buttons becomes
// "already decided" instead of a duplicate row.

import type { Db } from '../../db/client.js';
import type { BotContext } from '../bot.js';
import { decide, type Decision } from '../decisions.js';
import { escapeMarkdownV2 } from '../format.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Slash-command handler — `/pick <id> [reason]`, etc. */
export async function handleDecide(
  db: Db,
  ctx: BotContext,
  decision: Decision,
): Promise<void> {
  const arg = (typeof ctx.match === 'string' ? ctx.match : '').trim();
  if (!arg) {
    await ctx.reply(`_Usage:_ \`/${decision} <id> [reason]\``, {
      parse_mode: 'MarkdownV2',
    });
    return;
  }
  // First whitespace splits id from reason. Reason is everything after
  // the first run of whitespace — preserves internal whitespace, no
  // shell-style quoting needed.
  const match = /^(\S+)(?:\s+(.+))?$/.exec(arg);
  if (!match) {
    await ctx.reply(`_Usage:_ \`/${decision} <id> [reason]\``, {
      parse_mode: 'MarkdownV2',
    });
    return;
  }
  const id = match[1]!;
  const reason = decision === 'defer' ? undefined : match[2]?.trim() || undefined;

  if (!UUID_RE.test(id)) {
    await ctx.reply(`_Not a candidate id:_ \`${escapeMarkdownV2(id)}\``, {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  const result = await decide(db, id, decision, reason, 'telegram');
  if (result.alreadyDecided) {
    await ctx.reply(`_Already decided\\._`, { parse_mode: 'MarkdownV2' });
    return;
  }
  const headline = result.candidate?.headline ?? '';
  await ctx.reply(
    `_${decisionVerb(decision)}:_ ${escapeMarkdownV2(headline)}`,
    { parse_mode: 'MarkdownV2' },
  );
}

/** Inline-keyboard callback — data is `decide:<action>:<id>`. */
export async function handleDecideCallback(db: Db, ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'decide') {
    // Not one of ours — acknowledge anyway so the user's button
    // doesn't show the spinning indicator forever.
    await ctx.answerCallbackQuery();
    return;
  }
  const action = parts[1]!;
  const id = parts[2]!;
  if (action !== 'pick' && action !== 'pass' && action !== 'defer') {
    await ctx.answerCallbackQuery({ text: 'Unknown action' });
    return;
  }
  if (!UUID_RE.test(id)) {
    await ctx.answerCallbackQuery({ text: 'Bad candidate id' });
    return;
  }

  const result = await decide(db, id, action, undefined, 'telegram');
  // answerCallbackQuery dismisses the button spinner and surfaces a
  // short toast — single source of UI feedback for the callback path.
  if (result.alreadyDecided) {
    await ctx.answerCallbackQuery({ text: 'Already decided' });
    return;
  }
  await ctx.answerCallbackQuery({ text: decisionVerb(action) });
}

function decisionVerb(decision: Decision): string {
  switch (decision) {
    case 'pick':
      return 'Picked';
    case 'pass':
      return 'Passed';
    case 'defer':
      return 'Deferred';
  }
}
