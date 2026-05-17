# ADR-008: Headline language for candidates

- **Status:** accepted
- **Date:** 2026-05-16
- **Resolves:** SPEC §19 Open Q6

## Context

Socialisn2 surfaces clusters as `candidates` (SPEC §9) for Simon to
review via the Telegram bot, RSS feeds, and the MCP `list_candidates`
tool. Each candidate carries a `headline` field — the short human-
readable string Simon scans to decide pick/pass/defer.

SPEC §19 Q6 is the open question of what language that headline is
written in:

- **Source-language:** keep the headline in whatever language the source
  published in. An English article from The Atlantic stays English; a
  Traditional Chinese piece from 端傳媒 stays 繁體中文; a Japanese piece
  from 日経 stays 日本語.
- **Translate to English:** the curate stage (Sonnet) translates every
  non-English headline into English so the candidate stream is
  monolingual to Simon.
- **Translate to Traditional Chinese:** Simon's audience reads zh-Hant;
  translating headlines to zh-Hant brings them closer to the eventual
  output form.

The normalisation stage (SPEC §7.3) already produces `summary_en` — a
short English summary of the underlying item — so an English-only
normalisation surface exists regardless of the headline-language
decision.

## Decision

**v1 keeps headlines in the source's original language.** No
LLM-driven translation pass on the headline. `summary_en` continues to
be the consistent English surface for cluster scoring and downstream
embedding.

The curate prompt (Phase 3 PR 3, `config/prompts/curate.txt`) is
allowed to refine — copy-edit punctuation, drop a clickbait suffix,
rewrite for brevity — but must preserve the headline's source language.

## Rationale

**Why source-language for v1:**

1. **Audience vs. operator distinction.** Candidates are scanned by
   Simon personally, not by the audience. Simon reads English,
   Traditional Chinese, and Japanese fluently. The translation step
   exists to serve the eventual *published* podcast/essay output, not
   the *editorial inbox*.
2. **Information loss in translation is non-trivial.** Newsroom
   headline style is highly compressed and culturally specific —
   wordplay, idioms, and political register routinely fail to round-trip
   even through Sonnet. Source-language preserves the editorial signal
   the headline was crafted to carry; an English back-translation often
   strips it.
3. **Cost.** Every cluster's curate call already pays for a Sonnet pass
   (SPEC §9.4). Forcing that pass to translate every non-English
   headline adds tokens (especially for CJK output) and pushes against
   the SPEC §12 daily cost ceiling. The marginal value is low: Simon
   doesn't need the headline to be English to read it.
4. **`summary_en` already exists.** Anything downstream that needs an
   English handle on the cluster (clustering by embedding,
   archive-overlap query construction, RSS title-fallback for an
   English audience) can use `summary_en`. The headline does not have
   to carry double duty.
5. **Reversibility.** The decision is a prompt-only setting in the
   curate stage. If feedback shows Simon prefers a single-language
   inbox for faster scanning, the change is a one-line prompt edit and
   a single-cluster regression test — not a schema change, not a data
   backfill.

**Why not translate to Chinese in v1 (despite the eventual audience):**

- The candidate stream is editorial, not published. Aligning candidate
  language with audience language is a category mistake at this stage.
- Translating English → zh-Hant in the curate stage adds cost
  symmetrically with English-translation but with the same
  information-loss risk in the opposite direction.
- If we ever build a public-facing list of "stories I'm watching", that
  surface can render `summary_zh_hant` derived separately from the
  curate stage — independent design problem.

## Consequences

- `config/prompts/curate.txt` (Phase 3 PR 3) instructs Sonnet to keep
  the headline in the source language, with copy-edit latitude
  documented above.
- `candidates.headline` (per SPEC §5) carries whatever language the
  underlying source produced. No `headline_lang` column is added in v1;
  the language is determinable from the bytes (a CJK script range
  detection is enough for the Phase 4 PR 1 RSS / PR 2 Telegram
  rendering paths if they ever need to render-format conditionally).
- The RSS feed (SPEC §11.2) shows the source-language headline. The
  `<description>` element uses `summary_en` so an English-only RSS
  consumer still has a readable summary.
- The Telegram bot (SPEC §11.3) shows the source-language headline. A
  hypothetical `/translate <candidate_id>` command is a v1.1
  addition, not v1.
- **Re-evaluation trigger.** Revisit at the Phase 5 PR 4 pilot review
  if Simon's qualitative feedback during the 5-day pilot shows headline
  scanning is a bottleneck (e.g. "I keep skipping Japanese candidates
  because I'm too tired to parse them at 5am"). The change is a curate
  prompt edit; no migration required.

## References

- SPEC §7.3 (normalisation produces `summary_en`)
- SPEC §9.4 (curate stage)
- SPEC §11.2 (RSS surface), §11.3 (Telegram surface), §11.4 (MCP surface)
- SPEC §12 (cost ceiling)
- SPEC §19 Q6 (this question)
- ADR-007 (re-evaluation-trigger pattern)
