// feed-worker entry. Routes inbox.socialisn.com/feeds/<slug>.xml to the
// fetch handler; everything else 404s. Read-only over the shared D1 inbox.

import { handleFetch } from './feed-handler';

export interface Env {
  INBOX_DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
