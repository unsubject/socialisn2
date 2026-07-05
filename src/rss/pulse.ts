// Daily Pulse — the attention-budgeted feed (redesign P0.3,
// docs/redesign/2026-07-05-ideation-redesign.md §5.1).
//
// The candidate pool is deliberately generous (everything above the
// curation cutoff persists, feeding the weekly brief and MCP search).
// The pulse is the opposite contract: at most PULSE_TOP_N entries per
// run, freshly-minted candidates only, ranked by curation_score — the
// "5 worth your time" surface. Entries are append-only snapshots in
// pulse_entries (migration 019); pulse.xml renders the newest window.
//
// Run-kind gating per interview Q10: morning runs always contribute
// (plus one "waves" entry from the trending board); afternoon and
// manual runs contribute ONLY when they minted an exclusive or a
// hot-and-moving story — otherwise they add nothing, keeping the feed
// thin.

import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Db } from '../db/client.js';
import type { TrendingBoard } from '../scoring/trending.js';

/** Hard per-run cap — the redesign's core attention budget (Q8: 5 per
 *  run, ≤10/day across the two scheduled runs). */
export const PULSE_TOP_N = 5;

export type PulseRunKind = 'morning' | 'afternoon' | 'manual';

/** Snapshot of a freshly-inserted candidate, taken inside the scoring
 *  loop. Superseded (re-qualifying) stories are deliberately absent —
 *  a story pulses once, on first sight. */
export interface PulseCandidate {
  candidateId: string;
  headline: string;
  /** Curate-stage rationale (1-2 sentences) — the P0 angle line. P1
   *  upgrades this to a pitched hook. */
  curationRationale: string;
  primaryDomain: string;
  curationScore: number;
  temperature: string;
  trajectory: string;
  isExclusive: boolean;
}

export interface PulseInput {
  runId: string;
  runKind: PulseRunKind;
  candidates: PulseCandidate[];
  /** Morning trending board; renders as one 'waves' entry. */
  trending?: TrendingBoard;
}

/**
 * Pure selection: which of this run's fresh candidates enter the pulse,
 * in rank order. Empty array on a gated-out afternoon/manual run.
 */
export function selectPulseCandidates(
  candidates: PulseCandidate[],
  runKind: PulseRunKind,
): PulseCandidate[] {
  if (runKind !== 'morning') {
    const hasExclusive = candidates.some((c) => c.isExclusive);
    const hasHotMover = candidates.some(
      (c) => c.temperature === 'hot' && (c.trajectory === 'rising' || c.trajectory === 'new'),
    );
    if (!hasExclusive && !hasHotMover) return [];
  }
  return [...candidates]
    .sort((a, b) => b.curationScore - a.curationScore)
    .slice(0, PULSE_TOP_N);
}

/** One-line description for a pulse candidate entry. Kept plain-text —
 *  RSS <description>; the reader's typography does the rest. */
export function pulseCandidateDescription(c: PulseCandidate): string {
  const rationale = c.curationRationale.trim();
  const meta = [
    c.primaryDomain,
    `score ${Math.round(c.curationScore)}`,
    c.trajectory,
    ...(c.isExclusive ? ['exclusive'] : []),
  ].join(' · ');
  return rationale ? `↳ ${rationale}\n${meta}` : meta;
}

/** Render the morning trending board as one waves-entry description.
 *  Mirrors the Telegram board's shape (themes then keywords) without
 *  MarkdownV2 escaping. */
export function wavesDescription(board: TrendingBoard): string {
  const themes = board.themes
    .slice(0, 6)
    .map((t) => `${t.term} · ${t.cluster_count} clusters · ${t.domains[0] ?? ''}`.trim());
  const keywords = board.keywords.slice(0, 10).map((k) => k.term);
  const parts: string[] = [];
  if (themes.length > 0) parts.push(themes.join('\n'));
  if (keywords.length > 0) parts.push(`Keywords: ${keywords.join(' · ')}`);
  return parts.join('\n\n');
}

/**
 * Persist this run's pulse entries (candidate rows + optional morning
 * waves row). Append-only; call BEFORE feed regeneration so the
 * freshly-written pulse.xml includes them.
 */
export async function persistPulse(db: Db, input: PulseInput): Promise<void> {
  const selected = selectPulseCandidates(input.candidates, input.runKind);
  for (const [i, c] of selected.entries()) {
    await db.execute(sql`
      INSERT INTO pulse_entries (id, run_id, kind, candidate_id, rank, title, description)
      VALUES (
        ${uuidv7()}, ${input.runId}, 'candidate', ${c.candidateId},
        ${i + 1}, ${c.headline}, ${pulseCandidateDescription(c)}
      )
    `);
  }
  if (
    input.runKind === 'morning' &&
    input.trending &&
    (input.trending.themes.length > 0 || input.trending.keywords.length > 0)
  ) {
    const dateLabel = new Date().toISOString().slice(0, 10);
    await db.execute(sql`
      INSERT INTO pulse_entries (id, run_id, kind, candidate_id, rank, title, description)
      VALUES (
        ${uuidv7()}, ${input.runId}, 'waves', NULL, NULL,
        ${`Waves — ${dateLabel}`}, ${wavesDescription(input.trending)}
      )
    `);
  }
}
