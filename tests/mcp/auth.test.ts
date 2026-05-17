// Unit tests for src/mcp/auth.ts. Pure — no DB, no Fastify.

import { describe, expect, it } from 'vitest';

import { checkBearer } from '../../src/mcp/auth.js';

const TOKEN = 'sek-prod-9f8a7e6c5b4a3d2e1f0e9d8c7b6a5f4e';

function req(headers: Record<string, string | undefined>): { headers: typeof headers } {
  return { headers };
}

describe('checkBearer', () => {
  it('accepts the exact expected token with Bearer scheme', () => {
    expect(checkBearer(req({ authorization: `Bearer ${TOKEN}` }) as never, TOKEN)).toBe(true);
  });

  it('is case-insensitive on the scheme (RFC 6750)', () => {
    expect(checkBearer(req({ authorization: `bearer ${TOKEN}` }) as never, TOKEN)).toBe(true);
    expect(checkBearer(req({ authorization: `BEARER ${TOKEN}` }) as never, TOKEN)).toBe(true);
  });

  it('rejects missing header', () => {
    expect(checkBearer(req({}) as never, TOKEN)).toBe(false);
  });

  it('rejects wrong scheme', () => {
    expect(checkBearer(req({ authorization: `Basic ${TOKEN}` }) as never, TOKEN)).toBe(false);
    expect(checkBearer(req({ authorization: TOKEN }) as never, TOKEN)).toBe(false);
  });

  it('rejects empty token after scheme', () => {
    expect(checkBearer(req({ authorization: 'Bearer ' }) as never, TOKEN)).toBe(false);
    expect(checkBearer(req({ authorization: 'Bearer' }) as never, TOKEN)).toBe(false);
  });

  it('rejects wrong token (constant-time path)', () => {
    // Same length as TOKEN — exercises the constant-time loop fully.
    const wrong = 'X'.repeat(TOKEN.length);
    expect(checkBearer(req({ authorization: `Bearer ${wrong}` }) as never, TOKEN)).toBe(false);
  });

  it('rejects token of wrong length', () => {
    expect(checkBearer(req({ authorization: 'Bearer x' }) as never, TOKEN)).toBe(false);
    expect(checkBearer(req({ authorization: `Bearer ${TOKEN}extra` }) as never, TOKEN)).toBe(false);
  });

  it('rejects non-string header', () => {
    expect(checkBearer(req({ authorization: undefined }) as never, TOKEN)).toBe(false);
  });
});
