// Pick / pass / defer decision module.
//
// Three-step flow, atomic for the candidate's status transition:
//
//   1. UPDATE candidates SET status, decided_at, decision_reason
//      WHERE id = $1 AND status = 'new' RETURNING *
//      → if rowCount == 0, the candidate was already decided (race —
//        e.g., two inline-button taps before the first response renders)
//        and we return alreadyDecided=true WITHOUT writing feedback or
//        firing the MCP call. Idempotent at the contract level.
//
//   2. INSERT feedback (candidate_id, action, reason, interface)
//      Single row per decision. Tied to the FK; the candidate row exists
//      because UPDATE ... RETURNING gave it to us.
//
//   3. recordPick(candidate, decision, reason) — best-effort 2nd-brain
//      MCP call. Already graceful in src/lib/two_brain_client.ts; a
//      failure returns {ok:false} but does NOT block the decision from
//      being recorded locally.
//
// The transaction wraps steps 1+2 so a feedback INSERT failure rolls
// back the candidate status change. Step 3 lives outside the tx because
// it's an external HTTP call — a Telegram-MCP-2ndbrain dependency chain
// inside a DB tx invites long-held locks.

import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../db/client.js';
import {
  recordPick as defaultRecordPick,
  type PickDecision,
} from '../lib/two_brain_client.js';

export type Decision = PickDecision;
type CandidateStatus = 'picked' | 'passed' | 'deferred';

/** Decision → candidate status. Exhaustive switch so adding a new
 *  Decision value without updating this map fails the build instead
 *  of silently routing to the `deferred` branch (which the previous
 *  nested-ternary form did). */
function statusFor(d: Decision): CandidateStatus {
  switch (d) {
    case 'pick':
      return 'picked';
    case 'pass':
      return 'passed';
    case 'defer':
      return 'deferred';
    default: {
      const _exhaustive: never = d;
      throw new Error(`statusFor: unhandled decision ${String(_exhaustive)}`);
    }
  }
}

export interface DecideResult {
  ok: boolean;
  /** True when the candidate had already been decided before this call.
   *  No feedback row was written and no MCP call was made. */
  alreadyDecided?: boolean;
  /** The candidate row as it existed BEFORE this decision — useful for
   *  the bot's reply text. Undefined when alreadyDecided=true. */
  candidate?: DecidedCandidate;
}

export interface DecidedCandidate {
  id: string;
  clusterId: string;
  headline: string;
  contextSummary: string;
  primaryDomain: string;
  keywords: string[];
  tags: string[];
  isExclusive: boolean;
}

export interface DecideDependencies {
  /** Override the 2nd-brain recordPick call for tests. Default uses the
   *  real client which is already graceful (returns ok:false on any
   *  failure). */
  recordPick?: typeof defaultRecordPick;
}

type CandidateRow = {
  id: string;
  cluster_id: string;
  headline: string;
  context_summary: string;
  primary_domain: string;
  keywords: string[];
  tags: string[];
  is_exclusive: boolean;
};

type SourceRow = { url: string };

/**
 * Record a pick / pass / defer decision. See module header for the flow.
 * `interfaceLabel` distinguishes feedback rows by surface (telegram vs
 * mcp) so analysis queries can split per interface.
 */
export async function decide(
  db: Db,
  candidateId: string,
  decision: Decision,
  reason: string | undefined,
  interfaceLabel: 'telegram' | 'mcp',
  deps: DecideDependencies = {},
): Promise<DecideResult> {
  const recordPick = deps.recordPick ?? defaultRecordPick;
  const newStatus = statusFor(decision);

  // Steps 1 + 2 in a single tx — the candidate's status change and the
  // feedback row land together or not at all.
  const candidate = await db.transaction(async (tx) => {
    const rows = await tx.execute<CandidateRow>(sql`
      UPDATE candidates
      SET status          = ${newStatus},
          decided_at      = NOW(),
          decision_reason = ${reason ?? null}
      WHERE id = ${candidateId}
        AND status = 'new'
      RETURNING id, cluster_id, headline, context_summary,
                primary_domain, keywords, tags, is_exclusive
    `);
    const row = rows[0];
    if (!row) {
      // Race: someone else (another inline-button tap, the MCP server,
      // or expiry) already moved the candidate out of 'new'. Don't
      // write feedback — the contract is one feedback row per first
      // decision, and the first decision wrote it.
      return null;
    }
    await tx.execute(sql`
      INSERT INTO feedback (id, candidate_id, action, reason, interface)
      VALUES (${uuidv7()}, ${row.id}, ${decision}, ${reason ?? null}, ${interfaceLabel})
    `);
    return row;
  });

  if (!candidate) {
    return { ok: true, alreadyDecided: true };
  }

  // Step 3 — 2nd-brain MCP. Outside the tx (long external call), best
  // effort. We need the candidate's source URLs to satisfy
  // RecordPickCandidate.urls[]; pull them now via a follow-up query
  // since the in-tx RETURNING didn't include them.
  const sources = await db.execute<SourceRow>(sql`
    SELECT ri.url
    FROM items i
    JOIN raw_items ri ON ri.id = i.raw_item_id
    WHERE i.cluster_id = ${candidate.cluster_id}
    ORDER BY ri.published_at ASC
  `);

  await recordPick(
    {
      headline: candidate.headline,
      context: candidate.context_summary,
      domain: candidate.primary_domain,
      keywords: candidate.keywords,
      tags: candidate.tags,
      urls: sources.map((s) => s.url),
    },
    decision,
    reason,
  );

  return {
    ok: true,
    candidate: {
      id: candidate.id,
      clusterId: candidate.cluster_id,
      headline: candidate.headline,
      contextSummary: candidate.context_summary,
      primaryDomain: candidate.primary_domain,
      keywords: candidate.keywords,
      tags: candidate.tags,
      isExclusive: candidate.is_exclusive,
    },
  };
}
