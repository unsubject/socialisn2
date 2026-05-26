// HMAC-signed cookie helpers for binding the OAuth `state` token to the
// browser session that started the flow (CSRF defense for the authorization
// code flow). We don't need to encrypt the state token — it isn't secret —
// we only need to prove the callback came from the same browser that hit
// /authorize. An HMAC-SHA256 over the token with COOKIE_ENCRYPTION_KEY is
// sufficient and is the same purpose the CF reference example's
// `bindStateToSession` serves.
//
// Cookie value format: `${stateToken}.${base64url(hmac)}`.

const COOKIE_NAME = 'mcp_oauth_state';
const encoder = new TextEncoder();

function b64urlEncode(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return b64urlEncode(sig);
}

/** Constant-time string compare to avoid leaking the signature byte-by-byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

/**
 * Build a `Set-Cookie` header value carrying the signed state token.
 * Short-lived (10 min), HttpOnly, Secure, SameSite=Lax (Lax so the
 * redirect back from GitHub still presents the cookie on a top-level GET).
 */
export async function buildStateCookie(stateToken: string, key: string): Promise<string> {
  const sig = await hmac(key, stateToken);
  const value = `${stateToken}.${sig}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

/** Header value that clears the state cookie (one-time use). */
export function clearStateCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Read + verify the signed state cookie. Returns the embedded state token
 * iff the signature is valid, else null. Caller must also assert the token
 * equals the `state` query param from the callback.
 */
export async function readStateCookie(
  cookieHeader: string | null,
  key: string,
): Promise<string | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const raw = match.slice(COOKIE_NAME.length + 1);
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const token = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmac(key, token);
  if (!timingSafeEqual(sig, expected)) return null;
  return token;
}
