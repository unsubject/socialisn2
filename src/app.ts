// Fastify entry per SPEC §4.2 + §16. Exposes:
//
//   GET /healthz   — liveness probe (no DB roundtrip)
//   GET /c/:id     — candidate detail HTML page (SPEC §11.2 link target)
//
// The Phase 4 PR 3 MCP server and the Phase 4 PR 2 Telegram bot add
// their own surfaces — those are independent Node processes / Fastify
// plugins. This module is intentionally small: one route, one helper.
//
// `buildApp(db)` returns the Fastify instance without listening, so
// tests can use `app.inject({ method, url })` to exercise routes
// without a TCP port. `src/index.ts` is the deployment entry — imports
// `buildApp` and calls `app.listen()`.

import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

import type { Db } from './db/client.js';
import { renderDetail, renderNotFound } from './rss/render-detail.js';

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

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({
    // Disable Fastify's default JSON-line logger — workers in this repo
    // log via console.* and we want a single log shape per process. Ops
    // can flip the env if structured logs are wanted.
    logger: process.env.FASTIFY_LOGGER === '1',
    // Keep error responses terse — the default JSON is fine but we
    // override /c/:id to render HTML on 404.
    disableRequestLogging: true,
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get<{ Params: { id: string } }>('/c/:id', async (req, reply) => {
    const id = req.params.id;

    // Loose UUID shape check — rejects obviously bogus paths before
    // hitting the DB. The schema-level WHERE id=$1 still catches
    // non-existent valid UUIDs; this is just a cheap pre-filter that
    // avoids a round trip on /c/foo.
    if (!/^[0-9a-fA-F-]{8,}$/.test(id)) {
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
