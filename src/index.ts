// Application entry. Boots:
//   - Fastify HTTP server (src/app.ts) — always
//   - grammy Telegram bot (src/telegram/bot.ts) — when TELEGRAM_BOT_TOKEN
//     and TELEGRAM_CHAT_ID are both set
//
// docker-compose `app` service runs `node dist/src/index.js`. SIG handlers
// drain components in dependency order on shutdown (see ADR-010).

import process from 'node:process';

import type { Bot } from 'grammy';

import { sql } from 'drizzle-orm';

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { buildBot } from './telegram/bot.js';

async function main(): Promise<void> {
  const { db, close } = createDb();

  // Orphaned-runs cleanup. A SIGKILL / OOM / container restart while a
  // scoring run was mid-flight (an MCP run_now that didn't complete,
  // or a cron-triggered run hit by deploy) leaves runs.status='running'
  // forever — /status would show the stale row indefinitely. One
  // UPDATE before app.listen() reconciles the state.
  await db.execute(sql`
    UPDATE runs
    SET status = 'failed',
        error = COALESCE(error || '; ', '') || 'process_restart',
        completed_at = NOW()
    WHERE status = 'running'
  `);

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
    // bot.init() handles getMe + handler registration synchronously
    // before we hand off to long-polling. Awaiting it here closes the
    // startup-vs-SIGTERM race: by the time we register SIG handlers,
    // bot.stop() will see polling state it can actually stop. Without
    // this, a SIGTERM in the sub-second window between bot.start()
    // being called and grammy reaching its polling loop would cause
    // bot.stop() to no-op while the in-flight start continues.
    await bot.init();
    // bot.start() returns when polling stops, which never happens
    // during normal operation. Deliberately NOT awaited — we attach a
    // catch + onStart so:
    //   - the "long-polling started" log accurately reflects "polling
    //     loop alive" rather than "we just called bot.start()" — the
    //     previous spelling printed the line BEFORE the catch could fire
    //     on an immediate failure.
    //   - a fatal start error (e.g. 409 Conflict from a webhook race —
    //     see [[socialisn2_telegram_webhook_conflict]] / the 2026-05-25
    //     incident) exits the process so docker-compose restarts the
    //     container. The previous spelling logged-and-continued, which
    //     left the bot silently dead for 4 days while the HTTP
    //     healthcheck kept reporting green. grammY calls deleteWebhook
    //     before getUpdates on start, so a transient 409 self-heals on
    //     the next container start.
    bot
      .start({
        onStart: () => {
          console.log('[telegram-bot] long-polling started');
        },
      })
      .catch((err: unknown) => {
        console.error('[telegram-bot] start failed; exiting so docker restarts:', err);
        process.exit(1);
      });
  } else {
    console.log(
      '[telegram-bot] disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable)',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[app] ${signal} received; shutting down`);
    // Order matters — see ADR-010. Bot first (handlers depend on DB),
    // then Fastify (also depends on DB), then DB last. Closing DB
    // first wedges in-flight handlers with "connection ended" errors.
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
