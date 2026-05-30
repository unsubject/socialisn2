// End-to-end test for the MCP route via Fastify's app.inject().
//
// Exercises:
//   - bearer-auth preHandler (401 for missing/wrong/right tokens)
//   - tools/list JSON-RPC envelope returns the 11 expected tools
//   - tools/call routes to the right handler and round-trips the
//     result through the SDK's StreamableHTTPServerTransport
//
// Real PG (small seed) so the routed tools have something to read.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import * as schema from '../../src/db/schema.js';
import { assertDestructiveAllowed } from '../helpers/destructive-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
const MCP_TOKEN = 'integration-test-token-do-not-use-in-prod';
const ORIGINAL_ENV = { ...process.env };

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: { content?: Array<{ type: string; text: string }>; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

describe.skipIf(!DATABASE_URL)('mcp integration via POST /mcp', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;

  beforeAll(async () => {
    assertDestructiveAllowed(DATABASE_URL!);
    client = postgres(DATABASE_URL!);
    db = drizzle(client, { schema });
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const f of readdirSync(resolve(process.cwd(), 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
      await client.unsafe(readFileSync(join(resolve(process.cwd(), 'migrations'), f), 'utf-8'));
    }
    // Seed: one source + cluster so candidate-related tools can read.
    const sourceId = uuidv7();
    await client`
      INSERT INTO sources (id, kind, url, name, domains)
      VALUES (${sourceId}, 'rss', 'https://example.com/feed.xml',
              'integration-test', ARRAY['economy']::text[])
    `;
  });

  afterAll(async () => {
    await client.end();
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(async () => {
    await client.unsafe('TRUNCATE TABLE candidates CASCADE');
    process.env.SOCIALISN2_MCP_TOKEN = MCP_TOKEN;
    app = buildApp(db, client);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function rpc(method: string, params: unknown, id: number = 1): JsonRpcRequest {
    return { jsonrpc: '2.0', id, method, params };
  }

  function parseRpcBody(
    body: string,
    headers: Record<string, string | string[] | number | undefined>,
  ): JsonRpcResponse {
    const ctRaw = headers['content-type'];
    const ct = typeof ctRaw === 'string' ? ctRaw : String(ctRaw ?? '');
    if (ct.includes('text/event-stream')) {
      // SSE format — find the last `data: {...}` line and parse it.
      const lines = body.split(/\r?\n/);
      const dataLines = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice('data:'.length).trim());
      const last = dataLines[dataLines.length - 1];
      if (!last) throw new Error(`no SSE data lines in body: ${body.slice(0, 200)}`);
      return JSON.parse(last) as JsonRpcResponse;
    }
    return JSON.parse(body) as JsonRpcResponse;
  }

  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------

  it('POST /mcp without Authorization → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: rpc('tools/list', {}),
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /mcp with wrong token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong',
      },
      payload: rpc('tools/list', {}),
    });
    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // tools/list
  // -------------------------------------------------------------------------

  it('tools/list returns all 11 SPEC §11.4 tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${MCP_TOKEN}`,
      },
      payload: rpc('tools/list', {}),
    });
    expect(res.statusCode).toBe(200);
    const parsed = parseRpcBody(res.body, res.headers);
    const tools = parsed.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_influencer',
        'compare_against_archive',
        'defer',
        'expand_competitor_list',
        'get_candidate',
        'list_candidates',
        'pass',
        'pick',
        'run_now',
        'search_candidates',
        'system_status',
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // tools/call routing
  // -------------------------------------------------------------------------

  it('tools/call list_candidates routes to the candidates tool and returns JSON in the text content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${MCP_TOKEN}`,
      },
      payload: rpc('tools/call', { name: 'list_candidates', arguments: {} }),
    });
    expect(res.statusCode).toBe(200);
    const parsed = parseRpcBody(res.body, res.headers);
    const content = parsed.result?.content?.[0];
    expect(content?.type).toBe('text');
    const payload = JSON.parse(content?.text ?? '{}') as { candidates: unknown[] };
    expect(payload.candidates).toEqual([]);
  });

  it('tools/call system_status returns the snapshot shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${MCP_TOKEN}`,
      },
      payload: rpc('tools/call', { name: 'system_status', arguments: {} }),
    });
    expect(res.statusCode).toBe(200);
    const parsed = parseRpcBody(res.body, res.headers);
    const payload = JSON.parse(parsed.result?.content?.[0]?.text ?? '{}') as {
      last_run: unknown;
      cost_today_usd: number;
      queue_depth: number;
      candidate_pool_size: number;
    };
    expect(payload.last_run).toBeNull();
    expect(payload.cost_today_usd).toBe(0);
    expect(payload.queue_depth).toBe(0);
    expect(payload.candidate_pool_size).toBe(0);
  });

  it('tools/call unknown tool returns isError', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${MCP_TOKEN}`,
      },
      payload: rpc('tools/call', { name: 'nonexistent_tool', arguments: {} }),
    });
    expect(res.statusCode).toBe(200);
    const parsed = parseRpcBody(res.body, res.headers);
    const text = parsed.result?.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown tool');
  });

  it('concurrent tools/call requests both succeed (per-request transport, no shared response-writer race)', async () => {
    const send = (id: number) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${MCP_TOKEN}`,
        },
        payload: rpc('tools/call', { name: 'system_status', arguments: {} }, id),
      });
    const [a, b] = await Promise.all([send(1), send(2)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const pa = parseRpcBody(a.body, a.headers);
    const pb = parseRpcBody(b.body, b.headers);
    // Each response carries the id of its OWN request — a shared
    // transport would have one request's writer leak into the other,
    // producing duplicated or interleaved bodies.
    expect(pa.id).toBe(1);
    expect(pb.id).toBe(2);
    expect(pa.result?.content?.[0]?.text).toBeDefined();
    expect(pb.result?.content?.[0]?.text).toBeDefined();
  });
});
