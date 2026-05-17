// Outbound Telegram push helpers.
//
// Pure HTTP — no grammy dependency. The orchestrator imports this for
// the post-run digest and the at-insert instant push; the bot process
// imports grammy separately for inbound commands. Splitting outbound
// from inbound means a LiteLLM-scale outage on the bot side can't
// break the orchestrator's tail hook, and tests of the orchestrator
// don't pull in the whole Telegram framework.
//
// SPEC §11.3 specifies the Bot API sendMessage shape with MarkdownV2
// parsing. We deliberately don't use any grammy types here — callers
// pass plain strings + optional reply_markup payloads.

import { env } from '../config/env.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SendMessageOptions {
  /** Override fetch — tests stub here so no real HTTP happens. */
  fetchFn?: typeof fetch;
  /** External abort signal. Race-loses against the default timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SendMessagePayload {
  /** MarkdownV2-formatted message body. Caller must escape — see
   *  src/telegram/format.ts:escapeMarkdownV2. */
  text: string;
  /** Optional inline-keyboard payload — the SAME shape grammy emits
   *  when you serialize an InlineKeyboard. Untyped here to keep this
   *  module grammy-free; the bot side knows what to pass. */
  replyMarkup?: unknown;
  /** Disable Telegram link preview for digest messages — keeps the
   *  notification chrome compact. Default false (link preview shown). */
  disableLinkPreview?: boolean;
}

export interface SendMessageResult {
  /** True iff the Telegram API returned ok=true. */
  ok: boolean;
  /** Telegram's message_id when ok=true, else undefined. */
  messageId?: number;
  /** API error description when ok=false. */
  description?: string;
}

/**
 * Send one MarkdownV2-formatted message via Bot API. Token + chat ID
 * come from env so callers don't need to thread them. Returns a result
 * object instead of throwing on Telegram-side errors — the orchestrator
 * hook wraps this in safe-call and surfaces failures via runs.error;
 * losing a push shouldn't fail the run.
 */
export async function sendMessage(
  payload: SendMessagePayload,
  opts: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const token = env.telegramBotToken();
  const chatId = env.telegramChatId();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: payload.text,
    parse_mode: 'MarkdownV2',
  };
  if (payload.disableLinkPreview) body.disable_web_page_preview = true;
  if (payload.replyMarkup) body.reply_markup = payload.replyMarkup;

  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Bot API returns 200 even for app-level failures (ok:false body).
  // A non-200 means HTTP transport failure — surface it without
  // swallowing.
  if (!res.ok) {
    const detail = (await res.text().catch(() => '<no body>')).slice(0, 300);
    return {
      ok: false,
      description: `HTTP ${res.status} from Telegram sendMessage: ${detail}`,
    };
  }

  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
  } | null;
  if (!json) {
    return { ok: false, description: 'Telegram sendMessage returned non-JSON body' };
  }
  if (json.ok === true) {
    return { ok: true, messageId: json.result?.message_id };
  }
  return { ok: false, description: json.description ?? 'unknown Telegram API error' };
}
