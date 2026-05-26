// Shared types for the socialisn2 OAuth gateway Worker.
//
// `Env` describes the bindings/vars/secrets declared in wrangler.toml plus
// the `OAUTH_PROVIDER` helper that @cloudflare/workers-oauth-provider injects
// into env for handlers (used here by the consent handler to drive the flow).

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  // KV namespace the OAuthProvider uses for grants/tokens/clients/state.
  OAUTH_KV: KVNamespace;

  // Injected by OAuthProvider into env for the default (consent) handler.
  OAUTH_PROVIDER: OAuthHelpers;

  // --- vars (wrangler.toml [vars]) ---
  MCP_ORIGIN: string;
  ALLOWED_GITHUB_LOGIN: string;

  // --- secrets (wrangler secret put) ---
  SOCIALISN2_MCP_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  // Optional, recommended: numeric GitHub user id of the one allowed user.
  ALLOWED_GITHUB_ID?: string;
}

// Props minted into the MCP access token on successful consent. These are
// encrypted end-to-end by the provider and surface on `ctx.props` inside the
// API (proxy) handler. We keep only non-sensitive identity here — never the
// upstream MCP bearer (that comes from the secret server-side at proxy time).
export interface UserProps extends Record<string, unknown> {
  githubLogin: string;
  githubId: number;
  name: string | null;
}
