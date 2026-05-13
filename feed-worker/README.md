# socialisn2-feed-worker

Atom-feed reader half of the SPEC §6.9 bridge. Serves `https://inbox.socialisn.com/feeds/<slug>.xml` by querying the shared `socialisn2-inbox` D1 database. Read-only — the writer is the sibling `email-worker`.

## Manual one-time setup

1. Complete the `email-worker/` setup first (it creates the D1 database and applies the schema).
2. Paste the same `database_id` from `wrangler d1 create` into `feed-worker/wrangler.toml`.
3. `npm run deploy`.

CF route `inbox.socialisn.com/feeds/*` is owned by this Worker. The bare `inbox.socialisn.com` path is unrouted.

## Stage

Phase 0 scaffold. Current stub returns valid Atom with title + message_id + received_at per entry; full body rendering + joined `inbox_links` land in Phase 1 PR 4.
