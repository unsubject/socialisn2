// Controlled vocabulary for strategic tags per SPEC §9.2 (Stage 4
// cluster summarisation produces 1-3 of these).
//
// MUST stay in sync with the inline list in config/prompts/headline.txt:
// the orchestrator validates every model-returned tag against
// STRATEGIC_TAG_SET, so a drift between prompt and config surfaces as a
// validation failure rather than silently widening the vocabulary.
//
// Add new tags here AND in the prompt's inline list when a recurring
// editorial theme emerges — don't let the model invent tags ad-hoc.

export const STRATEGIC_TAGS = [
  'post-america',
  'energy-transition',
  'china-decoupling',
  'ai-safety',
  'demographic-shift',
  'supply-chain-realignment',
  'climate-policy',
  'labor-markets',
  'monetary-policy',
  'inequality',
  'tech-platforms',
  'biosecurity',
] as const;

export type StrategicTag = (typeof STRATEGIC_TAGS)[number];

/** O(1) membership check used by the Phase 3 PR 4 orchestrator. */
export const STRATEGIC_TAG_SET: ReadonlySet<string> = new Set(STRATEGIC_TAGS);

export function isStrategicTag(tag: string): tag is StrategicTag {
  return STRATEGIC_TAG_SET.has(tag);
}
