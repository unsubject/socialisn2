// MCP tool: trending_keywords — a ranked board of themes + keywords
// rising across the in-window candidate pool. Thin wrapper over the
// pure aggregation core in src/scoring/trending.ts; see that file for
// the design rationale (heat-weighted distinct-cluster count, themes
// as the de-noised primary axis).

import type { Db } from '../../db/client.js';
import { computeTrending, type TrendingBoard } from '../../scoring/trending.js';
import { TrendingKeywordsArgs } from '../schemas.js';

export async function trendingKeywords(db: Db, rawArgs: unknown): Promise<TrendingBoard> {
  const args = TrendingKeywordsArgs.parse(rawArgs);
  return computeTrending(db, {
    domain: args.domain,
    limit: args.limit,
    minClusters: args.min_clusters,
  });
}
