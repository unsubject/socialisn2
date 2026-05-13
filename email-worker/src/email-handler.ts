// Phase 0 stub. Phase 1 PR 4 wires the full implementation:
//   - postal-mime parse → { html, text, attachments, headers }
//   - boilerplate strip (unsubscribe footers, tracking pixels, list-management headers)
//   - link extraction → INSERTs into `inbox_links` join table
//
// What this stub already does end-to-end (so the deploy + smoke test exercise
// the real flow on the real bindings):
//   - reads List-Id / From: headers
//   - looks up the source slug via sender_map (List-Id → from_addr → from_domain)
//   - on match: INSERTs a minimal row into `inbox` (subject only; body fields TBD)
//   - on no match: INSERTs into `unmatched` for operator triage

import { domainOf, findSlugByHeaders } from './sender-map';
import type { Env } from './index';

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

  const slug = await findSlugByHeaders(env.INBOX_DB, { listId, fromAddr, fromDomain });

  if (!slug) {
    await env.INBOX_DB.prepare(
      'INSERT INTO unmatched (received_at, list_id, from_addr, subject) VALUES (?, ?, ?, ?)',
    )
      .bind(receivedAt, listId, fromAddr, subject)
      .run();
    console.log(
      `[email-worker] no sender_map match list_id=${listId ?? '∅'} from=${fromAddr ?? '∅'}; wrote to unmatched`,
    );
    return;
  }

  await env.INBOX_DB.prepare(
    'INSERT INTO inbox (slug, message_id, received_at, subject) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
    .bind(slug, messageId, receivedAt, subject)
    .run();

  console.log(`[email-worker] matched slug=${slug} message_id=${messageId}`);
}
