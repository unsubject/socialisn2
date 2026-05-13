// email-worker entry. Cloudflare Email Routing's catch-all rule on
// socialisn.com routes `inbox@socialisn.com` mail to this Worker's `email`
// handler. There is no `fetch` handler — Atom feeds are served by the
// separate feed-worker (sibling directory).

import { handleEmail } from './email-handler';

export interface Env {
  INBOX_DB: D1Database;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
