// Cross-adapter shape for a parsed item, before dedup + write.
// Adapters (rss, arxiv, youtube, email_bridge) all return this.

export interface RawItemInput {
  // Feed-supplied stable id when present (RSS <guid>, Atom <id>). Falls back
  // to the canonical URL when absent so the (source_id, external_id) unique
  // index keeps doing its job for republishes.
  externalId: string;
  url: string;
  title: string;
  content: string | null;
  author: string | null;
  publishedAt: Date;
  language: string | null;
  rawMeta: Record<string, unknown>;
}
