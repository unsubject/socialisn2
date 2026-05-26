# socialisn2-oauth — MCP OAuth gateway Worker

An OAuth 2.1 gateway that lets the **claude.ai** web app connect to the
socialisn2 MCP. It implements the MCP Authorization spec
(OAuth 2.1 + RFC 7591 Dynamic Client Registration + PKCE S256 +
RFC 9728 Protected-Resource-Metadata) using
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
**v0.7.0**, gates consent behind a single GitHub user, and proxies
authenticated `/mcp` requests to the existing VPS MCP with that server's
static bearer injected **server-side**.

The VPS MCP itself is unchanged. This Worker sits in front of it.

```
claude.ai ──OAuth (DCR + PKCE S256)──▶  socialisn2-oauth Worker
                                          │  ├─ /authorize, /callback/github  → GitHub login, single-user gate
                                          │  ├─ /token, /register             → provided by the library
                                          │  ├─ /.well-known/oauth-*          → provided by the library
                                          │  └─ /mcp  (token-validated)       → proxy ─┐
                                          ▼                                            ▼
                                  OAUTH_KV (grants/tokens)        VPS MCP @ MCP_ORIGIN  (static bearer injected)
```

## How it works

- **`apiRoute: '/mcp'` → `apiHandler` (proxy).** The library validates the
  minted access token (signature, expiry, and audience when the client bound
  one via RFC 8707 `resource`) **before** the proxy runs. An unauthenticated
  `/mcp` request never reaches the proxy — the library returns `401` with
  `WWW-Authenticate: Bearer ... resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
  The proxy forwards method/body/MCP headers to `${MCP_ORIGIN}/mcp`, strips the
  client's `Authorization`/`Cookie`, injects `Authorization: Bearer
  $SOCIALISN2_MCP_TOKEN`, and streams the response (incl. `text/event-stream`).
- **`defaultHandler` (consent).** `GET /authorize` parses the MCP client's
  request, stashes it in KV under a random state token, sets an HMAC-signed
  state cookie (CSRF binding via `COOKIE_ENCRYPTION_KEY`), and 302s to GitHub
  (scope `read:user`). `GET /callback/github` verifies the state, exchanges the
  code, fetches the GitHub user, and **only if** the user matches the allow
  gate calls `completeAuthorization` to mint the MCP token — otherwise `403`.
  No anonymous issuance.

## Required configuration

### Secrets (`wrangler secret put <NAME>` — never commit)

| Secret | Purpose |
| --- | --- |
| `SOCIALISN2_MCP_TOKEN` | Static bearer for the upstream VPS MCP. Used only server-side in the proxy; never logged or returned. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret. |
| `COOKIE_ENCRYPTION_KEY` | HMAC key signing the OAuth-state cookie (CSRF binding). Use a long random string. |
| `ALLOWED_GITHUB_ID` | *(recommended)* Numeric GitHub user id of the one allowed user. Immutable; **takes precedence** over `ALLOWED_GITHUB_LOGIN`. Find yours: `curl https://api.github.com/users/<login>` → `id`. |

```sh
cd oauth-worker
npx wrangler secret put SOCIALISN2_MCP_TOKEN
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ALLOWED_GITHUB_ID   # recommended
```

### Vars (`wrangler.toml [vars]` — non-secret)

| Var | Value |
| --- | --- |
| `MCP_ORIGIN` | Origin of the VPS MCP, e.g. `https://mcp-origin.socialisn.com`. |
| `ALLOWED_GITHUB_LOGIN` | Fallback gate when `ALLOWED_GITHUB_ID` is unset (login is mutable — prefer the id). |

### KV namespace (`OAUTH_KV`)

The library stores grants, tokens, registered clients, and the auth-flow state
here. Create it and paste the id into `wrangler.toml`:

```sh
cd oauth-worker
npx wrangler kv namespace create OAUTH_KV
# → copy the printed id into wrangler.toml ([[kv_namespaces]] id = "…")
```

### GitHub OAuth app

Create a GitHub OAuth app (Settings → Developer settings → OAuth Apps):

- **Homepage URL:** `https://mcp.socialisn.com`
- **Authorization callback URL:** `https://mcp.socialisn.com/callback/github`

Use the resulting client id/secret for the secrets above.

## DNS cutover (do this only at launch)

This Worker is built and reviewed now but **not deployed**. The hostname
`mcp.socialisn.com` is claimed during cutover, not before.

1. **Repoint the VPS** so the existing MCP answers on `mcp-origin.socialisn.com`
   (new DNS record / Traefik host rule). Confirm `MCP_ORIGIN` in `wrangler.toml`
   matches.
2. **Provision** secrets + KV (above).
3. **Uncomment** the `routes` block in `wrangler.toml`
   (`{ pattern = "mcp.socialisn.com", custom_domain = true }`). A Workers Custom
   Domain auto-creates the DNS record + SSL cert at deploy time.
4. **Deploy** (below). `claude.ai` then connects to `https://mcp.socialisn.com/mcp`
   and self-registers via Dynamic Client Registration.

## Manual deploy

This Worker is intentionally **excluded** from
`.github/workflows/deploy-workers.yml` — that workflow auto-deploys on push to
`main` and would fail here before secrets/DNS exist. Deploy stays manual:

```sh
cd oauth-worker
npm ci
npm run typecheck
npm test
npx wrangler deploy
```

## Tests

```sh
npm test
```

Plain Node vitest (matching the sibling email-worker / feed-worker). The
provider imports `WorkerEntrypoint` from the runtime-only `cloudflare:workers`
module; `vitest.config.ts` aliases it to a no-op stub and inlines the package.
Covers: (a) proxy injects the upstream bearer + forwards MCP headers + strips
the client `Authorization`/`Cookie`, (b) the allow gate accepts the allowed
user and rejects others, (c) an unauthenticated `/mcp` request yields `401`
with a `WWW-Authenticate: Bearer … resource_metadata=…` header.

## Security checklist

- **PKCE S256 only** — `allowPlainPKCE: false`.
- **No implicit flow** — `allowImplicitFlow: false` (authorization-code only).
- **Short access-token TTL** — `accessTokenTTL: 3600` (1h).
- **Exact-match redirect allowlist** — enforced by the library per registered
  client; `claude.ai` registers `https://claude.ai/api/mcp/auth_callback` via DCR.
- **Single-user consent gate** — `ALLOWED_GITHUB_ID` (preferred) / `ALLOWED_GITHUB_LOGIN`;
  fails closed if neither is set. No anonymous token issuance.
- **CSRF binding** — OAuth state stored in KV (single-use, 10-min TTL) **and**
  bound to the browser via an HMAC-signed cookie (`COOKIE_ENCRYPTION_KEY`).
- **Upstream bearer never leaks** — sourced only from `SOCIALISN2_MCP_TOKEN`,
  injected server-side, stripped from inbound headers, never logged or echoed
  in error bodies (the `502` path returns a generic message).
- **Audience/resource binding** — the library enforces token audience against
  `/mcp` automatically **when the client sends an RFC 8707 `resource`**
  (claude.ai does, per the current MCP Authorization spec); `resourceMetadata.resource`
  advertises the resource identifier. ⚠️ If a client omits `resource`, the
  library does not bind an audience — there is no extra audience check in the
  proxy because the token is still validated (sig/expiry) and the consent gate
  already restricts who can ever hold a token.
