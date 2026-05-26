// Wiring test: an unauthenticated request to the apiRoute (/mcp) must yield
// 401 with a `WWW-Authenticate: Bearer ... resource_metadata=...` header.
// @cloudflare/workers-oauth-provider@0.7.0 produces this itself; this test
// proves the OAuthProvider is wired correctly (apiRoute, resourceMetadata)
// and that the proxy is never reached without a token.

import { describe, expect, it, vi } from 'vitest';

// The proxy must NOT run for an unauthenticated request. If it did, this stub
// would let us detect it (and fail the assertions below) rather than hitting
// the network.
vi.mock('../src/proxy', () => ({
  proxyHandler: {
    fetch: vi.fn(async () => new Response('PROXY SHOULD NOT RUN', { status: 200 })),
  },
}));

import worker from '../src/index';

// Minimal in-memory KV so OAuthProvider construction/usage is satisfied.
function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

const env = {
  OAUTH_KV: makeKV(),
  MCP_ORIGIN: 'https://mcp-origin.socialisn.com',
  ALLOWED_GITHUB_LOGIN: 'simoncf',
  SOCIALISN2_MCP_TOKEN: 'x',
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'x',
  COOKIE_ENCRYPTION_KEY: 'x',
} as unknown as Parameters<typeof worker.fetch>[1];

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

describe('unauthenticated /mcp', () => {
  it('returns 401 with a WWW-Authenticate resource_metadata header', async () => {
    const req = new Request('https://mcp.socialisn.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get('WWW-Authenticate') ?? '';
    expect(wwwAuth.toLowerCase()).toContain('bearer');
    expect(wwwAuth).toContain('resource_metadata=');
  });

  it('serves RFC 9728 protected-resource metadata at the well-known path', async () => {
    const req = new Request('https://mcp.socialisn.com/.well-known/oauth-protected-resource/mcp');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource?: string };
    expect(typeof body.resource).toBe('string');
  });
});
