// MCP tools backing the Candidate-shaped surface of SPEC §11.4:
//   - list_candidates (filtered list)
//   - get_candidate (single, with full detail)
//   - search_candidates (semantic via query embedding)

import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { recordCost } from '../../cost/ledger.js';
import { embed as defaultEmbed } from '../../lib/embeddings.js';
import {
  GetCandidateArgs,
  ListCandidatesArgs,
  SearchCandidatesArgs,
} from '../schemas.js';

const CONTEXT_PREVIEW_CHARS = 80;

/** Wire shape per SPEC §11.4. */
export interface Candidate {
  id: string;
  headline: string;
  primary_domain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  is_exclusive: boolean;
  similarity_score: number;
  archive_overlap: number;
  curation_score: number;
  keywords: string[];
  tags: string[];
  context_preview: string;
  created_at: string;
}

export interface CandidateDetail extends Candidate {
  context_summary: string;
  curation_rationale: string | null;
  archive_overlap_links: unknown;
  sources: Array<{ name: string; url: string; published_at: string }>;
  exclusive_source?: { id: string; name: string; url: string; published_at: string };
}

type CandidateRow = {
  id: string;
  headline: string;
  primary_domain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  is_exclusive: boolean;
  similarity_score: number;
  archive_overlap: number;
  curation_score: number;
  keywords: string[];
  tags: string[];
  context_summary: string;
  created_at: string;
};

type CandidateDetailRow = CandidateRow & {
  cluster_id: string;
  curation_rationale: string | null;
  archive_overlap_links: unknown;
  exclusive_source_id: string | null;
};

type SourceRow = { id: string; name: string; url: string; published_at: string };

function rowToCandidate(r: CandidateRow): Candidate {
  return {
    id: r.id,
    headline: r.headline,
    primary_domain: r.primary_domain,
    domains: r.domains,
    temperature: r.temperature,
    trajectory: r.trajectory,
    is_exclusive: r.is_exclusive,
    similarity_score: r.similarity_score,
    archive_overlap: r.archive_overlap,
    curation_score: r.curation_score,
    keywords: r.keywords,
    tags: r.tags,
    context_preview: r.context_summary.slice(0, CONTEXT_PREVIEW_CHARS),
    created_at: new Date(r.created_at).toISOString(),
  };
}

export async function listCandidates(
  db: Db,
  rawArgs: unknown,
): Promise<{ candidates: Candidate[] }> {
  const args = ListCandidatesArgs.parse(rawArgs);
  // Build the WHERE incrementally — drizzle's sql.join makes this cheap
  // and parametrised. Status always present (defaults to 'new'); the
  // other three are optional filters.
  const whereParts = [sql`status = ${args.status}`];
  if (args.status === 'new') {
    // Active filter only meaningful for 'new'. Other statuses (picked /
    // passed / deferred / expired) intentionally ignore expires_at —
    // historical decisions stay queryable.
    whereParts.push(sql`expires_at > NOW()`);
  }
  if (args.domain) whereParts.push(sql`primary_domain = ${args.domain}`);
  if (args.temperature) whereParts.push(sql`temperature = ${args.temperature}`);
  if (args.trajectory) whereParts.push(sql`trajectory = ${args.trajectory}`);
  const whereSql = sql.join(whereParts, sql` AND `);
  const rows = await db.execute<CandidateRow>(sql`
    SELECT id, headline, primary_domain, domains,
           temperature, trajectory, is_exclusive,
           similarity_score, archive_overlap, curation_score,
           keywords, tags, context_summary, created_at
    FROM candidates
    WHERE ${whereSql}
    ORDER BY created_at DESC
    LIMIT ${args.limit}
  `);
  return { candidates: rows.map(rowToCandidate) };
}

export async function getCandidate(
  db: Db,
  rawArgs: unknown,
): Promise<{ candidate: CandidateDetail }> {
  const args = GetCandidateArgs.parse(rawArgs);
  const rows = await db.execute<CandidateDetailRow>(sql`
    SELECT id, cluster_id, headline, context_summary, primary_domain, domains,
           temperature, trajectory, is_exclusive, exclusive_source_id,
           similarity_score, archive_overlap, archive_overlap_links,
           curation_score, curation_rationale, keywords, tags, created_at
    FROM candidates
    WHERE id = ${args.id}
    LIMIT 1
  `);
  const row = rows[0];
  // Throw on missing — server.ts's call-tool wrapper catches and sets
  // isError:true so MCP clients can distinguish "not found" from a
  // valid "found and here's the data". Returning {error} inline would
  // serialize into a success-shaped content block with no isError flag.
  if (!row) throw new Error(`no candidate ${args.id}`);

  const sources = await db.execute<SourceRow>(sql`
    SELECT s.id, s.name, ri.url, ri.published_at
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    JOIN sources s    ON s.id  = ri.source_id
    WHERE i.cluster_id = ${row.cluster_id}
    ORDER BY ri.published_at ASC
  `);

  let exclusiveSource: CandidateDetail['exclusive_source'];
  if (row.exclusive_source_id) {
    const match = sources.find((s) => s.id === row.exclusive_source_id);
    if (match) {
      exclusiveSource = {
        id: match.id,
        name: match.name,
        url: match.url,
        published_at: new Date(match.published_at).toISOString(),
      };
    }
  }

  return {
    candidate: {
      ...rowToCandidate(row),
      context_summary: row.context_summary,
      curation_rationale: row.curation_rationale,
      archive_overlap_links: row.archive_overlap_links,
      sources: sources.map((s) => ({
        name: s.name,
        url: s.url,
        published_at: new Date(s.published_at).toISOString(),
      })),
      ...(exclusiveSource ? { exclusive_source: exclusiveSource } : {}),
    },
  };
}

export interface SearchDeps {
  embed?: typeof defaultEmbed;
}

export async function searchCandidates(
  db: Db,
  rawArgs: unknown,
  deps: SearchDeps = {},
): Promise<{ candidates: Candidate[] }> {
  const args = SearchCandidatesArgs.parse(rawArgs);
  const embed = deps.embed ?? defaultEmbed;

  // Embed the query. recordCost ledgers the spend so /status surfaces
  // it; deliberately NOT gated by the daily cost ceiling (user-
  // initiated search shouldn't be blocked when the scoring pipeline
  // is bursty — the ceiling is for autonomous pipeline cost, not
  // human-in-the-loop tools).
  const embedded = await embed({ inputs: [args.query] });
  const vector = embedded.vectors[0];
  if (!vector) {
    return { candidates: [] };
  }
  await recordCost(db, {
    model: 'text-embedding-3-small',
    inputTokens: embedded.inputTokens,
    outputTokens: 0,
    usd: embedded.usd,
    stage: 'mcp_search',
  });

  // pgvector cosine — rank candidates by similarity of THEIR cluster's
  // centroid to the query embedding. (Candidates don't have their own
  // embedding column; the cluster centroid is the editorial unit.)
  // Filter to active candidates (status='new', not expired) — past
  // decisions live in feedback, not the search surface.
  const vecLit = `[${vector.join(',')}]`;
  const rows = await db.execute<CandidateRow>(sql`
    SELECT c.id, c.headline, c.primary_domain, c.domains,
           c.temperature, c.trajectory, c.is_exclusive,
           c.similarity_score, c.archive_overlap, c.curation_score,
           c.keywords, c.tags, c.context_summary, c.created_at
    FROM candidates c
    JOIN clusters cl ON cl.id = c.cluster_id
    WHERE c.status = 'new'
      AND c.expires_at > NOW()
    ORDER BY cl.centroid <=> ${vecLit}::vector(1536) ASC
    LIMIT ${args.limit}
  `);
  return { candidates: rows.map(rowToCandidate) };
}
