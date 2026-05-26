// apiHandler: the authenticated MCP proxy.
//
// OAuthProvider only routes a request here AFTER it has validated the MCP
// access token (signature/expiry, and audience IF the client bound one via
// RFC 8707 `resource`). An unauthenticated /mcp request never reaches this
// handler — the provider returns 401 + WWW-Authenticate: Bearer
// resource_metadata=... itself. So by the time we run, the caller is the one
// allowed GitHub user (props are on ctx.props).
//
// Our job: forward the request to ${MCP_ORIGIN}${path}${query}, injecting the
// static upstream bearer from the secret, preserving the MCP transport
// headers (content-type, accept incl. text/event-stream, mcp-session-id,
// mcp-protocol-version), streaming both request and response bodies so SSE
// works, and NEVER letting the upstream bearer touch a log or error body.

import type { Env } from './types';

// Hop-by-hop / connection-scoped headers fetch must regenerate. We also drop
// the client's Authorization (we replace it) and cookies (browser-session
// state that has no business going upstream).
const STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
]);

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

export const proxyHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const incoming = new URL(request.url);
    // Preserve path + query exactly (path is /mcp; the provider passes the
    // original Request through unchanged).
    const upstream = new URL(env.MCP_ORIGIN);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    }
    // Inject the upstream static bearer server-side. This is the ONLY place
    // the secret is used; it must never be logged or echoed in a response.
    headers.set('Authorization', `Bearer ${env.SOCIALISN2_MCP_TOKEN}`);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstream.toString(), {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        // Required when streaming a request body in Workers/undici.
        ...(hasBody ? { duplex: 'half' } : {}),
        redirect: 'manual',
      } as RequestInit);
    } catch {
      // Never surface internals (which could include the upstream URL or
      // secret) in the error body.
      return new Response('Bad gateway: upstream MCP unreachable', { status: 502 });
    }

    // Stream the response body back unmodified (incl. text/event-stream).
    const respHeaders = new Headers();
    for (const [k, v] of upstreamRes.headers) {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v);
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  },
};
