// Unit tests for src/telegram/push.ts. Stub fetch entirely — no real
// Bot API calls. Asserts request shape (URL, parse_mode, payload) and
// the result-object handling for success / api-error / non-200 paths.

import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendMessage } from '../../src/telegram/push.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123456';
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sendMessage', () => {
  it('POSTs to /bot<token>/sendMessage with MarkdownV2 parse_mode + chat_id', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 42 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const res = await sendMessage(
      { text: 'hello *world*', disableLinkPreview: true },
      { fetchFn: fakeFetch },
    );
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.telegram.org/bottest-token/sendMessage',
    );
    expect(calls[0]?.body).toMatchObject({
      chat_id: '123456',
      text: 'hello *world*',
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
  });

  it('includes reply_markup when provided', async () => {
    let captured: unknown = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const keyboard = { inline_keyboard: [[{ text: 'ok', callback_data: 'x' }]] };
    await sendMessage({ text: 't', replyMarkup: keyboard }, { fetchFn: fakeFetch });
    expect(captured).toMatchObject({ reply_markup: keyboard });
  });

  it('omits disable_web_page_preview when not requested', async () => {
    let captured: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await sendMessage({ text: 't' }, { fetchFn: fakeFetch });
    expect(captured.disable_web_page_preview).toBeUndefined();
  });

  it('returns ok=false when Bot API responds with ok:false', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const res = await sendMessage({ text: 't' }, { fetchFn: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.description).toBe('chat not found');
  });

  it('returns ok=false on non-2xx HTTP', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('upstream barf', { status: 502 });
    const res = await sendMessage({ text: 't' }, { fetchFn: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.description).toContain('HTTP 502');
  });

  it('returns ok=false when response body is not JSON', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('definitely not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const res = await sendMessage({ text: 't' }, { fetchFn: fakeFetch });
    expect(res.ok).toBe(false);
    expect(res.description).toContain('non-JSON');
  });
});
