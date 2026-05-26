// socialisn2 OAuth gateway Worker — entry point.
//
// Wires @cloudflare/workers-oauth-provider@0.7.0:
//   apiRoute '/mcp'      → proxyHandler (authenticated; forwards to the VPS MCP)
//   defaultHandler       → consentHandler (GitHub OAuth single-user gate +
//                          OAuth UI endpoints /authorize, /callback/github)
//   authorizeEndpoint    '/authorize'  (served by defaultHandler)
//   tokenEndpoint        '/token'      (implemented by the provider)
//   clientRegistrationEndpoint '/register'  (RFC 7591 DCR — claude.ai self-registers)
//
// The provider also serves, for free:
//   /.well-known/oauth-authorization-server      (RFC 8414)
//   /.well-known/oauth-protected-resource[/mcp]  (RFC 9728)
// and returns 401 + `WWW-Authenticate: Bearer resource_metadata=...` on
// unauthenticated /mcp requests. It enforces token audience automatically
// when the client binds one via RFC 8707 `resource` (claude.ai does).
//
// Topology: this gateway lives at its OWN host (mcp-oauth.socialisn.com) and
// proxies authenticated /mcp calls to the unchanged VPS MCP at
// MCP_ORIGIN (https://mcp.socialisn.com), injecting the static bearer
// server-side. mcp.socialisn.com is left untouched — it also serves /status
// (ops-digest), /c/:id (Telegram digest links) and /feeds (RSS), which must
// keep working. Claude Code/Desktop keep using mcp.socialisn.com + bearer.
//
// Security posture (see README → Security checklist):
//   - allowImplicitFlow: false  → authorization-code only
//   - allowPlainPKCE: false     → PKCE S256 only
//   - accessTokenTTL: 1h, refresh enabled (default 30d) for long-lived clients
//   - redirect_uri allowlist is exact-match per registered client (DCR) — the
//     library enforces it; claude.ai registers https://claude.ai/api/mcp/auth_callback

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

import { consentHandler } from './consent';
import { proxyHandler } from './proxy';

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: proxyHandler,
  // Hono app exposes a `.fetch` method, so it satisfies the handler shape.
  defaultHandler: consentHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',

  // --- security knobs ---
  allowImplicitFlow: false,
  allowPlainPKCE: false, // PKCE S256 only.
  accessTokenTTL: 3600, // short-lived access tokens (1h).

  // RFC 9728 protected-resource-metadata advertised on the well-known route
  // and referenced by the WWW-Authenticate header. `resource` is THIS
  // gateway's MCP endpoint (its own host), so claude.ai's RFC 8707 `resource`
  // binding matches and the provider can audience-scope tokens to /mcp.
  resourceMetadata: {
    resource: 'https://mcp-oauth.socialisn.com/mcp',
    scopes_supported: ['mcp'],
  },
});
