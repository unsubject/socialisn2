// Phase 0 stub. Phase 1 PR 4 wires the full implementation:
//   - postal-mime parse → { html, text, attachments, headers }
//   - boilerplate strip (unsubscribe footers, tracking pixels, list-management headers)
//   - link extraction → INSERTs into `inbox_links` join table
//
// What this stub already does end-to-end (so the deploy + smoke test exercise
// the real flow on the real bindings):
//   - reads List-Id / From: headers + transport-context headers
//   - looks up the source slug via sender_map (List-Id → from_addr → from_domain)
//   - on match: INSERTs a minimal row into `inbox` (subject only; body fields TBD)
//   - on no match: INSERTs into `unmatched` for operator triage,
//     capturing transport-context headers in raw_headers JSON so the
//     classifier can identify publishers behind Mailchimp / SES / etc.

import { domainOf, findSlugByHeaders } from './sender-map';
import type { Env } from './index';

// Headers we capture into unmatched.raw_headers. When the From: domain is a
// transport provider (mcsv.net for Mailchimp, amazonses.com for AWS SES, …),
// the actual publisher identity hides in these. Keep the list focused —
// every entry is JSON-stringified into a single column, so adding rarely-
// useful headers just bloats the row.
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

  await env.INBOX_DB.prepare(
    'INSERT INTO inbox (slug, message_id, received_at, subject) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
    .bind(slug, meta.messageId, meta.receivedAt, meta.subject)
    .run();

  console.log(`[email-worker] matched slug=${slug} message_id=${meta.messageId}`);
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
