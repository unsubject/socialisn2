// Integration test for src/telegram/bot.ts via grammy's
// bot.handleUpdate() — drives synthetic updates without starting the
// polling loop (which would wedge vitest forever).
//
// Bot API calls are intercepted via bot.api.config.use() so no real
// HTTP fires. The DB is real (vitest+real-PG, same pattern as the rest
// of the suite). Token is fake; chat-id whitelist is set to a known
// test value.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Bot } from 'grammy';

import * as schema from '../../src/db/schema.js';
import { buildBot } from '../../src/telegram/bot.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_CHAT_ID = '99999';
const OTHER_CHAT_ID = '11111';

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!DATABASE_URL)('telegram bot (buildBot)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let bot: Bot;
  let apiCalls: ApiCall[];
  let sourceId: string;
  let clusterId: string;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(process.cwd(), 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(dir, file), 'utf-8'));
    }
    sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'bot-test', ARRAY['economy']::text[])
    `;
    // Skip the real 2nd-brain MCP — decisions.ts will degrade to ok:false.
    delete process.env.TWO_BRAIN_MCP_URL;
    delete process.env.TWO_BRAIN_MCP_TOKEN;
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE TABLE feedback, candidates, items, gdelt_coverage, clusters CASCADE',
    );
    await client.unsafe('TRUNCATE TABLE raw_items CASCADE');
    clusterId = uuidv7();
    const vec = `[${new Array(1536).fill(0.001).join(',')}]`;
    await client`
      INSERT INTO clusters (id, centroid, first_seen_at, last_seen_at, item_count, domains, primary_domain, status)
      VALUES (${clusterId}, ${vec}::vector(1536),
              NOW(), NOW(), 1, ARRAY['economy']::text[], 'economy', 'active')
    `;
    bot = buildBot(db, { token: 'fake-test-token', allowedChatId: ALLOWED_CHAT_ID });
    // Intercept ALL outgoing Bot API calls. We return synthetic success
    // for the methods used by command handlers; everything else passes
    // through (and would fail real HTTP — keep the suite hermetic).
    // grammy's api.config.use chain expects raw Telegram response
    // shape ({ok: true, result: <data>}) — ApiClient.callApi treats
    // any falsy `ok` as an API failure and throws GrammyError. Wrap
    // all synthetic responses accordingly.
    bot.api.config.use((_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      if (method === 'getMe') {
        return Promise.resolve({
          ok: true,
          result: {
            id: 999999,
            is_bot: true,
            first_name: 'TestBot',
            username: 'test_bot',
            can_join_groups: true,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          },
        }) as unknown as ReturnType<typeof _prev>;
      }
      if (method === 'sendMessage') {
        return Promise.resolve({
          ok: true,
          result: {
            message_id: 1,
            date: 0,
            chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' as const, first_name: 'T' },
          },
        }) as unknown as ReturnType<typeof _prev>;
      }
      if (method === 'answerCallbackQuery') {
        return Promise.resolve({ ok: true, result: true }) as unknown as ReturnType<typeof _prev>;
      }
      return Promise.resolve({ ok: true, result: true }) as unknown as ReturnType<typeof _prev>;
    });
    await bot.init();
    // Reset apiCalls AFTER init so the getMe call grammy fires during
    // init() doesn't pollute per-test assertions on apiCalls.length.
    apiCalls = [];
  });

  afterEach(async () => {
    // bot.stop() is for polling; nothing to clean up when we only used
    // handleUpdate. Reset for next test.
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function commandUpdate(text: string, chatId = ALLOWED_CHAT_ID): unknown {
    const cmdMatch = /^\/(\w+)/.exec(text);
    return {
      update_id: Math.floor(Math.random() * 1_000_000),
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chatId), type: 'private', first_name: 'T' },
        from: { id: Number(chatId), is_bot: false, first_name: 'T' },
        text,
        entities: cmdMatch
          ? [{ type: 'bot_command', offset: 0, length: cmdMatch[0].length }]
          : [],
      },
    };
  }

  function callbackUpdate(data: string, chatId = ALLOWED_CHAT_ID): unknown {
    return {
      update_id: Math.floor(Math.random() * 1_000_000),
      callback_query: {
        id: `cb-${Math.random()}`,
        from: { id: Number(chatId), is_bot: false, first_name: 'T' },
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId), type: 'private', first_name: 'T' },
          text: 'detail',
        },
        chat_instance: 'inst',
        data,
      },
    };
  }

  async function seedCandidate(opts: { headline?: string } = {}): Promise<string> {
    const id = uuidv7();
    const runId = uuidv7();
    await client`
      INSERT INTO candidates (
        id, cluster_id, headline, context_summary,
        primary_domain, domains, temperature, trajectory,
        is_exclusive, similarity_score, archive_overlap, archive_overlap_links,
        curation_score, curation_rationale, keywords, tags, status,
        generated_run_id, expires_at
      ) VALUES (
        ${id}, ${clusterId},
        ${opts.headline ?? 'Test candidate'},
        'context', 'economy', ARRAY['economy']::text[],
        'warm', 'rising', false, 0.5, 0.1,
        ${JSON.stringify({ overlap: 0.1, links: [] })}::jsonb,
        75, 'r', ARRAY['kw']::text[], ARRAY['tag']::text[], 'new', ${runId},
        ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}::timestamptz
      )
    `;
    return id;
  }

  // -------------------------------------------------------------------------
  // tests
  // -------------------------------------------------------------------------

  it('/today replies with the active candidates', async () => {
    await seedCandidate({ headline: 'First story' });
    await seedCandidate({ headline: 'Second story' });

    await bot.handleUpdate(commandUpdate('/today') as Parameters<typeof bot.handleUpdate>[0]);

    const send = apiCalls.find((c) => c.method === 'sendMessage');
    expect(send).toBeDefined();
    const text = send?.payload.text as string;
    expect(text).toContain('First story');
    expect(text).toContain('Second story');
  });

  it('/today on empty candidate set returns the empty-state message', async () => {
    await bot.handleUpdate(commandUpdate('/today') as Parameters<typeof bot.handleUpdate>[0]);
    const send = apiCalls.find((c) => c.method === 'sendMessage');
    expect(send?.payload.text).toContain('No active candidates');
  });

  it('/cand <id> replies with detail + inline keyboard', async () => {
    const id = await seedCandidate({ headline: 'Detailed story' });
    await bot.handleUpdate(commandUpdate(`/cand ${id}`) as Parameters<typeof bot.handleUpdate>[0]);
    const send = apiCalls.find((c) => c.method === 'sendMessage');
    expect(send?.payload.text).toContain('Detailed story');
    const replyMarkup = send?.payload.reply_markup as { inline_keyboard?: unknown[][] };
    expect(replyMarkup?.inline_keyboard).toBeDefined();
    expect(replyMarkup?.inline_keyboard?.[0]).toHaveLength(3);
  });

  it('decide:pick callback marks the candidate picked + answers the callback', async () => {
    const id = await seedCandidate();
    await bot.handleUpdate(
      callbackUpdate(`decide:pick:${id}`) as Parameters<typeof bot.handleUpdate>[0],
    );

    const answered = apiCalls.find((c) => c.method === 'answerCallbackQuery');
    expect(answered).toBeDefined();
    expect((answered?.payload as { text?: string }).text).toBe('Picked');

    const row = await client<{ status: string }[]>`
      SELECT status FROM candidates WHERE id = ${id}
    `;
    expect(row[0]?.status).toBe('picked');
  });

  it('decide callback on an already-decided candidate returns Already-decided toast + no duplicate feedback', async () => {
    const id = await seedCandidate();
    await bot.handleUpdate(
      callbackUpdate(`decide:pick:${id}`) as Parameters<typeof bot.handleUpdate>[0],
    );
    apiCalls.length = 0; // reset; want only the second call's traffic
    await bot.handleUpdate(
      callbackUpdate(`decide:pass:${id}`) as Parameters<typeof bot.handleUpdate>[0],
    );
    const answered = apiCalls.find((c) => c.method === 'answerCallbackQuery');
    expect((answered?.payload as { text?: string }).text).toBe('Already decided');

    const fbCount = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM feedback WHERE candidate_id = ${id}
    `;
    expect(fbCount[0]?.n).toBe(1);
  });

  it('drops updates from a chat outside the whitelist', async () => {
    await seedCandidate();
    await bot.handleUpdate(
      commandUpdate('/today', OTHER_CHAT_ID) as Parameters<typeof bot.handleUpdate>[0],
    );
    expect(apiCalls).toHaveLength(0);
  });

  it('/help responds with command reference', async () => {
    await bot.handleUpdate(commandUpdate('/help') as Parameters<typeof bot.handleUpdate>[0]);
    const send = apiCalls.find((c) => c.method === 'sendMessage');
    expect(send?.payload.text).toContain('/today');
    expect(send?.payload.text).toContain('/help');
  });

  it('/status responds even with no runs/candidates', async () => {
    await bot.handleUpdate(commandUpdate('/status') as Parameters<typeof bot.handleUpdate>[0]);
    const send = apiCalls.find((c) => c.method === 'sendMessage');
    expect(send?.payload.text).toContain('No runs yet');
    expect(send?.payload.text).toContain('Cost today');
  });

  it('/pick <id> from slash command (with reason) updates status + replies', async () => {
    const id = await seedCandidate({ headline: 'Slash picked' });
    await bot.handleUpdate(
      commandUpdate(`/pick ${id} because reasons`) as Parameters<typeof bot.handleUpdate>[0],
    );
    const send = apiCalls.find((c) => c.method === 'sendMessage');
    expect(send?.payload.text).toContain('Picked');
    expect(send?.payload.text).toContain('Slash picked');
    const row = await client<{ status: string; decision_reason: string }[]>`
      SELECT status, decision_reason FROM candidates WHERE id = ${id}
    `;
    expect(row[0]?.status).toBe('picked');
    expect(row[0]?.decision_reason).toBe('because reasons');
  });
});
