// defaultHandler: the consent / browser-facing surface of the OAuth gateway.
//
// Routes:
//   GET /authorize        — parse the MCP client's auth request, stash it in
//                           KV under a random state token, set an HMAC-signed
//                           state cookie, 302 to GitHub (scope read:user).
//   GET /callback/github  — verify state (query == signed cookie), exchange
//                           the code, fetch the GitHub user, and ONLY if the
//                           user matches the configured allow-gate call
//                           completeAuthorization to mint the MCP token.
//                           Otherwise 403. No anonymous issuance.
//
// We deliberately skip the approval-dialog UI / approved-client cookie from
// the CF reference example: this is a single-user gate, the GitHub login
// screen IS the consent step. The state cookie still provides CSRF binding.
//
// parseAuthRequest / completeAuthorization come from env.OAUTH_PROVIDER,
// injected by OAuthProvider into the default handler's env.

import { Hono } from 'hono';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';

import type { Env } from './types';
import { buildStateCookie, clearStateCookie, readStateCookie } from './cookies';
import {
  buildGithubAuthorizeUrl,
  exchangeCode,
  fetchGithubUser,
  isAllowedUser,
} from './github';

const STATE_TTL_SECONDS = 600; // 10 min; matches the cookie Max-Age.

const app = new Hono<{ Bindings: Env }>();

app.get('/authorize', async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text('Invalid OAuth request: missing client_id', 400);
  }

  // Random, opaque state token. KV holds the parsed auth request; the signed
  // cookie binds this token to the browser.
  const stateToken = crypto.randomUUID();
  await c.env.OAUTH_KV.put(`authstate:${stateToken}`, JSON.stringify(oauthReqInfo), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const redirectUri = new URL('/callback/github', c.req.url).href;
  const location = buildGithubAuthorizeUrl({
    clientId: c.env.GITHUB_CLIENT_ID,
    redirectUri,
    state: stateToken,
  });
  const cookie = await buildStateCookie(stateToken, c.env.COOKIE_ENCRYPTION_KEY);

  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Set-Cookie': cookie },
  });
});

app.get('/callback/github', async (c) => {
  const queryState = c.req.query('state');
  const code = c.req.query('code');
  if (!queryState || !code) {
    return c.text('Invalid callback: missing state or code', 400);
  }

  // CSRF: the signed cookie token must validate AND equal the query state.
  const cookieState = await readStateCookie(
    c.req.header('Cookie') ?? null,
    c.env.COOKIE_ENCRYPTION_KEY,
  );
  if (!cookieState || cookieState !== queryState) {
    return c.text('Invalid or missing OAuth state', 400);
  }

  // Single-use: pull + delete the stashed auth request.
  const stored = await c.env.OAUTH_KV.get(`authstate:${queryState}`);
  if (!stored) {
    return c.text('OAuth state expired or unknown', 400);
  }
  await c.env.OAUTH_KV.delete(`authstate:${queryState}`);
  const oauthReqInfo = JSON.parse(stored) as AuthRequest;

  const redirectUri = new URL('/callback/github', c.req.url).href;
  const ghToken = await exchangeCode({
    clientId: c.env.GITHUB_CLIENT_ID,
    clientSecret: c.env.GITHUB_CLIENT_SECRET,
    code,
    redirectUri,
  });
  if (!ghToken) {
    return c.text('GitHub token exchange failed', 502);
  }

  const user = await fetchGithubUser(ghToken);
  if (!user) {
    return c.text('Failed to fetch GitHub user', 502);
  }

  // THE GATE. Anyone other than the one configured user is refused. The
  // 403 body intentionally carries no identity detail.
  if (
    !isAllowedUser(user, {
      id: c.env.ALLOWED_GITHUB_ID,
      login: c.env.ALLOWED_GITHUB_LOGIN,
    })
  ) {
    return new Response('Forbidden: this MCP is restricted to a single user.', {
      status: 403,
      headers: { 'Set-Cookie': clearStateCookie() },
    });
  }

  // Mint the MCP access token. props surface on ctx.props in the proxy.
  // We do NOT carry the GitHub token or the upstream MCP bearer in props.
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: String(user.id),
    metadata: { label: user.login },
    scope: oauthReqInfo.scope,
    props: {
      githubLogin: user.login,
      githubId: user.id,
      name: user.name,
    },
  });

  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo, 'Set-Cookie': clearStateCookie() },
  });
});

export { app as consentHandler };
