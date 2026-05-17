// Production email handler. Receives an inbound RFC 5322 message via
// Cloudflare Email Routing, looks up the publisher slug via the
// sender_map index, and writes:
//
//   - inbox          one row per matched email (slug + message_id PK,
//                    plus subject, body_text snippet, body_html)
//   - inbox_links    one row per distinct link extracted from the body,
//                    ordinal-positional for retrieval ordering, plus a
//                    link_kind classification (article|masthead|social|
//                    tracking|other) used by feed-worker
//
// Unmatched mail falls through to the unmatched table for the operator-
// triage / LLM-classifier loop. We don't run postal-mime on unmatched —
// the raw_headers JSON captured at receive-time is enough for the
// classifier to identify the publisher, and spam to inbox@ that never
// matches shouldn't pay parse cost.

import PostalMime from 'postal-mime';

import { extractLinks, stripBoilerplate } from './parse';
import { domainOf, findSlugByHeaders } from './sender-map';
import type { Env } from './index';

const SNIPPET_MAX_CHARS = 8_000;
const BODY_HTML_MAX_CHARS = 200_000;
// Cap on body bytes fed into the synthetic-id hash. Bounds hash cost on
// multi-MB marketing HTML; well above the per-issue variance we need to
// detect (a paragraph or two of content is enough to distinguish issues).
const SYNTH_ID_BODY_SLICE = 4_096;

const CONTEXT_HEADERS = [
  'list-post',
  'list-unsubscribe',
  'reply-to',
  'sender',
  'list-owner',
  'list-help',
  'feedback-id',
  'x-mailer',
] as const;

function collectRawHeaders(message: ForwardableEmailMessage): string {
  const out: Record<string, string> = {};
  for (const name of CONTEXT_HEADERS) {
    const v = message.headers.get(name);
    if (v) out[name] = v;
  }
  return JSON.stringify(out);
}

async function synthesiseMessageId(parts: {
  subject: string | null;
  fromAddr: string | null;
  dateHeader: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
}): Promise<string> {
  // Fallback when the inbound mail lacks a Message-Id header. The hash
  // mixes parsed body CONTENT in alongside subject/from/Date — content
  // is the strong distinguishing signal for "is this the same logical
  // message?". Recurring newsletters like "Daily Briefing" can reuse
  // the same subject + the same stable list/sender headers across
  // distinct issues; an earlier headers-only synthesis collided on
  // (slug, message_id) and silently dropped the second issue via
  // ON CONFLICT DO NOTHING. Including the body (or HTML fallback)
  // makes redeliveries collide (same content → same id, idempotent)
  // while distinct issues stay distinct (different content → different
  // id). Date is a tiebreaker for the rare case where parsed bodies
  // are near-empty.
  const body = (parts.bodyText && parts.bodyText.length > 0
    ? parts.bodyText
    : (parts.bodyHtml ?? '')
  ).slice(0, SYNTH_ID_BODY_SLICE);
  const input = [
    parts.subject ?? '',
    parts.fromAddr ?? '',
    parts.dateHeader ?? '',
    body,
  ].join('\n');
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `<synth-${hex.slice(0, 32)}@inbox.socialisn.com>`;
}

interface IngestMeta {
  messageIdHeader: string | null;
  receivedAt: number;
  subject: string | null;
  rawHeaders: string;
  dateHeader: string | null;
  fromAddr: string | null;
}

async function ingestToD1(
  env: Env,
  message: ForwardableEmailMessage,
  headers: { listId: string | null; fromAddr: string | null; fromDomain: string | null },
  meta: IngestMeta,
): Promise<void> {
  const slug = await findSlugByHeaders(env.INBOX_DB, headers);

  if (!slug) {
    await env.INBOX_DB.prepare(
      'INSERT INTO unmatched (received_at, list_id, from_addr, subject, raw_headers) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(meta.receivedAt, headers.listId, headers.fromAddr, meta.subject, meta.rawHeaders)
      .run();
    console.log(
      `[email-worker] no sender_map match list_id=${headers.listId ?? '∅'} from=${headers.fromAddr ?? '∅'}; wrote to unmatched`,
    );
    return;
  }

  // Matched. Parse the body — postal-mime accepts the ReadableStream from
  // ForwardableEmailMessage.raw directly. Failures here propagate to the
  // outer try/catch in handleEmail, which logs but doesn't bounce the
  // message (personal-mirror forward still happens).
  const parsed = await PostalMime.parse(message.raw);
  // Extract links from the FULL body before truncation — otherwise plain-text-only
  // emails over SNIPPET_MAX_CHARS would silently lose links past the cutoff.
  const fullText = parsed.text ?? null;
  const fullHtml = parsed.html ?? null;
  const links = extractLinks({ html: fullHtml, text: fullText });

  // Resolve message_id AFTER parse so the synthetic fallback can mix in
  // content (see synthesiseMessageId). Spec-compliant senders supply
  // Message-Id directly and we never hit the synthetic path.
  const messageId =
    meta.messageIdHeader ??
    (await synthesiseMessageId({
      subject: meta.subject,
      fromAddr: meta.fromAddr,
      dateHeader: meta.dateHeader,
      bodyText: fullText,
      bodyHtml: fullHtml,
    }));

  const bodyText = fullText ? stripBoilerplate(fullText).slice(0, SNIPPET_MAX_CHARS) : null;
  // Cap body_html too — a 30 MB marketing email otherwise blows D1 row size.
  const bodyHtml = fullHtml ? fullHtml.slice(0, BODY_HTML_MAX_CHARS) : null;

  await env.INBOX_DB.prepare(
    'INSERT INTO inbox (slug, message_id, received_at, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
    .bind(slug, messageId, meta.receivedAt, meta.subject, bodyText, bodyHtml)
    .run();

  if (links.length > 0) {
    // D1 batch — one round-trip for N inserts. ON CONFLICT DO NOTHING guards
    // the composite PK (slug, message_id, link_pos) in case of replays;
    // FKs aren't enforced by D1 unless PRAGMA foreign_keys=ON.
    const stmts = links.map((link) =>
      env.INBOX_DB.prepare(
        'INSERT INTO inbox_links (slug, message_id, link_pos, link_url, link_kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      ).bind(slug, messageId, link.pos, link.url, link.kind),
    );
    await env.INBOX_DB.batch(stmts);
  }

  console.log(
    `[email-worker] matched slug=${slug} message_id=${messageId} body_text=${bodyText?.length ?? 0}c links=${links.length}`,
  );
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const listId = message.headers.get('list-id');
  const fromAddr = message.from ?? null;
  const fromDomain = domainOf(fromAddr);
  const subject = message.headers.get('subject');
  const dateHeader = message.headers.get('date');
  const rawHeaders = collectRawHeaders(message);
  const messageIdHeader = message.headers.get('message-id');
  const receivedAt = Date.now();

  // D1 ingestion is best-effort. A transient D1 outage, schema drift, or
  // any other write failure logs + continues so the personal-mirror forward
  // below still runs — losing ingestion enrichment is preferable to
  // losing the durable copy in the operator's inbox.
  try {
    await ingestToD1(
      env,
      message,
      { listId, fromAddr, fromDomain },
      { messageIdHeader, receivedAt, subject, rawHeaders, dateHeader, fromAddr },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[email-worker] D1 ingestion failed: ${msg}`);
  }

  // Optional secondary forward to a personal mailbox. Independent of D1
  // outcome — every inbound is mirrored when the env var is set, even if
  // the D1 write above threw. Forward failures are similarly logged +
  // swallowed so a misconfigured / unverified destination address doesn't
  // bounce the original email back to the sender.
  if (env.PERSONAL_FORWARD_ADDR) {
    try {
      await message.forward(env.PERSONAL_FORWARD_ADDR);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[email-worker] personal forward to ${env.PERSONAL_FORWARD_ADDR} failed: ${msg}`);
    }
  }
}
