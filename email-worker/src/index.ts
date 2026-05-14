// email-worker entry. Cloudflare Email Routing's catch-all rule on
// socialisn.com routes `inbox@socialisn.com` mail to this Worker's `email`
// handler. There is no `fetch` handler — Atom feeds are served by the
// separate feed-worker (sibling directory).

import { handleEmail } from './email-handler';

export interface Env {
  INBOX_DB: D1Database;
  // Optional secondary forward. CF Email Routing custom-address rules
  // support only ONE action (Worker), so duplicating delivery to a personal
  // mailbox lives here rather than in the routing config. The address must
  // be a verified destination on the same CF account; if unset (the default),
  // the Worker just writes to D1 and that's it.
  PERSONAL_FORWARD_ADDR?: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
