// MCP Server construction. buildMcpServer(db, raw) returns an SDK Server
// instance with the 11 SPEC §11.4 tools registered against tools/list
// and tools/call. Transport (Fastify ↔ StreamableHTTPServerTransport
// bridge) lives in transport.ts; this module is pure wiring.
//
// `raw` is the postgres-js client behind drizzle. Only `run_now` needs
// it (for the orchestrator advisory lock — see src/orchestrator/lock.ts);
// other handlers stay `(db, args) => Promise<unknown>`.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Sql } from 'postgres';

import type { Db } from '../db/client.js';
import { TOOL_DEFINITIONS } from './schemas.js';
import {
  getCandidate,
  listCandidates,
  searchCandidates,
} from './tools/candidates.js';
import {
  deferCandidate,
  passCandidate,
  pickCandidate,
} from './tools/decisions.js';
import { addInfluencer, expandCompetitorList } from './tools/sources.js';
import { runNow, systemStatus } from './tools/runs.js';
import { compareAgainstArchive } from './tools/archive.js';

type ToolHandler = (db: Db, args: unknown) => Promise<unknown>;

/**
 * Build an MCP Server with all socialisn2 tools registered. The DB
 * handle is bound into each tool dispatch so tool handlers stay
 * `(db, args) => Promise<unknown>` for testability.
 */
export function buildMcpServer(db: Db, raw: Sql): Server {
  // run_now needs `raw` to acquire the orchestrator advisory lock on a
  // pinned connection (advisory locks are session-scoped — see
  // src/orchestrator/lock.ts). Bind it via a thin adapter so the
  // TOOL_HANDLERS map stays `(db, args)` for the other 10 tools.
  const TOOL_HANDLERS: Record<string, ToolHandler> = {
    list_candidates: listCandidates,
    get_candidate: getCandidate,
    pick: pickCandidate,
    pass: passCandidate,
    defer: deferCandidate,
    search_candidates: searchCandidates,
    expand_competitor_list: expandCompetitorList,
    add_influencer: addInfluencer,
    compare_against_archive: compareAgainstArchive,
    run_now: (boundDb, args) => runNow(boundDb, raw, args),
    system_status: systemStatus,
  };

  const server = new Server(
    { name: 'socialisn2', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // SDK's ListToolsResult type isn't exposed by name — cast through
    // unknown so the readonly tuple type from TOOL_DEFINITIONS
    // satisfies the runtime shape (the values match, only the strict
    // tuple-vs-array typing differs).
    tools: TOOL_DEFINITIONS as unknown as never[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      // SDK convention — return isError:true with a human message
      // rather than throwing (which would surface as a JSON-RPC error
      // and lose the tool-name context).
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await handler(db, args ?? {});
      // SPEC convention — tool returns get JSON-stringified into a
      // single text-block content. Callers parse the JSON.
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  });

  return server;
}
