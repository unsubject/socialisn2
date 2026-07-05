// Fastify entry per SPEC §4.2 + §16. Exposes:
//
//   GET /healthz   — liveness probe (no DB roundtrip)
//   GET /status    — observability snapshot (open; consumed by ops-digest)
//   GET /c/:id     — candidate detail HTML page (SPEC §11.2 link target)
//
// The Phase 4 PR 3 MCP server and the Phase 4 PR 2 Telegram bot add
// their own surfaces — those are independent Node processes / Fastify
// plugins. This module is intentionally small.
//
// `buildApp(db)` returns the Fastify instance without listening, so
// tests can use `app.inject({ method, url })` to exercise routes
// without a TCP port. `src/index.ts` is the deployment entry — imports
// `buildApp` and calls `app.listen()`.

import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Sql } from 'postgres';

import { env } from './config/env.js';
import type { Db } from './db/client.js';
import { pingDatabase } from './lib/healthcheck.js';
import { buildStatus } from './lib/status.js';
import { UUID_RE } from './lib/uuid.js';
import { buildMcpServer } from './mcp/server.js';
import { mcpPlugin } from './mcp/transport.js';
import { renderBriefNotFound, renderBriefPage } from './rss/render-brief.js';
import { renderDetail, renderNotFound } from './rss/render-detail.js';
import type { BriefPitch } from './scoring/brief.js';

// Strict 8-4-4-4-12 hex UUID pattern. The route uses this as a
// pre-filter BEFORE the DB query so a UUID-shaped-but-syntactically-
// invalid path (e.g. last group not 12 hex chars) becomes a clean 404
// instead of a PG "invalid input syntax for type uuid" → Fastify 500.
// Raw row shapes — `db.execute<T>` does not run pg type parsers, so
// timestamptz columns come back as strings and arrays come back as
// JS arrays (postgres-js handles the latter automatically).
type CandidateDetailRow = {
  id: string;
  cluster_id: string;
  headline: string;
  context_summary: string;
  primary_domain: string;
  domains: string[];
  keywords: string[];
  tags: string[];
  temperature: string;
  trajectory: string;
  is_exclusive: boolean;
  archive_overlap: number;
  archive_overlap_links: unknown;
  curation_rationale: string | null;
  created_at: string;
};

type ClusterSourceRow = {
  name: string;
  url: string;
  published_at: string;
};

type BriefPageRow = {
  week_of: string;
  pitches: BriefPitch[];
  model: string;
  created_at: string;
  updated_at: string | null;
};

// /brief/:weekOf path param: strict YYYY-MM-DD (or the literal
// 'latest') — same 500-avoidance rationale as UUID_RE on /c/:id.
const WEEK_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `raw` is the postgres-js client behind drizzle. Required so the MCP
 * `run_now` tool can acquire the orchestrator advisory lock on a pinned
 * connection (see src/orchestrator/lock.ts). Tests that don't exercise
 * MCP can pass any postgres-js client — the lock is only touched by the
 * run_now path.
 */
export function buildApp(db: Db, raw: Sql): FastifyInstance {
  const app = Fastify({
    // Disable Fastify's default JSON-line logger — workers in this repo
    // log via console.* and we want a single log shape per process. Ops
    // can flip the env if structured logs are wanted.
    logger: process.env.FASTIFY_LOGGER === '1',
    // Keep error responses terse — the default JSON is fine but we
    // override /c/:id to render HTML on 404.
    disableRequestLogging: true,
  });

  // Liveness + DB-reachability probe. Pre-Phase 2.c this returned a
  // hardcoded {ok:true} the moment Fastify booted — making docker
  // healthcheck + Traefik probe both flip green even when the DB was
  // unreachable. Now does a `SELECT 1` with a 2s timeout. On DB-side
  // failure: 503 + a redacted reason. The Traefik label
  // (`loadbalancer.healthcheck.path=/healthz`) flips the router to 503
  // until the next probe is green, which is the friendlier signal to
  // CF and clients than serving requests against a broken pool.
  app.get('/healthz', async (_req, reply) => {
    // pingDatabase opens a dedicated 1-connection client per probe so
    // a hanging probe doesn't pin a slot in the app's request-serving
    // pool. Connection string comes from env.databaseUrl() — same
    // source the pool uses.
    const result = await pingDatabase();
    if (!result.ok) {
      return reply.code(503).send({
        ok: false,
        db: 'unreachable',
        latency_ms: result.latencyMs,
        error: result.error,
      });
    }
    return reply.send({ ok: true, db: 'reachable', latency_ms: result.latencyMs });
  });

  // Open by design — see ADR-001/PR Obs-1 discussion. Surface is
  // observability-only (no mutators, no secrets). ops-digest polls
  // this; ad-hoc `curl mcp.socialisn.com/status` is the operator path.
  app.get('/status', async () => buildStatus(db));

  app.get<{ Params: { id: string } }>('/c/:id', async (req, reply) => {
    const id = req.params.id;

    // Strict UUID pre-filter — rejects anything PG's UUID cast would
    // also reject, before we hit the DB. A loose check would let
    // pathological-but-hex strings through, and an uncaught
    // "invalid input syntax for type uuid" error from the candidate
    // fetch would surface as a 500 rather than the intended 404.
    if (!UUID_RE.test(id)) {
      return reply.code(404).type('text/html; charset=utf-8').send(renderNotFound(id));
    }

    const candidateRows = await db.execute<CandidateDetailRow>(sql`
      SELECT id, cluster_id, headline, context_summary,
             primary_domain, domains, keywords, tags,
             temperature, trajectory, is_exclusive,
             archive_overlap, archive_overlap_links,
             curation_rationale, created_at
      FROM candidates
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = candidateRows[0];
    if (!row) {
      return reply.code(404).type('text/html; charset=utf-8').send(renderNotFound(id));
    }

    const sourceRows = await db.execute<ClusterSourceRow>(sql`
      SELECT s.name, ri.url, ri.published_at
      FROM items i
      JOIN raw_items ri ON ri.id = i.raw_item_id
      JOIN sources s    ON s.id  = ri.source_id
      WHERE i.cluster_id = ${row.cluster_id}
      ORDER BY ri.published_at ASC
    `);

    // archive_overlap_links is jsonb; the orchestrator stores
    // { overlap, flagRelatedToRecentWork, links: [...] }. Defensive
    // narrowing — the field is nullable in the schema, and a bad
    // payload shouldn't 500 the whole page.
    const archiveLinks = extractArchiveLinks(row.archive_overlap_links);

    const html = renderDetail({
      candidate: {
        id: row.id,
        headline: row.headline,
        contextSummary: row.context_summary,
        primaryDomain: row.primary_domain,
        domains: row.domains,
        keywords: row.keywords,
        tags: row.tags,
        temperature: row.temperature,
        trajectory: row.trajectory,
        isExclusive: row.is_exclusive,
        archiveOverlap: row.archive_overlap,
        curationRationale: row.curation_rationale,
        createdAt: new Date(row.created_at),
      },
      sources: sourceRows.map((s) => ({
        name: s.name,
        url: s.url,
        publishedAt: new Date(s.published_at),
      })),
      archiveLinks,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Weekly Ideation Brief page (redesign P1) — the brief.xml <link>
  // target. `/brief/latest` serves the newest row for bookmarking.
  app.get<{ Params: { weekOf: string } }>('/brief/:weekOf', async (req, reply) => {
    const weekOf = req.params.weekOf;
    if (weekOf !== 'latest' && !WEEK_OF_RE.test(weekOf)) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderBriefNotFound(weekOf));
    }
    const rows =
      weekOf === 'latest'
        ? await db.execute<BriefPageRow>(sql`
            SELECT week_of, pitches, model, created_at, updated_at
            FROM briefs ORDER BY week_of DESC LIMIT 1
          `)
        : await db.execute<BriefPageRow>(sql`
            SELECT week_of, pitches, model, created_at, updated_at
            FROM briefs WHERE week_of = ${weekOf}::date LIMIT 1
          `);
    const row = rows[0];
    if (!row) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderBriefNotFound(weekOf));
    }
    const html = renderBriefPage({
      weekOf: String(row.week_of).slice(0, 10),
      pitches: row.pitches,
      model: row.model,
      createdAt: new Date(row.created_at),
      updatedAt: row.updated_at ? new Date(row.updated_at) : null,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // MCP server (SPEC §11.4). Gated on env — empty SOCIALISN2_MCP_TOKEN
  // disables the mount so non-prod environments (tests, dev) skip the
  // bearer-protected route. Mounted with prefix=/mcp so the bearer
  // preHandler in mcpPlugin scopes ONLY to /mcp routes, not the
  // /healthz or /c/:id surfaces.
  const mcpToken = env.socialisn2McpToken();
  if (mcpToken) {
    void app.register(mcpPlugin, {
      prefix: '/mcp',
      token: mcpToken,
      buildServer: () => buildMcpServer(db, raw),
    });
  }

  return app;
}

interface ArchiveLinkShape {
  title: string;
  url: string;
  similarity: number;
  type: string;
}

function extractArchiveLinks(raw: unknown): ArchiveLinkShape[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  // Orchestrator wraps the payload as { overlap, flag…, links: [...] };
  // older runs may have stored a bare array. Tolerate both.
  const arr = Array.isArray(obj.links)
    ? obj.links
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  return arr.flatMap((entry): ArchiveLinkShape[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    if (
      typeof e.title !== 'string' ||
      typeof e.url !== 'string' ||
      typeof e.similarity !== 'number' ||
      typeof e.type !== 'string'
    ) {
      return [];
    }
    return [{ title: e.title, url: e.url, similarity: e.similarity, type: e.type }];
  });
}
