// Fastify ↔ MCP HTTP transport bridge.
//
// Mounted as a Fastify plugin via `app.register(mcpPlugin, {prefix: '/mcp', ...})`
// so the bearer auth preHandler ONLY fires on /mcp routes (not on
// /healthz or /c/:id). POST /mcp hijacks the reply and delegates to
// the SDK's StreamableHTTPServerTransport.
//
// Stateless mode (sessionIdGenerator: undefined): each POST is one
// request/response, no session state. Matches our usage — tool calls
// are independent; we don't push server-initiated notifications.
//
// Fastify pre-parses JSON bodies. We pass request.body as the third
// arg to transport.handleRequest so the transport doesn't try to
// re-read the consumed stream (it'd hang).

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FastifyPluginAsync } from 'fastify';

import { checkBearer } from './auth.js';

export interface McpPluginOptions {
  /** Bearer token MCP clients must present in Authorization. */
  token: string;
  /** Factory returning the configured MCP Server (with tools wired). */
  buildServer: () => Server;
}

export const mcpPlugin: FastifyPluginAsync<McpPluginOptions> = async (
  app,
  opts,
) => {
  // SDK Server stays alive across requests (it's a tool registry +
  // dispatcher, stateless from the request's perspective). Each
  // request gets its OWN transport — a single shared transport in
  // stateless mode holds the in-flight response writer, and concurrent
  // requests would race on that state (one client's response could
  // land in the other's socket). Mirrors the SDK's own
  // simpleStreamableHttp example.
  const server = opts.buildServer();

  // Auth gates EVERY request to this prefix — including GET /mcp (used
  // by some MCP clients for the SSE channel in stateful mode; we
  // 401 it the same way as POST).
  app.addHook('preHandler', async (req, reply) => {
    if (!checkBearer(req, opts.token)) {
      return reply
        .code(401)
        .type('application/json')
        .send({ error: 'unauthorized' });
    }
  });

  app.post('/', async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      // reply.hijack() tells Fastify "I'm taking over reply.raw; don't
      // try to call reply.send for me." Without it, Fastify would
      // attempt to also send a response after the transport wrote one.
      reply.hijack();
      // Pass request.body as the third arg — Fastify has pre-parsed
      // the JSON body, so the transport must not try to re-read the
      // already-consumed stream (it would hang waiting for bytes).
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
    }
  });

  // GET /mcp is used by stateful-mode clients for SSE; in stateless
  // mode the SDK returns 405. Still route it so auth fires.
  app.get('/', async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw);
    } finally {
      await transport.close();
    }
  });
};
