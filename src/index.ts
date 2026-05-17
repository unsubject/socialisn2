// Application entry. Boots:
//   - Fastify HTTP server (src/app.ts) — always
//   - grammy Telegram bot (src/telegram/bot.ts) — when TELEGRAM_BOT_TOKEN
//     and TELEGRAM_CHAT_ID are both set
//
// docker-compose `app` service runs `node dist/index.js`. SIG handlers
// drain components in dependency order on shutdown.

import process from 'node:process';

import { Bot } from 'grammy';

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { buildBot } from './telegram/bot.js';

async function main(): Promise<void> {
  const { db, close } = createDb();
  const app = buildApp(db);

  const port = Number(process.env.PORT ?? '3000');
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });

  // Telegram bot — optional. Gated on both env vars being set so
  // non-prod environments (tests, dev) can run the Fastify side
  // without needing real Bot API credentials.
  let bot: Bot | null = null;
  if (env.telegramBotToken() && env.telegramChatId()) {
    bot = buildBot(db);
    // grammy's bot.start() returns when polling stops, which never
    // happens during normal operation. Deliberately NOT awaited — we
    // attach a catch so a startup error (bad token, network issue at
    // boot) gets logged rather than crashing the process before SIG
    // handlers are installed. The actual stop happens via bot.stop()
    // in the shutdown handler.
    bot.start().catch((err: unknown) => {
      console.error('[telegram-bot] start failed:', err);
    });
    console.log('[telegram-bot] long-polling started');
  } else {
    console.log(
      '[telegram-bot] disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable)',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[app] ${signal} received; shutting down`);
    // Order matters:
    //   1. Stop the bot first so in-flight update handlers can drain
    //      against a still-valid DB connection.
    //   2. Close Fastify so in-flight HTTP requests can complete.
    //   3. Release the DB connection.
    // Getting this wrong (closing DB first) means update handlers
    // throw "connection ended" mid-response, which then surfaces as
    // a Telegram retry next polling cycle on the same update.
    if (bot) {
      try {
        await bot.stop();
      } catch (err) {
        console.error('[telegram-bot] stop failed:', err);
      }
    }
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(`[app] listening on ${host}:${port}`);
}

main().catch((err: unknown) => {
  console.error('[app] fatal:', err);
  process.exit(1);
});
