// Bearer-token check for the MCP HTTP endpoint.
//
// Single token in env (SOCIALISN2_MCP_TOKEN) — single-user MCP per
// SPEC §11.4. Caller (transport.ts) wires this into a Fastify
// preHandler scoped to the /mcp prefix so the check doesn't fire on
// /healthz or /c/:id.

import type { FastifyRequest } from 'fastify';

/**
 * Check the Authorization header against the expected bearer token.
 * Uses a constant-time string comparison to defeat the trivially-
 * exploitable timing oracle of `===` (which short-circuits on the
 * first mismatched character — an attacker can iteratively guess the
 * token one byte at a time by measuring response latency).
 *
 * Returns false on any failure mode (missing header, wrong scheme,
 * wrong token). Caller maps false → 401.
 */
export function checkBearer(req: FastifyRequest, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  // RFC 6750: case-insensitive scheme name; spaces separate scheme + token.
  const space = header.indexOf(' ');
  if (space < 0) return false;
  const scheme = header.slice(0, space);
  const token = header.slice(space + 1);
  if (scheme.toLowerCase() !== 'bearer') return false;
  if (token.length === 0) return false;
  return constantTimeEqual(token, expectedToken);
}

/**
 * Constant-time string equality. Runs in time proportional to
 * `Math.max(a.length, b.length)` regardless of where (or whether) the
 * strings diverge — the loop never short-circuits.
 *
 * For bytes-already-known (the token vs the configured value, both
 * ASCII), `charCodeAt` is safe; we don't need a buffer-based compare
 * unless we ever support multi-codepoint tokens.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
