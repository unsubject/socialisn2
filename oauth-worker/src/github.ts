// Thin GitHub OAuth helpers + the single-user allow gate.
//
// Kept dependency-free (no Octokit) — two fetch calls and a JSON parse. The
// allow decision is factored into a pure function (`isAllowedUser`) so it can
// be unit-tested without hitting GitHub.

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

/** Build the GitHub authorize URL. Scope is read:user (identity only). */
export function buildGithubAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('scope', 'read:user');
  u.searchParams.set('state', params.state);
  // Re-prompt so a wrong already-authorized account can't silently pass.
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

/** Exchange the authorization code for a GitHub access token. */
export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string | null> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/** Fetch the authenticated GitHub user with a user access token. */
export async function fetchGithubUser(accessToken: string): Promise<GithubUser | null> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'socialisn2-oauth-worker',
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id: number; login: string; name: string | null };
  if (typeof data.id !== 'number' || typeof data.login !== 'string') return null;
  return { id: data.id, login: data.login, name: data.name ?? null };
}

/**
 * The single-user gate. Pure + total so both branches are unit-tested.
 *
 * Precedence: if ALLOWED_GITHUB_ID is configured, the numeric id MUST match
 * (immutable, can't be hijacked by a username change). Otherwise fall back to
 * a case-insensitive login match against ALLOWED_GITHUB_LOGIN.
 */
export function isAllowedUser(
  user: GithubUser,
  allowed: { id?: string | undefined; login?: string | undefined },
): boolean {
  const allowedId = allowed.id?.trim();
  if (allowedId) {
    return String(user.id) === allowedId;
  }
  const allowedLogin = allowed.login?.trim();
  if (allowedLogin) {
    return user.login.toLowerCase() === allowedLogin.toLowerCase();
  }
  // Neither configured → fail closed. Never issue anonymously.
  return false;
}
