// Telegram bot wiring (SPEC §11.3).
//
// Single-user bot — all updates from a chat ID other than
// TELEGRAM_CHAT_ID are silently dropped. The whitelist middleware runs
// before any command handler so an unauthorised user never sees a hint
// that the bot exists.
//
// Long-polling transport via grammy's `bot.start()`. The single-process
// app deployment (src/index.ts) starts polling alongside the Fastify
// HTTP server. Webhook mode would need setWebhook + Caddy/nginx path +
// secret header — three new moving parts that buy nothing at v1 single-
// user single-VPS scale.
//
// What's NOT wired here (deferred to a follow-up PR — see PR body):
//   /search         — needs vector embedding of query text, overlaps
//                     with Stage 5 archive plumbing.
//   /add_competitor — overlaps with the MCP server's add_competitor
//                     tool (Phase 4 PR 3); shipping in both surfaces
//                     now invites divergence.
//   /add_influencer — same overlap concern.
//
// What IS wired: /today, /domain, /cand, /pick, /pass, /defer, /status,
// /help — the daily-use loop.

import { Bot, type Context } from 'grammy';

import type { Db } from '../db/client.js';
import { env } from '../config/env.js';
import { handleCand } from './commands/cand.js';
import { handleDecide, handleDecideCallback } from './commands/decide.js';
import { handleDomain, handleToday } from './commands/list.js';
import { handleHelp, handleStatus } from './commands/status.js';

export interface BuildBotOptions {
  /** Override the chat-id whitelist for tests. Defaults to
   *  env.telegramChatId(). Pass an empty string to disable the
   *  whitelist entirely (tests only — production must always whitelist). */
  allowedChatId?: string;
  /** Override the Bot API token for tests. Defaults to
   *  env.telegramBotToken(). */
  token?: string;
}

/**
 * Build and return a configured grammy Bot. Caller is responsible for
 * starting (bot.start()) and stopping (bot.stop()) it — src/index.ts
 * wires that lifecycle.
 */
export function buildBot(db: Db, opts: BuildBotOptions = {}): Bot {
  const token = opts.token ?? env.telegramBotToken();
  if (!token) {
    // Caller's responsibility to gate on this, but a clear throw here
    // beats a confusing grammy startup error if someone forgets.
    throw new Error('buildBot: TELEGRAM_BOT_TOKEN is empty — gate bot lifecycle on env');
  }
  const bot = new Bot(token);

  // Chat-id whitelist. Empty allowedChatId disables the gate — only
  // sensible in tests.
  const allowedChatId = opts.allowedChatId ?? env.telegramChatId();
  if (allowedChatId) {
    bot.use(async (ctx, next) => {
      const chatId = String(ctx.chat?.id ?? '');
      if (chatId !== allowedChatId) {
        // Silent drop. No reply, no log of message text — an
        // unauthorised user gets a non-response, which is the right
        // signal that the bot isn't for them.
        console.warn(
          `[telegram-bot] dropped update from chat ${chatId || '<unknown>'} (whitelist=${allowedChatId})`,
        );
        return;
      }
      await next();
    });
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  bot.command('today', (ctx) => handleToday(db, ctx));
  bot.command('domain', (ctx) => handleDomain(db, ctx));
  bot.command('cand', (ctx) => handleCand(db, ctx));
  bot.command('pick', (ctx) => handleDecide(db, ctx, 'pick'));
  bot.command('pass', (ctx) => handleDecide(db, ctx, 'pass'));
  bot.command('defer', (ctx) => handleDecide(db, ctx, 'defer'));
  bot.command('status', (ctx) => handleStatus(db, ctx));
  bot.command('help', (ctx) => handleHelp(ctx));

  // Inline keyboard callbacks for pick/pass/defer — see
  // candidateKeyboard in format.ts for the payload shape
  // (`decide:<action>:<id>`).
  bot.on('callback_query:data', (ctx) => handleDecideCallback(db, ctx));

  // Catch-all error handler — log + continue (grammy auto-acks the
  // update on handler return). Without this a thrown error would crash
  // the polling loop on the next update.
  bot.catch((err) => {
    console.error('[telegram-bot] handler error:', err.error);
  });

  return bot;
}

/** Re-exported type alias so command handler files don't need to
 *  re-import grammy just for Context typings. */
export type BotContext = Context;
