// Telegram bot wiring (SPEC §11.3, ADR-010).
//
// Single-user bot — all updates from a chat ID other than
// TELEGRAM_CHAT_ID are silently dropped. The whitelist middleware runs
// before any command handler so an unauthorised user never sees a hint
// that the bot exists.
//
// Long-polling transport via grammy's `bot.start()`. The single-process
// app deployment (src/index.ts) starts polling alongside the Fastify
// HTTP server. See ADR-010 for the transport / process-boundary
// rationale.
//
// What's NOT wired here (deferred to a follow-up PR — see PR body):
//   /search, /add_competitor, /add_influencer.
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
    throw new Error('buildBot: TELEGRAM_BOT_TOKEN is empty — gate bot lifecycle on env');
  }
  const bot = new Bot(token);

  const allowedChatId = opts.allowedChatId ?? env.telegramChatId();
  if (allowedChatId) {
    bot.use(async (ctx, next) => {
      const chatId = String(ctx.chat?.id ?? '');
      if (chatId !== allowedChatId) {
        // Silent drop. No reply, no log of message text — an
        // unauthorised user gets a non-response, which is the right
        // signal that the bot isn't for them. NOTE for ops:
        // Telegram group chat IDs are NEGATIVE (e.g. -100xxx).
        // If TELEGRAM_CHAT_ID is set without the leading `-` for a
        // group, every update silently drops here.
        console.warn(
          `[telegram-bot] dropped update from chat ${chatId || '<unknown>'} (whitelist=${allowedChatId})`,
        );
        return;
      }
      await next();
    });
  }

  bot.command('today', (ctx) => handleToday(db, ctx));
  bot.command('domain', (ctx) => handleDomain(db, ctx));
  bot.command('cand', (ctx) => handleCand(db, ctx));
  bot.command('pick', (ctx) => handleDecide(db, ctx, 'pick'));
  bot.command('pass', (ctx) => handleDecide(db, ctx, 'pass'));
  bot.command('defer', (ctx) => handleDecide(db, ctx, 'defer'));
  bot.command('status', (ctx) => handleStatus(db, ctx));
  bot.command('help', (ctx) => handleHelp(ctx));

  bot.on('callback_query:data', (ctx) => handleDecideCallback(db, ctx));

  // Catch-all error handler. Include the update id so ops can re-fetch
  // the exact update via the Bot API and reproduce the failure;
  // err.error is the underlying handler exception.
  bot.catch((err) => {
    console.error(
      `[telegram-bot] handler error on update_id=${err.ctx?.update?.update_id ?? '?'}:`,
      err.error,
    );
  });

  return bot;
}

export type BotContext = Context;
