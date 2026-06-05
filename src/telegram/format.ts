// Telegram-facing text + inline-keyboard renderers.
//
// Pure functions, no DB / no HTTP. Used by:
//   - /today, /domain (list rendering)
//   - /cand (single-candidate detail)
//   - push.ts (digest text + instant-exclusive text)
//
// SPEC §11.3 specifies "temperature and trajectory icons" — using
// Unicode icons since that's the standard Telegram UI vocabulary and
// they survive the OpenAI-compat shim through grammy → Bot API. Keep
// the icon set minimal so the formatting holds at small screen sizes.

import { InlineKeyboard } from 'grammy';

import type { TrendingBoard } from '../scoring/trending.js';

const TEMPERATURE_ICON: Record<string, string> = {
  cold: '❄',
  warm: '☀',
  hot: '🔥',
  over_saturated: '💥',
};

const TRAJECTORY_ICON: Record<string, string> = {
  new: '🆕',
  rising: '↗',
  peaking: '⏫',
  declining: '↘',
};

/** Minimal candidate shape needed for rendering. The bot's loaders project
 *  the candidates row into this. Decouples renderer from drizzle row types. */
export interface RenderCandidate {
  id: string;
  headline: string;
  primaryDomain: string;
  domains: string[];
  temperature: string;
  trajectory: string;
  isExclusive: boolean;
  archiveOverlap: number;
  keywords: string[];
  tags: string[];
  contextSummary?: string;
  curationRationale?: string | null;
  sources?: Array<{ name: string; url: string }>;
}

/** Telegram MarkdownV2 reserves a long list of characters that must be
 *  escaped in text content. Escape conservatively — false positives only
 *  cost a backslash, false negatives crash the send with a 400.
 *  Reference: https://core.telegram.org/bots/api#markdownv2-style */
export function escapeMarkdownV2(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Escape a URL for the `(url)` portion of a MarkdownV2 inline link.
 *  Per the Bot API, inside `(...)` ONLY `)` and `\` are special — running
 *  the full escapeMarkdownV2 here is wrong: a backslash before any other
 *  char (e.g. the `.` in a TLD) is retained literally, corrupting the
 *  destination (`https://www\.nytimes\.com/...`). Escape only `)` and `\`
 *  so a URL containing a paren (e.g. a Wikipedia `..._(disambiguation)`)
 *  can't prematurely close the link either.
 *  Reference: https://core.telegram.org/bots/api#markdownv2-style */
export function escapeMarkdownV2Url(url: string): string {
  return url.replace(/([)\\])/g, '\\$1');
}

/** Below Telegram's hard 4096-char sendMessage limit, with headroom for
 *  invisible MarkdownV2 escape bytes the API may double-count. 3800 is
 *  also what the n8n Summarizer Bot uses, keeping the two surfaces
 *  consistent. */
const MAX_TELEGRAM_TEXT_CHARS = 3800;

/**
 * Split a MarkdownV2-formatted message body so each chunk fits Telegram's
 * sendMessage limit. Prefers paragraph boundaries (`\n\n`) over line
 * boundaries (`\n`) over hard slices — only the first two are safe inside
 * MarkdownV2 (a hard slice CAN break an unclosed `*bold*` span and 400 the
 * send). In practice the call sites (formatTodayList + formatCandidateDetail)
 * always have paragraph breaks between candidate rows / detail sections,
 * so the hard-slice fallback is unreachable for our renderers.
 *
 * Returns `[text]` when no splitting is needed — callers can iterate
 * unconditionally.
 */
export function chunkForTelegram(
  text: string,
  maxLen: number = MAX_TELEGRAM_TEXT_CHARS,
): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let buf = '';
  for (const para of text.split('\n\n')) {
    const candidate = buf ? buf + '\n\n' + para : para;
    if (candidate.length <= maxLen) {
      buf = candidate;
      continue;
    }
    if (buf) {
      chunks.push(buf);
      buf = '';
    }
    if (para.length <= maxLen) {
      buf = para;
      continue;
    }
    // Paragraph itself oversized — split on \n.
    for (const line of para.split('\n')) {
      const lineCandidate = buf ? buf + '\n' + line : line;
      if (lineCandidate.length <= maxLen) {
        buf = lineCandidate;
        continue;
      }
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      if (line.length <= maxLen) {
        buf = line;
        continue;
      }
      // Last resort — hard slice. Will likely 400 if it lands mid-span,
      // but the alternative (silently dropping content) is worse.
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * Build a single-line candidate row for list views. Format:
 *   [icon] [icon] *headline*  — [primary_domain] · /cand <id>
 * Headlines escape MarkdownV2; icons + domain don't need escaping.
 */
export function formatCandidateLine(c: RenderCandidate): string {
  const temp = TEMPERATURE_ICON[c.temperature] ?? '·';
  const traj = TRAJECTORY_ICON[c.trajectory] ?? '·';
  const excl = c.isExclusive ? ' ⚡' : '';
  return `${temp}${traj}${excl} *${escapeMarkdownV2(c.headline)}*\n· ${escapeMarkdownV2(c.primaryDomain)} · /cand ${escapeMarkdownV2(c.id)}`;
}

/**
 * Build the full /cand detail text. Includes context, sources, archive
 * overlap, curation rationale. Caller passes the inline keyboard
 * separately via `candidateKeyboard`.
 */
export function formatCandidateDetail(c: RenderCandidate): string {
  const temp = TEMPERATURE_ICON[c.temperature] ?? '·';
  const traj = TRAJECTORY_ICON[c.trajectory] ?? '·';
  const exclLine = c.isExclusive ? '\n⚡ *EXCLUSIVE*' : '';

  const head = `${temp}${traj} *${escapeMarkdownV2(c.headline)}*${exclLine}\n· ${escapeMarkdownV2(c.primaryDomain)}`;

  const context = c.contextSummary
    ? `\n\n${escapeMarkdownV2(c.contextSummary)}`
    : '';

  const rationale = c.curationRationale
    ? `\n\n_${escapeMarkdownV2(c.curationRationale)}_`
    : '';

  const keywordsLine =
    c.keywords.length === 0
      ? ''
      : `\n\n*Keywords:* ${c.keywords.map(escapeMarkdownV2).join(', ')}`;

  const archiveLine =
    c.archiveOverlap > 0
      ? `\n*Archive overlap:* ${escapeMarkdownV2(c.archiveOverlap.toFixed(2))}`
      : '';

  const sourcesSection =
    !c.sources || c.sources.length === 0
      ? ''
      : `\n\n*Sources:*\n${c.sources
          .map(
            (s) =>
              `· [${escapeMarkdownV2(s.name)}](${escapeMarkdownV2Url(s.url)})`,
          )
          .join('\n')}`;

  return `${head}${context}${rationale}${keywordsLine}${archiveLine}${sourcesSection}`;
}

/**
 * Group candidates by primaryDomain and render as the /today body.
 * Returns empty-state text when the list is empty so callers don't need
 * to special-case zero-candidate runs.
 */
export function formatTodayList(candidates: RenderCandidate[]): string {
  if (candidates.length === 0) {
    return '_No active candidates\\._';
  }
  const byDomain = new Map<string, RenderCandidate[]>();
  for (const c of candidates) {
    const list = byDomain.get(c.primaryDomain) ?? [];
    list.push(c);
    byDomain.set(c.primaryDomain, list);
  }
  const sections: string[] = [];
  for (const [domain, items] of byDomain) {
    // MarkdownV2 reserves `(` and `)` outside link/code contexts —
    // Telegram 400s the whole send if a section header contains a
    // bare paren. Inline-escape since the count is dynamic
    // (escapeMarkdownV2() on the literal would also escape the
    // digits' template, which is fine but more verbose).
    sections.push(
      `*${escapeMarkdownV2(domain)}* \\(${items.length}\\)\n${items.map(formatCandidateLine).join('\n\n')}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * Per-run digest text per SPEC §11.3. Format:
 *   "Morning run complete. 4 new in `economy`, 2 in `geopolitics`,
 *    1 exclusive flagged. /today"
 * `runKind` distinguishes morning/afternoon/manual in the lead phrase.
 */
export function formatDigest(opts: {
  runKind: 'morning' | 'afternoon' | 'manual';
  candidates: Array<{ primaryDomain: string; isExclusive: boolean }>;
  /** Trending board, present on morning runs only — appended below the
   *  summary line. See formatTrendingSection. */
  trending?: TrendingBoard;
}): string {
  const kindLabel = opts.runKind === 'manual' ? 'Manual run' : `${capitalize(opts.runKind)} run`;
  let summary: string;
  if (opts.candidates.length === 0) {
    summary = `${escapeMarkdownV2(kindLabel)} complete\\. No new candidates this run\\.`;
  } else {
    const byDomain = new Map<string, number>();
    let exclusives = 0;
    for (const c of opts.candidates) {
      byDomain.set(c.primaryDomain, (byDomain.get(c.primaryDomain) ?? 0) + 1);
      if (c.isExclusive) exclusives += 1;
    }
    const domainSummary = Array.from(byDomain.entries())
      .map(([d, n]) => `${n} new in \`${escapeMarkdownV2(d)}\``)
      .join(', ');
    const exclusiveLine =
      exclusives === 0
        ? ''
        : `, ${exclusives} exclusive${exclusives === 1 ? '' : 's'} flagged`;
    summary = `${escapeMarkdownV2(kindLabel)} complete\\. ${domainSummary}${exclusiveLine}\\. /today`;
  }
  const board = opts.trending ? formatTrendingSection(opts.trending) : '';
  return board ? `${summary}\n\n${board}` : summary;
}

// Heat ordinal (0..3, matching cold/warm/over_saturated/hot) → icon for
// the trending board, keyed by the mean_heat number the aggregation
// reports (mirrors TEMPERATURE_ICON's vocabulary).
const HEAT_ICON = ['❄', '☀', '💥', '🔥'];

const MAX_TREND_THEMES = 6;
const MAX_TREND_KEYWORDS = 10;

/** Wrap a term in a MarkdownV2 code span. Inside a code span only
 *  backtick + backslash are special, so kebab-case terms (hyphens,
 *  dots) need NO escaping — which is the whole reason the board uses
 *  code spans rather than escapeMarkdownV2 (escaping inside a span
 *  renders the literal backslashes). Strip any backtick/backslash that
 *  would break or leak out of the span. */
function codeSpan(s: string): string {
  return `\`${s.replace(/[`\\]/g, '')}\``;
}

/**
 * Render the trending-board section for the morning digest: top themes
 * (curated tags, the de-noised primary axis) with a heat icon + cluster
 * count + lead domain, then a line of top keywords. Returns '' when the
 * board is empty so formatDigest can omit the section entirely.
 */
export function formatTrendingSection(board: TrendingBoard): string {
  const themeLines = board.themes.slice(0, MAX_TREND_THEMES).map((t) => {
    const icon = HEAT_ICON[Math.round(t.mean_heat)] ?? '·';
    const n = t.cluster_count;
    const domain = t.domains[0];
    const domainPart = domain ? ` · ${codeSpan(domain)}` : '';
    return `${icon} ${codeSpan(t.term)} · ${n} cluster${n === 1 ? '' : 's'}${domainPart}`;
  });
  const keywords = board.keywords.slice(0, MAX_TREND_KEYWORDS);

  const parts: string[] = [];
  if (themeLines.length > 0) parts.push(themeLines.join('\n'));
  if (keywords.length > 0) {
    parts.push(`*Keywords:* ${keywords.map((k) => codeSpan(k.term)).join(' · ')}`);
  }
  if (parts.length === 0) return '';
  return `📈 *Trending now*\n${parts.join('\n')}`;
}

/**
 * Instant push for is_exclusive=true candidates per SPEC §11.3. Pre-pends
 * a ⚡ marker so the user-side notification is unambiguous even before
 * the full text loads.
 *
 * Parameter type narrowed to the three fields actually consumed — keeps
 * callers (orchestrator's `defaultNotifyExclusive`) from hand-building
 * fake RenderCandidate values for unused fields, and prevents the bug
 * class where a future renderer extension reads a placeholder field.
 */
export function formatExclusivePush(
  c: Pick<RenderCandidate, 'id' | 'headline' | 'primaryDomain'>,
): string {
  return `⚡ *Exclusive:* ${escapeMarkdownV2(c.headline)}\n\n${escapeMarkdownV2(c.primaryDomain)} · /cand ${escapeMarkdownV2(c.id)}`;
}

/**
 * Build the 3-button Pick / Pass / Defer inline keyboard for a candidate
 * detail message. Callback data shape `decide:<action>:<candidate-id>`
 * — the bot's callback handler splits on `:`.
 *
 * Defer doesn't take a reason via button (it always defers without a
 * reason); /pick and /pass with reasons require the slash-command form.
 */
export function candidateKeyboard(candidateId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✓ Pick', `decide:pick:${candidateId}`)
    .text('✗ Pass', `decide:pass:${candidateId}`)
    .text('↪ Defer', `decide:defer:${candidateId}`);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
