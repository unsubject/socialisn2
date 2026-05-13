# socialisn2-email-worker

Inbound side of the SPEC §6.9 Cloudflare Email Worker bridge. Receives newsletter mail sent to `inbox@socialisn.com`, matches it to a source slug via `sender_map`, and writes either to `inbox` (matched) or `unmatched` (operator triage).

The HTTP side that serves Atom feeds at `inbox.socialisn.com/feeds/<slug>.xml` is the sibling `feed-worker`.

## Manual one-time setup (before first deploy)

1. Confirm `socialisn.com` nameservers point to Cloudflare.
2. Cloudflare dashboard → Email Routing → enable for the zone.
3. Add a single Email Routing rule: `inbox@socialisn.com` → forward to this Worker.
4. Verify MX: `dig MX socialisn.com`.
5. `wrangler d1 create socialisn2-inbox` and paste the returned `database_id` into BOTH `email-worker/wrangler.toml` and `feed-worker/wrangler.toml` (the two Workers share one D1 database).
6. `npm run d1:apply:remote` to create the four tables.
7. `npm run deploy`.

## Operating: adding a new newsletter

1. Subscribe to the publisher's newsletter using `inbox@socialisn.com`.
2. First email arrives → no `sender_map` match → written to `unmatched`.
3. Inspect `unmatched` (via `wrangler d1 execute socialisn2-inbox --remote --command "SELECT * FROM unmatched ORDER BY received_at DESC LIMIT 10"`) and pick the `list_id` to map.
4. Insert one `sender_map` row + one `sources` row (or call the Phase 4 MCP tool `add_email_bridge_source`).
5. Subsequent emails route correctly. Re-processing of earlier `unmatched` rows for that List-Id into `inbox` is a Phase 1 PR 4 feature.

## Stage

Phase 0 scaffold. The `email-handler.ts` writes a minimal row (subject only); full `postal-mime` parse, boilerplate strip, and link extraction land in Phase 1 PR 4.
