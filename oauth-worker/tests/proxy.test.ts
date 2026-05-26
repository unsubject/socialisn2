// Proxy handler: asserts the upstream bearer is injected, MCP transport
// headers are forwarded, and the client's own Authorization/Cookie are
// stripped. We mock global fetch and call proxyHandler.fetch directly with a
// stub ExecutionContext (the OAuthProvider would normally pre-validate the
// token and set ctx.props; the proxy itself doesn't read props, so a stub is
// fine for forwarding behavior).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyHandler } from '../src/proxy';
import type { Env } from '../src/types';

const env = {
  MCP_ORIGIN: 'https://mcp-origin.socialisn.com',
  SOCIALISN2_MCP_TOKEN: 'upstream-secret-bearer',
} as unknown as Env;

const ctx = {} as ExecutionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxyHandler', () => {
  it('injects the upstream bearer and forwards MCP transport headers', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured.url = url;
        captured.init = init;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const req = new Request('https://mcp.socialisn.com/mcp?x=1', {
      method: 'POST',
      headers: {
        // The client's own bearer (the minted MCP token) must NOT leak upstream.
        Authorization: 'Bearer client-mcp-token',
        Cookie: 'mcp_oauth_state=should-not-forward',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': 'sess-123',
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    const res = await proxyHandler.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    // Path + query preserved against MCP_ORIGIN.
    expect(captured.url).toBe('https://mcp-origin.socialisn.com/mcp?x=1');

    const outHeaders = captured.init!.headers as Headers;
    // Upstream bearer injected from the secret.
    expect(outHeaders.get('authorization')).toBe('Bearer upstream-secret-bearer');
    // The client's token did not pass through.
    expect(outHeaders.get('authorization')).not.toContain('client-mcp-token');
    // Browser cookie stripped.
    expect(outHeaders.get('cookie')).toBeNull();
    // MCP transport headers forwarded verbatim.
    expect(outHeaders.get('content-type')).toBe('application/json');
    expect(outHeaders.get('accept')).toBe('application/json, text/event-stream');
    expect(outHeaders.get('mcp-session-id')).toBe('sess-123');
    expect(outHeaders.get('mcp-protocol-version')).toBe('2025-03-26');
    // Method preserved.
    expect(captured.init!.method).toBe('POST');
  });

  it('never echoes the upstream bearer or origin when upstream is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED mcp-origin.socialisn.com');
      }),
    );

    const req = new Request('https://mcp.socialisn.com/mcp', {
      method: 'POST',
      body: '{}',
    });
    const res = await proxyHandler.fetch(req, env, ctx);
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).not.toContain('upstream-secret-bearer');
    expect(body).not.toContain('mcp-origin.socialisn.com');
  });

  it('returns the upstream status and streams the body back unmodified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('data: {"event":"x"}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const req = new Request('https://mcp.socialisn.com/mcp', { method: 'POST', body: '{}' });
    const res = await proxyHandler.fetch(req, env, ctx);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('data: {"event":"x"}');
  });
});
