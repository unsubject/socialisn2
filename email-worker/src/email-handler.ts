// Production email handler. Receives an inbound RFC 5322 message via
// Cloudflare Email Routing, looks up the publisher slug via the
// sender_map index, and writes:
//
//   - inbox          one row per matched email (slug + message_id PK,
//                    plus subject, body_text snippet, body_html)
//   - inbox_links    one row per distinct link extracted from the body,
//                    ordinal-positional for retrieval ordering
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

async function ingestToD1(
  env: Env,
  message: ForwardableEmailMessage,
  headers: { listId: string | null; fromAddr: string | null; fromDomain: string | null },
  meta: { messageId: string; receivedAt: number; subject: string | null; rawHeaders: string },
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
  const bodyText = parsed.text ? stripBoilerplate(parsed.text).slice(0, SNIPPET_MAX_CHARS) : null;
  const bodyHtml = parsed.html ?? null;

  await env.INBOX_DB.prepare(
    'INSERT INTO inbox (slug, message_id, received_at, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
    .bind(slug, meta.messageId, meta.receivedAt, meta.subject, bodyText, bodyHtml)
    .run();

  const links = extractLinks({ html: bodyHtml, text: bodyText });
  if (links.length > 0) {
    // D1 batch — one round-trip for N inserts. ON CONFLICT DO NOTHING in
    // case the inbox INSERT skipped via the (slug, message_id) PK
    // collision: we'd still try to insert links and would race the FK.
    const stmts = links.map((link) =>
      env.INBOX_DB.prepare(
        'INSERT INTO inbox_links (slug, message_id, link_pos, link_url) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      ).bind(slug, meta.messageId, link.pos, link.url),
    );
    await env.INBOX_DB.batch(stmts);
  }

  console.log(
    `[email-worker] matched slug=${slug} message_id=${meta.messageId} body_text=${bodyText?.length ?? 0}c links=${links.length}`,
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
  const messageId = message.headers.get('message-id') ?? crypto.randomUUID();
  const receivedAt = Date.now();
  const rawHeaders = collectRawHeaders(message);

  // D1 ingestion is best-effort. A transient D1 outage, schema drift, or
  // any other write failure logs + continues so the personal-mirror forward
  // below still runs — losing ingestion enrichment is preferable to
  // losing the durable copy in the operator's inbox.
  try {
    await ingestToD1(
      env,
      message,
      { listId, fromAddr, fromDomain },
      { messageId, receivedAt, subject, rawHeaders },
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
